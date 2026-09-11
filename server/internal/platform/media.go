package platform

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gabriel-vasile/mimetype"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
	_ "golang.org/x/image/webp"
)

var restrictedPrefixes = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("240.0.0.0/4")}

func publicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, prefix := range restrictedPrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

var publicClient = makeSafeClient(false)
var privateClient = makeSafeClient(true)

func safeClient(allowPrivate bool) *http.Client {
	if allowPrivate {
		return privateClient
	}
	return publicClient
}
func makeSafeClient(allowPrivate bool) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, errors.New("主机未解析")
		}
		for _, ip := range ips {
			if !allowPrivate && !publicIP(ip) {
				return nil, errors.New("禁止访问内网或保留地址")
			}
		}
		var last error
		for _, ip := range ips {
			connection, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return connection, nil
			}
			last = err
		}
		return nil, last
	}
	return &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("过多跳转")
		}
		if req.URL.Scheme != "https" && req.URL.Scheme != "http" || req.URL.User != nil {
			return errors.New("不支持的跳转地址")
		}
		if len(via) > 0 && (via[0].Header.Get("Authorization") != "" || via[0].Header.Get("x-goog-api-key") != "" || via[0].URL.RawQuery != "") {
			return http.ErrUseLastResponse
		}
		return nil
	}}
}

var supportedMedia = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/x-flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "application/ogg": "ogg"}

func (a *App) storeMedia(ctx context.Context, userID string, data []byte, name string) (Row, error) {
	if int64(len(data)) > a.Config.MaxGenerated {
		return nil, problem(413, "file_too_large", "文件超过平台大小限制")
	}
	detected := mimetype.Detect(data)
	mediaType := strings.Split(detected.String(), ";")[0]
	extension, ok := supportedMedia[mediaType]
	if !ok {
		return nil, problem(415, "unsupported_media_type", "不支持此文件格式")
	}
	var width, height *int
	if strings.HasPrefix(mediaType, "image/") {
		cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			return nil, problem(415, "invalid_image", "无法解码此图片")
		}
		width = &cfg.Width
		height = &cfg.Height
	}
	id := uuid.NewString()
	key := fmt.Sprintf("users/%s/%s/%s.%s", userID, time.Now().Format("2006/01"), id, extension)
	sum := sha256.Sum256(data)
	if name == "" {
		name = id + "." + extension
	}
	if len([]rune(name)) > 255 {
		name = string([]rune(name)[:255])
	}
	var row Row
	err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if err := lockStorage(ctx, tx, userID); err != nil {
			return err
		}
		if err := a.enforceStorageQuota(ctx, tx, userID, int64(len(data))); err != nil {
			return err
		}
		var err error
		row, err = one(ctx, tx, "INSERT INTO media_objects(id,owner_id,object_key,original_name,mime_type,byte_size,width,height,sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'deleting') RETURNING *", id, userID, key, name, mediaType, len(data), width, height, hex.EncodeToString(sum[:]))
		return err
	})
	if err != nil {
		return nil, err
	}
	if _, err = a.S3.PutObject(ctx, a.Config.Bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: mediaType}); err != nil {
		return nil, err
	}
	if _, err = a.DB.Exec(ctx, "UPDATE media_objects SET status='ready' WHERE id=$1", id); err != nil {
		return nil, err
	}
	row["status"] = "ready"
	return row, nil
}
func publicMedia(row Row) Row {
	return Row{"id": row["id"], "url": "/api/media/" + str(row["id"]), "mimeType": row["mimeType"], "byteSize": row["byteSize"], "bytes": row["byteSize"], "width": row["width"], "height": row["height"], "originalName": row["originalName"], "createdAt": row["createdAt"]}
}

const mediaVisibility = "(m.owner_id=$2::uuid OR $3::boolean OR EXISTS(SELECT 1 FROM assets a WHERE a.media_id=m.id AND (a.scope='public' OR a.owner_id=$2::uuid)) OR EXISTS(SELECT 1 FROM media_references mr WHERE mr.media_id=m.id AND mr.user_id=$2::uuid))"

func readableMedia(ctx context.Context, q querier, id, userID string, admin bool) (Row, error) {
	return one(ctx, q, "SELECT m.* FROM media_objects m WHERE m.id=$1 AND m.status='ready' AND "+mediaVisibility, id, userID, admin)
}
func (a *App) readMedia(ctx context.Context, row Row) ([]byte, error) {
	obj, err := a.S3.GetObject(ctx, a.Config.Bucket, str(row["objectKey"]), minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	data, err := io.ReadAll(io.LimitReader(obj, a.Config.MaxUpload+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > a.Config.MaxUpload {
		return nil, problem(413, "file_too_large", "参考文件超过限制")
	}
	return data, nil
}
func (a *App) download(ctx context.Context, address string, headers http.Header) ([]byte, error) {
	u, err := url.Parse(address)
	if err != nil || u.Host == "" || u.User != nil || u.Scheme != "https" && u.Scheme != "http" {
		return nil, errors.New("无效的媒体地址")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return nil, err
	}
	req.Header = headers
	response, err := safeClient(a.Config.AllowPrivateHosts).Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, errors.New("获取生成文件失败")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, a.Config.MaxGenerated+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > a.Config.MaxGenerated {
		return nil, errors.New("生成文件超过平台大小限制")
	}
	return data, nil
}

var mediaURLPattern = regexp.MustCompile(`/api/media/([0-9a-fA-F-]{36})`)

func extractMediaIDs(v any) []string {
	set := map[string]bool{}
	var visit func(any, string)
	add := func(s string) {
		id, err := uuid.Parse(s)
		if err == nil {
			set[id.String()] = true
		}
	}
	visit = func(v any, key string) {
		switch x := v.(type) {
		case string:
			if key == "mediaId" || key == "fileId" || key == "mediaIds" || key == "fileIds" {
				add(x)
			}
			if key == "storageKey" {
				add(strings.TrimPrefix(strings.TrimPrefix(x, "image:"), "media:"))
			}
			for _, match := range mediaURLPattern.FindAllStringSubmatch(x, -1) {
				add(match[1])
			}
		case []any:
			for _, item := range x {
				visit(item, key)
			}
		case map[string]any:
			for k, item := range x {
				visit(item, k)
			}
		}
	}
	visit(v, "")
	ids := make([]string, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
func syncMediaRefs(ctx context.Context, tx pgx.Tx, kind, ownerID, userID string, ids []string) error {
	unique := map[string]bool{}
	ordered := []string{}
	for _, id := range ids {
		parsed, err := uuid.Parse(id)
		if err != nil {
			return problem(400, "invalid_media", "文件编号不正确")
		}
		canonical := parsed.String()
		if !unique[canonical] {
			unique[canonical] = true
			ordered = append(ordered, canonical)
		}
	}
	locking := append([]string{}, ordered...)
	sort.Strings(locking)
	for _, id := range locking {
		if _, err := one(ctx, tx, "SELECT m.id FROM media_objects m WHERE m.id=$1 AND m.status='ready' AND "+mediaVisibility+" FOR SHARE OF m", id, userID, false); err != nil {
			return problem(400, "invalid_media", "包含无权访问或不可用的文件")
		}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM media_references WHERE owner_kind=$1 AND owner_id=$2", kind, ownerID); err != nil {
		return err
	}
	for position, id := range ordered {
		if _, err := tx.Exec(ctx, "INSERT INTO media_references(owner_kind,owner_id,user_id,media_id,position) VALUES($1,$2,$3,$4,$5)", kind, ownerID, userID, id, position); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) mediaRoutes(api *gin.RouterGroup) {
	api.GET("/media/stats", respond(func(c *gin.Context) (any, error) {
		ctx, u := c.Request.Context(), currentUser(c)
		row, err := one(ctx, a.DB, "SELECT count(*)::int AS total_count,coalesce(sum(byte_size),0)::bigint AS total_bytes FROM media_objects WHERE owner_id=$1 AND status='ready'", u.ID)
		if err != nil {
			return nil, err
		}
		_, quota, err := storageQuotaView(ctx, a.DB, u.ID)
		if err != nil {
			return nil, err
		}
		row["quotaBytes"] = quota
		return row, nil
	}))
	api.POST("/media", respond(func(c *gin.Context) (any, error) {
		reader, err := c.Request.MultipartReader()
		if err != nil {
			return nil, problem(400, "file_required", "请选择文件")
		}
		part, err := reader.NextPart()
		if err != nil || part.FileName() == "" {
			return nil, problem(400, "file_required", "请选择文件")
		}
		defer part.Close()
		data, err := io.ReadAll(io.LimitReader(part, a.Config.MaxUpload+1))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > a.Config.MaxUpload {
			return nil, problem(413, "file_too_large", "文件超过上传大小限制")
		}
		row, err := a.storeMedia(c.Request.Context(), currentUser(c).ID, data, path.Base(part.FileName()))
		if err != nil {
			return nil, err
		}
		return gin.H{"media": publicMedia(row)}, nil
	}))
	api.GET("/media/:id", func(c *gin.Context) {
		id, err := idParam(c, "id")
		if err != nil {
			fail(c, err)
			return
		}
		u := currentUser(c)
		ctx := c.Request.Context()
		row, err := readableMedia(ctx, a.DB, id, u.ID, u.Role == "admin")
		if err != nil {
			fail(c, err)
			return
		}
		etag := `"` + str(row["sha256"]) + `"`
		c.Header("ETag", etag)
		c.Header("Cache-Control", "private, no-cache")
		c.Header("Vary", "Origin, Cookie")
		if c.GetHeader("If-None-Match") == etag {
			c.Status(304)
			return
		}
		object, err := a.S3.GetObject(ctx, a.Config.Bucket, str(row["objectKey"]), minio.GetObjectOptions{})
		if err != nil {
			fail(c, err)
			return
		}
		defer object.Close()
		if _, err = object.Stat(); err != nil {
			fail(c, err)
			return
		}
		c.Header("Content-Type", str(row["mimeType"]))
		c.Header("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": str(row["originalName"])}))
		http.ServeContent(c.Writer, c.Request, str(row["originalName"]), row["createdAt"].(time.Time), object)
	})
	api.DELETE("/media/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		u := currentUser(c)
		ctx := c.Request.Context()
		var key string
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			row, err := one(ctx, tx, "SELECT * FROM media_objects WHERE id=$1 AND (owner_id=$2 OR $3) FOR UPDATE", id, u.ID, u.Role == "admin")
			if err != nil {
				return err
			}
			var referenced bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM media_references WHERE media_id=$1) OR EXISTS(SELECT 1 FROM generation_tasks WHERE output_media_id=$1) OR EXISTS(SELECT 1 FROM assets WHERE media_id=$1)", id).Scan(&referenced); err != nil {
				return err
			}
			if referenced {
				return problem(409, "in_use", "文件仍被画布、素材或生成记录引用")
			}
			key = str(row["objectKey"])
			_, err = tx.Exec(ctx, "UPDATE media_objects SET status='deleting' WHERE id=$1", id)
			return err
		})
		if err != nil {
			return nil, err
		}
		if err = a.S3.RemoveObject(ctx, a.Config.Bucket, key, minio.RemoveObjectOptions{}); err != nil {
			return nil, err
		}
		_, err = a.DB.Exec(ctx, "DELETE FROM media_objects WHERE id=$1 AND status='deleting'", id)
		return nil, err
	}))
}
