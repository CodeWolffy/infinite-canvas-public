package platform

import (
	"context"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 未通过审核的用户消息永远不作为后续对话上下文发送给上游。
const approvedMessage = `NOT EXISTS(SELECT 1 FROM generation_tasks mt JOIN moderation_reviews mr ON mr.id=mt.moderation_id WHERE mt.request_message_id=m.id AND mr.status<>'approved')`

type sensitiveDecision struct {
	Action string
	Matches []Row
}

func sensitiveInput(prompt string, params map[string]any) string {
	var text strings.Builder
	text.WriteString(prompt)
	var appendValue func(any)
	appendValue = func(value any) {
		switch value := value.(type) {
		case string:
			text.WriteString("\n" + value)
		case map[string]any:
			for _, item := range value {
				appendValue(item)
			}
		case []any:
			for _, item := range value {
				appendValue(item)
			}
		}
	}
	appendValue(params)
	return text.String()
}

func (a *App) newModeration(ctx context.Context, tx pgx.Tx, userID string, decision sensitiveDecision, request Row) (any, string, error) {
	if decision.Action != "review" {
		return nil, "queued", nil
	}
	id := uuid.NewString()
	if _, err := tx.Exec(ctx, "INSERT INTO moderation_reviews(id,user_id,matches,request_snapshot) VALUES($1,$2,$3,$4)", id, userID, jsonBytes(decision.Matches), jsonBytes(request)); err != nil {
		return nil, "", err
	}
	err := a.notification(ctx, tx, "", "moderation:"+id, "moderation.pending", "有内容等待审核", "新的生成请求命中待审核规则，请在敏感词页面查看。")
	return id, "reviewing", err
}

func (a *App) moderationRoutes(admin *gin.RouterGroup) {
	admin.GET("/moderation", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		items, err := rows(c.Request.Context(), a.DB, `SELECT r.*,u.username,reviewer.username AS reviewer_name,
			(SELECT coalesce(sum(price_micros),0) FROM generation_tasks WHERE moderation_id=r.id AND status='reviewing') AS frozen_micros
			FROM moderation_reviews r JOIN users u ON u.id=r.user_id LEFT JOIN users reviewer ON reviewer.id=r.reviewed_by
			WHERE ($1='' OR r.status=$1) ORDER BY r.created_at DESC,r.id LIMIT $2 OFFSET $3`, c.Query("status"), limit, offset)
		for _, item := range items {
			for key, value := range object(item["requestSnapshot"]) {
				item[key] = value
			}
			delete(item, "requestSnapshot")
			item["frozen"] = money(integer(item["frozenMicros"]))
			delete(item, "frozenMicros")
		}
		return gin.H{"reviews": items}, err
	}))
	admin.POST("/moderation/:id/decision", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		input, err := body[struct {
			Decision string `json:"decision" binding:"required,oneof=approved rejected"`
			Note string `json:"note"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		review, err := one(ctx, a.DB, "SELECT user_id FROM moderation_reviews WHERE id=$1", id)
		if err != nil {
			return nil, err
		}
		userID := str(review["userId"])
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := lockWallet(ctx, tx, userID); err != nil {
				return err
			}
			review, err := one(ctx, tx, "SELECT status FROM moderation_reviews WHERE id=$1 FOR UPDATE", id)
			if err != nil {
				return err
			}
			if review["status"] == input.Decision {
				return nil
			}
			if review["status"] != "pending" {
				return problem(409, "review_completed", "此请求已处理，请刷新列表")
			}
			tasks, err := rows(ctx, tx, "SELECT * FROM generation_tasks WHERE moderation_id=$1 AND status='reviewing' ORDER BY id FOR UPDATE", id)
			if err != nil {
				return err
			}
			for _, task := range tasks {
				if input.Decision == "approved" {
					if err = a.modelAccess(ctx, tx, userID, str(task["modelId"])); err != nil {
						return err
					}
					if _, err = modelForTask(ctx, tx, str(task["modelId"])); err != nil {
						return err
					}
					_, err = tx.Exec(ctx, "UPDATE generation_tasks SET status='queued',queued_at=now(),available_at=now() WHERE id=$1", task["id"])
				} else {
					price := integer(task["priceMicros"])
					if _, err = changeWallet(ctx, tx, userID, "release", taskReference(task), price, -price, "内容审核拒绝，退回冻结余额"); err != nil {
						return err
					}
					message := "内容审核未通过，冻结余额已退回"
					if strings.TrimSpace(input.Note) != "" {
						message += "：" + strings.TrimSpace(input.Note)
					}
					_, err = tx.Exec(ctx, "UPDATE generation_tasks SET status='failed',error_code='moderation_rejected',error_message=$2,billed_micros=0,finished_at=now() WHERE id=$1", task["id"], message)
				}
				if err != nil {
					return err
				}
			}
			if _, err = tx.Exec(ctx, "UPDATE moderation_reviews SET status=$2,reviewed_by=$3,note=$4,reviewed_at=now() WHERE id=$1", id, input.Decision, currentUser(c).ID, strings.TrimSpace(input.Note)); err != nil {
				return err
			}
			if err = a.audit(ctx, tx, currentUser(c).ID, "moderation."+input.Decision, id, gin.H{"note": input.Note}); err != nil {
				return err
			}
			content := "内容审核已通过，任务已进入生成队列。"
			if input.Decision == "rejected" {
				content = "内容审核未通过，冻结余额已退回。" + strings.TrimSpace(input.Note)
			}
			return a.notification(ctx, tx, userID, "moderation-result:"+id, "moderation.result", "内容审核结果", content)
		})
		return nil, err
	}))
}
