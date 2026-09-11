CREATE TYPE "request_log_type" AS ENUM ('image', 'text', 'probe');
--> statement-breakpoint
CREATE TABLE "request_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "type" "request_log_type" DEFAULT 'image' NOT NULL,
  "task_id" uuid,
  "text_request_id" uuid,
  "model_id" uuid,
  "model_name_snapshot" varchar(120),
  "model_display_name_snapshot" varchar(120),
  "channel_id" uuid,
  "channel_name_snapshot" varchar(120),
  "upstream_model" varchar(160),
  "status" "attempt_status" DEFAULT 'running' NOT NULL,
  "http_status" integer,
  "error_category" varchar(80),
  "error_message" text,
  "billed_amount" numeric(14, 6),
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "duration_ms" integer
);
CREATE INDEX "request_logs_started_idx" ON "request_logs" ("started_at");
CREATE INDEX "request_logs_user_started_idx" ON "request_logs" ("user_id", "started_at");
CREATE INDEX "request_logs_channel_started_idx" ON "request_logs" ("channel_id", "started_at");
CREATE INDEX "request_logs_model_started_idx" ON "request_logs" ("model_id", "started_at");
