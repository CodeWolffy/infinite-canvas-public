CREATE TABLE "canvas_project_media" (
  "project_id" uuid NOT NULL REFERENCES "canvas_projects"("id") ON DELETE cascade,
  "media_id" uuid NOT NULL REFERENCES "media_objects"("id") ON DELETE restrict,
  PRIMARY KEY ("project_id", "media_id")
);
CREATE INDEX "canvas_project_media_media_idx" ON "canvas_project_media" ("media_id");
--> statement-breakpoint
CREATE TABLE "generation_batch_media" (
  "batch_id" uuid NOT NULL REFERENCES "generation_batches"("id") ON DELETE cascade,
  "media_id" uuid NOT NULL REFERENCES "media_objects"("id") ON DELETE restrict,
  "sequence" integer NOT NULL,
  PRIMARY KEY ("batch_id", "media_id")
);
CREATE INDEX "generation_batch_media_media_idx" ON "generation_batch_media" ("media_id");
--> statement-breakpoint
CREATE TABLE "message_media" (
  "message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE cascade,
  "media_id" uuid NOT NULL REFERENCES "media_objects"("id") ON DELETE restrict,
  PRIMARY KEY ("message_id", "media_id")
);
CREATE INDEX "message_media_media_idx" ON "message_media" ("media_id");
