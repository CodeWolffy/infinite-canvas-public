CREATE TABLE canvas_user_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewport jsonb NOT NULL DEFAULT '{"x":0,"y":0,"k":1}',
    chat_sessions jsonb NOT NULL DEFAULT '[]',
    active_chat_id text,
    UNIQUE(project_id,user_id)
);
CREATE INDEX canvas_user_views_user_idx ON canvas_user_views(user_id);

CREATE TABLE canvas_history_personal (
    history_id uuid PRIMARY KEY REFERENCES canvas_project_history(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot jsonb NOT NULL
);
CREATE INDEX canvas_history_personal_user_idx ON canvas_history_personal(user_id);

CREATE TABLE canvas_presence (
    project_id uuid NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY(project_id,user_id,client_id)
);
CREATE INDEX canvas_presence_expiry_idx ON canvas_presence(expires_at);

-- 非空旧库先保留本人视口、助手记录及私人历史，再移除共享内容中的私人字段。
-- 迁移只改变存储形态，额外的行元数据不应阻止已超额旧用户升级。
ALTER TABLE user_content_usage DISABLE TRIGGER user_content_quota_check;
ALTER TABLE canvas_projects DISABLE TRIGGER canvas_content_usage;
ALTER TABLE canvas_project_history DISABLE TRIGGER history_content_usage;
INSERT INTO canvas_user_views(project_id,user_id,viewport,chat_sessions,active_chat_id)
SELECT id,user_id,coalesce(snapshot->'viewport','{"x":0,"y":0,"k":1}'),
    coalesce(snapshot->'chatSessions','[]'),snapshot->>'activeChatId'
FROM canvas_projects WHERE snapshot ?| ARRAY['viewport','chatSessions','activeChatId'];

INSERT INTO canvas_history_personal(history_id,user_id,snapshot)
SELECT id,user_id,jsonb_build_object('viewport',coalesce(snapshot->'viewport','{"x":0,"y":0,"k":1}'),
    'chatSessions',coalesce(snapshot->'chatSessions','[]'),'activeChatId',snapshot->'activeChatId')
FROM canvas_project_history WHERE snapshot ?| ARRAY['viewport','chatSessions','activeChatId'];

-- 仅用于迁移，与应用提取器一致识别媒体键和 /api/media/ URL，不能用 UUID 子串猜测引用。
CREATE FUNCTION pg_temp.canvas_media_ids(document jsonb) RETURNS TABLE(media_id uuid) LANGUAGE sql IMMUTABLE AS $$
    WITH RECURSIVE fields(value,key) AS (
        SELECT document,''::text
        UNION ALL
        SELECT child.value,child.key FROM fields f CROSS JOIN LATERAL (
            SELECT value,key FROM jsonb_each(CASE WHEN jsonb_typeof(f.value)='object' THEN f.value ELSE '{}'::jsonb END)
            UNION ALL
            SELECT value,f.key FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.value)='array' THEN f.value ELSE '[]'::jsonb END)
        ) child
    ), strings AS (
        SELECT key,value #>> '{}' AS value FROM fields WHERE jsonb_typeof(value)='string'
    ), candidates AS (
        SELECT CASE WHEN key='storageKey' THEN regexp_replace(regexp_replace(value,'^image:',''),'^media:','') ELSE value END AS value
        FROM strings WHERE key IN ('mediaId','fileId','mediaIds','fileIds','storageKey')
        UNION ALL
        SELECT matches.parts[1] FROM strings CROSS JOIN LATERAL regexp_matches(value,'/api/media/([0-9a-fA-F-]{36})','g') AS matches(parts)
    ), normalized AS (
        -- 对齐 google/uuid.Parse：URN 必须为 45 字节，38 字节形式只检查中间 36 字节。
        SELECT CASE
            WHEN octet_length(value)=45 AND left(value,9) ~* '^urn:uuid:$' THEN substr(value,10)
            WHEN octet_length(value)=38 AND length(value)=38 THEN substr(value,2,36)
            ELSE value END AS value
        FROM candidates
    )
    SELECT DISTINCT value::uuid FROM normalized
    WHERE value ~* '^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';
$$;

INSERT INTO media_references(owner_kind,owner_id,user_id,media_id)
SELECT 'canvas_personal',v.id,v.user_id,mr.media_id FROM canvas_user_views v
JOIN media_references mr ON mr.owner_kind='canvas' AND mr.owner_id=v.project_id
JOIN LATERAL pg_temp.canvas_media_ids(jsonb_build_object('chatSessions',v.chat_sessions)) ids ON ids.media_id=mr.media_id;

INSERT INTO media_references(owner_kind,owner_id,user_id,media_id)
SELECT 'canvas_history_personal',hp.history_id,hp.user_id,mr.media_id FROM canvas_history_personal hp
JOIN media_references mr ON mr.owner_kind='history' AND mr.owner_id=hp.history_id
JOIN LATERAL pg_temp.canvas_media_ids(hp.snapshot) ids ON ids.media_id=mr.media_id;

UPDATE canvas_projects SET snapshot=snapshot-ARRAY['viewport','chatSessions','activeChatId']
WHERE snapshot ?| ARRAY['viewport','chatSessions','activeChatId'];
UPDATE canvas_project_history SET snapshot=snapshot-ARRAY['viewport','chatSessions','activeChatId']
WHERE snapshot ?| ARRAY['viewport','chatSessions','activeChatId'];

DELETE FROM media_references mr USING canvas_projects p
WHERE mr.owner_kind='canvas' AND mr.owner_id=p.id
AND NOT EXISTS(SELECT 1 FROM pg_temp.canvas_media_ids(p.snapshot) ids WHERE ids.media_id=mr.media_id);
DELETE FROM media_references mr USING canvas_project_history h
WHERE mr.owner_kind='history' AND mr.owner_id=h.id
AND NOT EXISTS(SELECT 1 FROM pg_temp.canvas_media_ids(h.snapshot) ids WHERE ids.media_id=mr.media_id);
DROP FUNCTION pg_temp.canvas_media_ids(jsonb);

-- 触发器暂时关闭期间统一重算，避免迁移前旧字段删除与新个人行插入造成双重计量。
DELETE FROM user_content_usage;
INSERT INTO user_content_usage(user_id,byte_size)
SELECT user_id,sum(bytes) FROM (
    SELECT user_id,octet_length(to_jsonb(p)::text)::bigint AS bytes FROM user_preferences p
    UNION ALL SELECT user_id,octet_length(to_jsonb(p)::text)::bigint FROM canvas_projects p
    UNION ALL SELECT user_id,octet_length(to_jsonb(p)::text)::bigint FROM canvas_project_history p
    UNION ALL SELECT owner_id,octet_length(to_jsonb(p)::text)::bigint FROM assets p
    UNION ALL SELECT created_by,octet_length(to_jsonb(p)::text)::bigint FROM canvas_templates p WHERE created_by IS NOT NULL
    UNION ALL SELECT user_id,octet_length(to_jsonb(v)::text)::bigint FROM canvas_user_views v
    UNION ALL SELECT user_id,octet_length(to_jsonb(h)::text)::bigint FROM canvas_history_personal h
) content GROUP BY user_id;
ALTER TABLE canvas_projects ENABLE TRIGGER canvas_content_usage;
ALTER TABLE canvas_project_history ENABLE TRIGGER history_content_usage;
ALTER TABLE user_content_usage ENABLE TRIGGER user_content_quota_check;

CREATE TRIGGER canvas_personal_content_usage AFTER INSERT OR UPDATE OR DELETE ON canvas_user_views
FOR EACH ROW EXECUTE FUNCTION track_user_content('user_id');
CREATE TRIGGER canvas_history_personal_content_usage AFTER INSERT OR UPDATE OR DELETE ON canvas_history_personal
FOR EACH ROW EXECUTE FUNCTION track_user_content('user_id');

CREATE FUNCTION delete_canvas_personal_media_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME='canvas_user_views' THEN
        DELETE FROM media_references WHERE owner_kind='canvas_personal' AND owner_id=OLD.id;
    ELSE
        DELETE FROM media_references WHERE owner_kind='canvas_history_personal' AND owner_id=OLD.history_id;
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER canvas_personal_media_cleanup AFTER DELETE ON canvas_user_views
FOR EACH ROW EXECUTE FUNCTION delete_canvas_personal_media_refs();
CREATE TRIGGER canvas_history_personal_media_cleanup AFTER DELETE ON canvas_history_personal
FOR EACH ROW EXECUTE FUNCTION delete_canvas_personal_media_refs();
