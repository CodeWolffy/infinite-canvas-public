ALTER TABLE channels ADD COLUMN capability text CHECK (capability IN ('image','text','video','audio'));

-- 先保留旧渠道及其绑定，再收紧非空约束；同一旧渠道的多种能力分别保存。
DO $$
DECLARE
    source_channel channels%ROWTYPE;
    target_channel channels%ROWTYPE;
    capabilities text[];
    target_capability text;
    suffix text;
BEGIN
    FOR source_channel IN SELECT * FROM channels WHERE capability IS NULL LOOP
        SELECT array_agg(capability ORDER BY array_position(ARRAY['image','text','video','audio'], capability))
        INTO capabilities
        FROM (SELECT DISTINCT m.capability FROM model_channels b JOIN models m ON m.id=b.model_id WHERE b.channel_id=source_channel.id) kinds;

        -- 未绑定模型时沿用明确的协议/适配器，其余先归图片，管理员可在绑定前更正。
        IF capabilities IS NULL THEN
            capabilities := ARRAY[CASE WHEN source_channel.protocol='anthropic' THEN 'text' WHEN source_channel.task_adapter<>'' THEN 'video' ELSE 'image' END];
        END IF;
        UPDATE channels SET capability=capabilities[1],task_adapter=CASE WHEN capabilities[1]='video' THEN source_channel.task_adapter ELSE '' END WHERE id=source_channel.id;

        FOREACH target_capability IN ARRAY capabilities LOOP
            IF target_capability=capabilities[1] THEN CONTINUE; END IF;
            suffix := ' · ' || CASE target_capability WHEN 'image' THEN '图片' WHEN 'text' THEN '文本' WHEN 'video' THEN '视频' ELSE '音频' END;
            target_channel := source_channel;
            target_channel.id := gen_random_uuid();
            target_channel.name := left(source_channel.name,120-char_length(suffix)) || suffix;
            target_channel.capability := target_capability;
            target_channel.task_adapter := CASE WHEN target_capability='video' THEN source_channel.task_adapter ELSE '' END;
            target_channel.monitor_token := NULL;
            target_channel.monitor_deadline := NULL;
            target_channel.created_at := now();
            target_channel.updated_at := now();
            INSERT INTO channels SELECT (target_channel).*;
            INSERT INTO channel_keys(channel_id,encrypted_api_key,key_hint,status,disabled_reason,last_used_at,last_failure_at,last_success_at,last_error_code,created_at)
            SELECT target_channel.id,encrypted_api_key,key_hint,status,disabled_reason,last_used_at,last_failure_at,last_success_at,last_error_code,created_at FROM channel_keys WHERE channel_id=source_channel.id;
            UPDATE model_channels b SET channel_id=target_channel.id FROM models m WHERE b.model_id=m.id AND b.channel_id=source_channel.id AND m.capability=target_capability;
        END LOOP;
    END LOOP;
END $$;

-- 每个类型仅检测实际归属自己的绑定，避免拆分后重复执行其他类型的生成检测。
UPDATE channels c SET monitoring=jsonb_set(monitoring,'{bindingIds}',(
    SELECT coalesce(jsonb_agg(ids.binding_id ORDER BY ids.position),'[]'::jsonb)
    FROM jsonb_array_elements_text(c.monitoring->'bindingIds') WITH ORDINALITY ids(binding_id,position)
    JOIN model_channels b ON b.id::text=ids.binding_id AND b.channel_id=c.id
)) WHERE jsonb_typeof(monitoring->'bindingIds')='array';

ALTER TABLE channels ALTER COLUMN capability SET NOT NULL;
