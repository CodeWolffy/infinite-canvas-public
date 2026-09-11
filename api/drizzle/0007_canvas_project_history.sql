CREATE TABLE IF NOT EXISTS "canvas_project_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "canvas_projects"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "title" varchar(200) NOT NULL,
  "note" varchar(200),
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "canvas_project_history_project_created_idx" ON "canvas_project_history" ("project_id", "created_at");
CREATE INDEX IF NOT EXISTS "canvas_project_history_user_idx" ON "canvas_project_history" ("user_id");
