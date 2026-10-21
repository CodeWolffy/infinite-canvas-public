-- 逻辑行大小计入内容配额，包含行元数据以免大量空记录绕过容量治理。
CREATE TABLE user_content_usage (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    byte_size bigint NOT NULL DEFAULT 0 CHECK (byte_size >= 0)
);

-- 升级非空旧库时先完整计量；不删除已有内容，也不因已有用户超额阻止迁移。
INSERT INTO user_content_usage(user_id,byte_size)
SELECT user_id,sum(bytes) FROM (
    SELECT user_id,octet_length(to_jsonb(p)::text)::bigint AS bytes FROM user_preferences p
    UNION ALL SELECT user_id,octet_length(to_jsonb(p)::text)::bigint FROM canvas_projects p
    UNION ALL SELECT user_id,octet_length(to_jsonb(p)::text)::bigint FROM canvas_project_history p
    UNION ALL SELECT owner_id,octet_length(to_jsonb(p)::text)::bigint FROM assets p
    UNION ALL SELECT created_by,octet_length(to_jsonb(p)::text)::bigint FROM canvas_templates p WHERE created_by IS NOT NULL
) content GROUP BY user_id;

CREATE FUNCTION track_user_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    before_row jsonb;
    after_row jsonb;
    owner uuid;
    delta bigint;
    previous bigint;
    baseline_key text;
BEGIN
    IF TG_OP <> 'INSERT' THEN before_row := to_jsonb(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN after_row := to_jsonb(NEW); END IF;
    owner := coalesce(after_row->>TG_ARGV[0],before_row->>TG_ARGV[0])::uuid;
    IF owner IS NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND (before_row->>TG_ARGV[0]) IS DISTINCT FROM (after_row->>TG_ARGV[0]) THEN
        RAISE EXCEPTION 'content_owner_immutable';
    END IF;
    delta := coalesce(octet_length(after_row::text),0)::bigint - coalesce(octet_length(before_row::text),0)::bigint;
    INSERT INTO user_content_usage(user_id,byte_size) VALUES(owner,0) ON CONFLICT DO NOTHING;
    -- 同一用户所有内容写入共用这一行锁；计量与业务写入一起提交或回滚。
    UPDATE user_content_usage SET byte_size=byte_size+delta WHERE user_id=owner RETURNING byte_size-delta INTO previous;
    baseline_key := 'ic.content_start_' || replace(owner::text,'-','_');
    IF nullif(current_setting(baseline_key,true),'') IS NULL THEN
        PERFORM set_config(baseline_key,previous::text,true);
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER preferences_content_usage AFTER INSERT OR UPDATE OR DELETE ON user_preferences FOR EACH ROW EXECUTE FUNCTION track_user_content('user_id');
CREATE TRIGGER canvas_content_usage AFTER INSERT OR UPDATE OR DELETE ON canvas_projects FOR EACH ROW EXECUTE FUNCTION track_user_content('user_id');
CREATE TRIGGER history_content_usage AFTER INSERT OR UPDATE OR DELETE ON canvas_project_history FOR EACH ROW EXECUTE FUNCTION track_user_content('user_id');
CREATE TRIGGER asset_content_usage AFTER INSERT OR UPDATE OR DELETE ON assets FOR EACH ROW EXECUTE FUNCTION track_user_content('owner_id');
CREATE TRIGGER template_content_usage AFTER INSERT OR UPDATE OR DELETE ON canvas_templates FOR EACH ROW EXECUTE FUNCTION track_user_content('created_by');

CREATE FUNCTION check_user_content_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    used bigint;
    initial bigint;
    quota bigint := coalesce(nullif(current_setting('ic.user_content_quota_bytes',true),''),'268435456')::bigint;
BEGIN
    SELECT byte_size INTO used FROM user_content_usage WHERE user_id=NEW.user_id;
    initial := nullif(current_setting('ic.content_start_' || replace(NEW.user_id::text,'-','_'),true),'')::bigint;
    -- 在事务末尾核对净增长，允许超额旧用户删除/缩小，也允许历史轮替释放空间。
    IF used > quota AND used > initial THEN RAISE EXCEPTION 'user_content_quota'; END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER user_content_quota_check AFTER UPDATE ON user_content_usage
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_user_content_quota();
