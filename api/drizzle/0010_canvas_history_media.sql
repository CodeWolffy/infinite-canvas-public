CREATE TABLE "canvas_project_history_media" (
  "history_id" uuid NOT NULL REFERENCES "canvas_project_history"("id") ON DELETE cascade,
  "media_id" uuid NOT NULL REFERENCES "media_objects"("id") ON DELETE restrict,
  PRIMARY KEY ("history_id", "media_id")
);
CREATE INDEX "canvas_project_history_media_media_idx" ON "canvas_project_history_media" ("media_id");
--> statement-breakpoint
-- Preserve existing server snapshots without interpreting unrelated UUID text as a file reference.
WITH RECURSIVE walk (history_id, value, key, property, list_item) AS (
  SELECT id, snapshot, NULL::text, false, false FROM canvas_project_history
  UNION ALL
  SELECT walk.history_id, child.value, child.key, child.property, child.list_item
  FROM walk
  CROSS JOIN LATERAL (
    SELECT entry.value, entry.key, true AS property, false AS list_item
    FROM jsonb_each(CASE WHEN jsonb_typeof(walk.value) = 'object' THEN walk.value ELSE '{}'::jsonb END) entry
    UNION ALL
    SELECT element.value, walk.key, false, walk.property AND walk.key IN ('mediaIds', 'fileIds')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(walk.value) = 'array' THEN walk.value ELSE '[]'::jsonb END) element
  ) child
), strings AS (
  SELECT history_id, value #>> '{}' AS value, key, list_item FROM walk WHERE jsonb_typeof(value) = 'string'
), explicit_ids AS (
  SELECT history_id, CASE WHEN key = 'storageKey' THEN regexp_replace(value, '^image:', '') ELSE value END AS media_id
  FROM strings WHERE key IN ('mediaId', 'fileId', 'storageKey') OR list_item
), candidates AS (
  SELECT history_id, media_id FROM explicit_ids
  WHERE media_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  UNION
  SELECT history_id, match[1] FROM strings
  CROSS JOIN LATERAL regexp_matches(value, '/api/media/([0-9a-f-]{36})(?:\y|/|\?|#)', 'gi') AS match
), retained AS (
  INSERT INTO canvas_project_history_media (history_id, media_id)
  SELECT DISTINCT candidates.history_id, media_objects.id
  FROM candidates JOIN media_objects ON media_objects.id::text = lower(candidates.media_id)
  WHERE media_objects.status = 'ready'
  RETURNING media_id
), counts AS (
  SELECT media_id, count(*)::int AS count FROM retained GROUP BY media_id
)
UPDATE media_objects SET reference_count = reference_count + counts.count
FROM counts WHERE media_objects.id = counts.media_id;
