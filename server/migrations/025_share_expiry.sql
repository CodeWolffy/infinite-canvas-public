-- 分享链接增加有效期：token 泄露或长期遗留时不再永久可读，到期后重新生成即可。
ALTER TABLE share_links ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now()+interval '90 days';
UPDATE share_links SET expires_at=created_at+interval '90 days' WHERE revoked_at IS NULL;
