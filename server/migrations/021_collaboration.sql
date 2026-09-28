CREATE TABLE workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(80) NOT NULL,
    owner_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_members (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id,user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);
ALTER TABLE canvas_projects ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX canvas_projects_workspace_idx ON canvas_projects(workspace_id) WHERE workspace_id IS NOT NULL;
ALTER TABLE assets ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX assets_workspace_idx ON assets(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE TABLE share_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL CHECK (kind IN ('canvas','asset')),
    target_id uuid NOT NULL,
    token text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE UNIQUE INDEX share_links_active_idx ON share_links(kind,target_id) WHERE revoked_at IS NULL;
CREATE TABLE canvas_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title varchar(200) NOT NULL,
    description varchar(500) NOT NULL DEFAULT '',
    snapshot jsonb NOT NULL,
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
