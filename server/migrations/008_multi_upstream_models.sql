ALTER TABLE model_channels DROP CONSTRAINT IF EXISTS model_channels_pkey;
ALTER TABLE model_channels ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
UPDATE model_channels SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE model_channels ALTER COLUMN id SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_channels_pkey') THEN
        ALTER TABLE model_channels ADD CONSTRAINT model_channels_pkey PRIMARY KEY (id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_channels_model_channel_upstream_unique') THEN
        ALTER TABLE model_channels ADD CONSTRAINT model_channels_model_channel_upstream_unique UNIQUE (model_id, channel_id, upstream_model);
    END IF;
END $$;
