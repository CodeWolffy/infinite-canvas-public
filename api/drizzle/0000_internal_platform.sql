CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TYPE "user_role" AS ENUM ('admin', 'user');
CREATE TYPE "user_status" AS ENUM ('active', 'disabled');
CREATE TYPE "model_capability" AS ENUM ('image', 'text');
CREATE TYPE "model_status" AS ENUM ('draft', 'published', 'disabled');
CREATE TYPE "channel_protocol" AS ENUM ('openai', 'gemini');
CREATE TYPE "channel_status" AS ENUM ('active', 'disabled', 'needs_attention');
CREATE TYPE "media_status" AS ENUM ('ready', 'deleting');
CREATE TYPE "asset_scope" AS ENUM ('private', 'public');
CREATE TYPE "asset_type" AS ENUM ('image', 'text');
CREATE TYPE "request_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'canceled');
CREATE TYPE "attempt_status" AS ENUM ('running', 'succeeded', 'failed');
CREATE TYPE "message_role" AS ENUM ('system', 'user', 'assistant');
--> statement-breakpoint
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" varchar(64) NOT NULL,
  "password_hash" text NOT NULL,
  "display_name" varchar(80) NOT NULL,
  "role" "user_role" DEFAULT 'user' NOT NULL,
  "status" "user_status" DEFAULT 'active' NOT NULL,
  "must_change_password" boolean DEFAULT true NOT NULL,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "users_username_unique" ON "users" ("username");
--> statement-breakpoint
CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "token_hash" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" ("token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions" ("expires_at");
--> statement-breakpoint
CREATE TABLE "user_preferences" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE cascade,
  "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(120) NOT NULL,
  "display_name" varchar(120) NOT NULL,
  "capability" "model_capability" NOT NULL,
  "status" "model_status" DEFAULT 'draft' NOT NULL,
  "price_per_image" numeric(14, 6),
  "description" text,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "models_name_unique" ON "models" ("name");
--> statement-breakpoint
CREATE TABLE "channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(120) NOT NULL,
  "protocol" "channel_protocol" NOT NULL,
  "base_url" text NOT NULL,
  "encrypted_api_key" text,
  "api_key_hint" varchar(32),
  "status" "channel_status" DEFAULT 'disabled' NOT NULL,
  "timeout_ms" integer DEFAULT 480000 NOT NULL,
  "max_concurrency" integer DEFAULT 1 NOT NULL,
  "cooldown_until" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_failure_at" timestamp with time zone,
  "last_error_code" varchar(80),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_channels" (
  "model_id" uuid NOT NULL REFERENCES "models"("id") ON DELETE cascade,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE cascade,
  "upstream_model" varchar(160) NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "weight" integer DEFAULT 100 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("model_id", "channel_id")
);
CREATE INDEX "model_channels_schedule_idx" ON "model_channels" ("model_id", "enabled", "priority");
--> statement-breakpoint
CREATE TABLE "canvas_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "title" varchar(200) NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "canvas_projects_user_updated_idx" ON "canvas_projects" ("user_id", "updated_at");
--> statement-breakpoint
CREATE TABLE "media_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "bucket" varchar(63) NOT NULL,
  "object_key" text NOT NULL,
  "original_name" varchar(255) NOT NULL,
  "mime_type" varchar(80) NOT NULL,
  "byte_size" bigint NOT NULL,
  "width" integer,
  "height" integer,
  "sha256" varchar(64) NOT NULL,
  "reference_count" integer DEFAULT 0 NOT NULL,
  "status" "media_status" DEFAULT 'ready' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "media_objects_object_unique" ON "media_objects" ("bucket", "object_key");
CREATE INDEX "media_objects_owner_created_idx" ON "media_objects" ("owner_id", "created_at");
--> statement-breakpoint
CREATE TABLE "assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "scope" "asset_scope" DEFAULT 'private' NOT NULL,
  "type" "asset_type" NOT NULL,
  "title" varchar(200) NOT NULL,
  "content" text,
  "media_id" uuid REFERENCES "media_objects"("id") ON DELETE restrict,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "assets_owner_scope_idx" ON "assets" ("owner_id", "scope");
CREATE INDEX "assets_scope_created_idx" ON "assets" ("scope", "created_at");
--> statement-breakpoint
CREATE TABLE "generation_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "canvas_project_id" uuid REFERENCES "canvas_projects"("id") ON DELETE set null,
  "model_id" uuid NOT NULL REFERENCES "models"("id") ON DELETE restrict,
  "prompt" text NOT NULL,
  "requested_count" integer NOT NULL,
  "parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "generation_batches_user_created_idx" ON "generation_batches" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE "generation_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "generation_batches"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "model_id" uuid NOT NULL REFERENCES "models"("id") ON DELETE restrict,
  "status" "request_status" DEFAULT 'queued' NOT NULL,
  "sequence" integer NOT NULL,
  "prompt" text NOT NULL,
  "parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "price_snapshot" numeric(14, 6),
  "model_name_snapshot" varchar(120),
  "model_display_name_snapshot" varchar(120),
  "error_code" varchar(80),
  "error_message" text,
  "queued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
CREATE UNIQUE INDEX "generation_tasks_batch_sequence_unique" ON "generation_tasks" ("batch_id", "sequence");
CREATE INDEX "generation_tasks_status_queued_idx" ON "generation_tasks" ("status", "queued_at");
CREATE INDEX "generation_tasks_user_finished_idx" ON "generation_tasks" ("user_id", "finished_at");
--> statement-breakpoint
CREATE TABLE "generation_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "generation_tasks"("id") ON DELETE cascade,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE restrict,
  "channel_name_snapshot" varchar(120),
  "upstream_model" varchar(160) NOT NULL,
  "attempt_number" integer NOT NULL,
  "status" "attempt_status" DEFAULT 'running' NOT NULL,
  "http_status" integer,
  "error_category" varchar(80),
  "error_message" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "duration_ms" integer
);
CREATE UNIQUE INDEX "generation_attempts_task_number_unique" ON "generation_attempts" ("task_id", "attempt_number");
CREATE INDEX "generation_attempts_channel_started_idx" ON "generation_attempts" ("channel_id", "started_at");
--> statement-breakpoint
CREATE TABLE "generated_images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "generation_tasks"("id") ON DELETE cascade,
  "media_id" uuid NOT NULL REFERENCES "media_objects"("id") ON DELETE restrict,
  "billed_amount" numeric(14, 6) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "generated_images_task_unique" ON "generated_images" ("task_id");
CREATE UNIQUE INDEX "generated_images_media_unique" ON "generated_images" ("media_id");
--> statement-breakpoint
CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "canvas_project_id" uuid REFERENCES "canvas_projects"("id") ON DELETE set null,
  "title" varchar(200) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "conversations_user_updated_idx" ON "conversations" ("user_id", "updated_at");
--> statement-breakpoint
CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
  "role" "message_role" NOT NULL,
  "content" text NOT NULL,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "messages_conversation_created_idx" ON "messages" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE TABLE "text_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
  "request_message_id" uuid REFERENCES "messages"("id") ON DELETE set null,
  "response_message_id" uuid REFERENCES "messages"("id") ON DELETE set null,
  "model_id" uuid NOT NULL REFERENCES "models"("id") ON DELETE restrict,
  "channel_id" uuid REFERENCES "channels"("id") ON DELETE restrict,
  "upstream_model" varchar(160),
  "status" "request_status" DEFAULT 'queued' NOT NULL,
  "error_code" varchar(80),
  "duration_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
CREATE INDEX "text_requests_user_created_idx" ON "text_requests" ("user_id", "created_at");
CREATE INDEX "text_requests_channel_created_idx" ON "text_requests" ("channel_id", "created_at");
