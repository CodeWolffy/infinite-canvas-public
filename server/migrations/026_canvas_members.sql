-- 单画布邀请独立于工作区权限；已有匿名分享保留，未开启的画布不自动生成链接。
CREATE TABLE canvas_members (
    project_id uuid NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('editor','viewer')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
    invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id,user_id)
);
CREATE INDEX canvas_members_user_idx ON canvas_members(user_id,status);

CREATE TABLE canvas_access_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_access_logs_project_idx ON canvas_access_logs(project_id,created_at DESC,id DESC);
