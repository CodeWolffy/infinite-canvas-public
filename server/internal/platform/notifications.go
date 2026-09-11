package platform

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type MailConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Mode     string `json:"mode"`
	Username string `json:"username"`
	Password string `json:"password"`
	From     string `json:"from"`
	Enabled  bool   `json:"enabled"`
}

func (a *App) mailConfig(ctx context.Context, q querier) (MailConfig, error) {
	var sealed string
	err := q.QueryRow(ctx, "SELECT value->>'sealed' FROM app_settings WHERE key='mail'").Scan(&sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return MailConfig{}, nil
	}
	if err != nil {
		return MailConfig{}, err
	}
	plain, err := a.unseal(sealed)
	if err != nil {
		return MailConfig{}, err
	}
	var config MailConfig
	err = json.Unmarshal([]byte(plain), &config)
	return config, err
}

func emailAddress(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	address, err := mail.ParseAddress(value)
	if err != nil || address.Address != value {
		return "", problem(400, "invalid_email", "请输入有效的邮箱地址")
	}
	return value, nil
}

func (a *App) queueMail(ctx context.Context, q querier, to, subject, body string) error {
	sealed, err := a.seal(string(jsonBytes(Row{"to": to, "subject": subject, "body": body})))
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, "INSERT INTO mail_outbox(encrypted_message) VALUES($1)", sealed)
	return err
}

func (a *App) notification(ctx context.Context, q querier, userID, eventKey, kind, title, content string) error {
	result, err := q.Exec(ctx, "INSERT INTO notifications(user_id,event_key,kind,title,content) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_key) DO NOTHING", nullable(userID), eventKey, kind, title, content)
	if err != nil || result.RowsAffected() == 0 {
		return err
	}
	config, err := a.mailConfig(ctx, q)
	if err != nil || !config.Enabled {
		return nil
	}
	users, err := rows(ctx, q, "SELECT email FROM users WHERE status='active' AND email_verified_at IS NOT NULL AND (($1='' AND role='admin') OR id::text=$1)", userID)
	if err != nil {
		return err
	}
	for _, u := range users {
		if err = a.queueMail(ctx, q, str(u["email"]), title, content); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) notificationRoutes(api, admin *gin.RouterGroup) {
	api.GET("/user/notifications", respond(func(c *gin.Context) (any, error) {
		u := currentUser(c)
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT n.*,r.user_id IS NOT NULL AS read FROM notifications n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=$1 WHERE n.user_id=$1 OR (n.user_id IS NULL AND $2) ORDER BY n.created_at DESC,n.id LIMIT $3 OFFSET $4", u.ID, u.Role == "admin", limit, offset)
		return gin.H{"notifications": items}, err
	}))
	api.POST("/user/notifications/:id/read", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		u := currentUser(c)
		_, err = a.DB.Exec(c.Request.Context(), "INSERT INTO notification_reads(notification_id,user_id) SELECT id,$2 FROM notifications WHERE id=$1 AND (user_id=$2 OR (user_id IS NULL AND $3)) ON CONFLICT DO NOTHING", id, u.ID, u.Role == "admin")
		return nil, err
	}))
	admin.GET("/mail-settings", respond(func(c *gin.Context) (any, error) {
		config, err := a.mailConfig(c.Request.Context(), a.DB)
		configured := config.Password != ""
		config.Password = ""
		return gin.H{"settings": config, "passwordConfigured": configured}, err
	}))
	admin.PUT("/mail-settings", respond(func(c *gin.Context) (any, error) {
		input, err := body[MailConfig](c)
		if err != nil {
			return nil, err
		}
		if input.Host != "" {
			if strings.ContainsAny(input.Host, "/\r\n ") || input.Port < 1 || input.Port > 65535 || (input.Mode != "tls" && input.Mode != "starttls") {
				return nil, problem(400, "invalid_mail_config", "请填写 SMTP 主机、有效端口和加密方式")
			}
			input.From, err = emailAddress(input.From)
			if err != nil {
				return nil, err
			}
		}
		if input.Enabled && input.Host == "" {
			return nil, problem(400, "invalid_mail_config", "启用邮件前请完成 SMTP 配置")
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			old, err := a.mailConfig(ctx, tx)
			if err != nil {
				return err
			}
			if input.Password == "" {
				input.Password = old.Password
			}
			sealed, err := a.seal(string(jsonBytes(input)))
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO app_settings(key,value) VALUES('mail',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", jsonBytes(Row{"sealed": sealed})); err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "mail.settings", "mail", Row{"host": input.Host, "enabled": input.Enabled})
		})
		return nil, err
	}))
	admin.GET("/mail-deliveries", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,status,created_at,finished_at FROM mail_outbox ORDER BY created_at DESC,id LIMIT $1 OFFSET $2", limit, offset)
		return gin.H{"deliveries": items}, err
	}))
}

func sendMail(ctx context.Context, config MailConfig, message Row) error {
	address := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		return err
	}
	defer conn.Close()
	rawConn := conn
	stop := context.AfterFunc(ctx, func() { _ = rawConn.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	tlsConfig := &tls.Config{ServerName: config.Host, MinVersion: tls.VersionTLS12}
	if config.Mode == "tls" {
		secured := tls.Client(conn, tlsConfig)
		if err = secured.HandshakeContext(ctx); err != nil {
			return err
		}
		conn = secured
	}
	client, err := smtp.NewClient(conn, config.Host)
	if err != nil {
		return err
	}
	defer client.Close()
	if config.Mode == "starttls" {
		if err = client.StartTLS(tlsConfig); err != nil {
			return err
		}
	}
	if config.Username != "" {
		if err = client.Auth(smtp.PlainAuth("", config.Username, config.Password, config.Host)); err != nil {
			return err
		}
	}
	if err = client.Mail(config.From); err != nil {
		return err
	}
	if err = client.Rcpt(str(message["to"])); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(writer, "From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n", config.From, str(message["to"]), mime.QEncoding.Encode("UTF-8", str(message["subject"])), str(message["body"]))
	if err != nil {
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func (a *App) deliverMail(ctx context.Context) {
	_, _ = a.DB.Exec(ctx, "UPDATE mail_outbox SET status='failed',finished_at=now() WHERE status='sending' AND deadline<now()")
	config, err := a.mailConfig(ctx, a.DB)
	if err != nil || !config.Enabled {
		return
	}
	item, err := one(ctx, a.DB, "UPDATE mail_outbox SET status='sending',deadline=now()+($1*interval '1 millisecond') WHERE id=(SELECT id FROM mail_outbox WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,encrypted_message", a.Config.HeaderTimeout.Milliseconds())
	if err != nil {
		return
	}
	plain, err := a.unseal(str(item["encryptedMessage"]))
	var message Row
	if err == nil {
		err = json.Unmarshal([]byte(plain), &message)
	}
	if err == nil {
		sendCtx, cancel := context.WithTimeout(ctx, a.Config.HeaderTimeout)
		err = sendMail(sendCtx, config, message)
		cancel()
	}
	status := "sent"
	if err != nil {
		status = "failed"
	}
	_, _ = a.DB.Exec(context.Background(), "UPDATE mail_outbox SET status=$2,finished_at=now() WHERE id=$1 AND status='sending'", item["id"], status)
	if err != nil {
		_, _ = a.DB.Exec(context.Background(), "INSERT INTO notifications(event_key,kind,title,content) VALUES($1,'mail.failed','邮件发送失败','请检查 SMTP 配置和邮件投递记录。原站内通知仍保留，未自动重复发送。') ON CONFLICT(event_key) DO NOTHING", "mail:"+str(item["id"]))
	}
}

func (a *App) startMail(ctx context.Context) {
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		ticker := time.NewTicker(queuePoll)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.deliverMail(ctx)
			}
		}
	}()
}

func randomToken() (string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
