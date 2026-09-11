ALTER TABLE "models" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
WITH ordered AS (
  SELECT "id", (row_number() OVER (ORDER BY "display_name", "id") - 1)::integer AS "sort_order"
  FROM "models"
  WHERE "deleted_at" IS NULL
)
UPDATE "models"
SET "sort_order" = ordered."sort_order"
FROM ordered
WHERE "models"."id" = ordered."id";
