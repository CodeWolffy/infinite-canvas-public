-- 用户分组：折扣率按 newapi 的 GroupRatio 思路，对模型价格整体乘系数；0 为免费组。
CREATE TABLE user_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(80) NOT NULL UNIQUE,
    discount numeric(6,4) NOT NULL DEFAULT 1.0000 CHECK (discount >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO user_groups(name, discount) VALUES ('默认', 1.0);
ALTER TABLE users ADD COLUMN group_id uuid REFERENCES user_groups(id);

-- 充值兑换码：与邀请码同结构的哈希存储 + 一次性额度入账。
CREATE TABLE redeem_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text NOT NULL UNIQUE, code_hint text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id), note text NOT NULL DEFAULT '',
    amount_micros bigint NOT NULL CHECK (amount_micros > 0),
    max_uses integer NOT NULL CHECK (max_uses > 0), used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
    expires_at timestamptz, disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE redeem_uses (
    code_id uuid NOT NULL REFERENCES redeem_codes(id), user_id uuid NOT NULL UNIQUE REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(code_id,user_id)
);

-- 视频/音频按秒计价：NULL 表示沿用固定单次价格；duration 来自生成参数或实际产物时长。
ALTER TABLE models
    ADD COLUMN price_per_second bigint CHECK (price_per_second IS NULL OR price_per_second >= 0);
ALTER TABLE generation_tasks
    ADD COLUMN price_per_second bigint,
    ADD COLUMN seconds numeric(8,2),
    ADD COLUMN group_discount numeric(6,4);

-- 敏感词：拦截生成与文本提交。
CREATE TABLE sensitive_words (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pattern text NOT NULL UNIQUE,
    action text NOT NULL DEFAULT 'block' CHECK (action IN ('block','review')),
    created_at timestamptz NOT NULL DEFAULT now()
);
