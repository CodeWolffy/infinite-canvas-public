import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRole = pgEnum("user_role", ["admin", "user"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const modelCapability = pgEnum("model_capability", ["image", "text"]);
export const modelStatus = pgEnum("model_status", ["draft", "published", "disabled"]);
export const channelProtocol = pgEnum("channel_protocol", ["openai", "gemini"]);
export const channelStatus = pgEnum("channel_status", ["active", "disabled", "needs_attention"]);
export const mediaStatus = pgEnum("media_status", ["ready", "deleting"]);
export const assetScope = pgEnum("asset_scope", ["private", "public"]);
export const assetType = pgEnum("asset_type", ["image", "text"]);
export const requestStatus = pgEnum("request_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export const attemptStatus = pgEnum("attempt_status", ["running", "succeeded", "failed"]);
export const requestLogType = pgEnum("request_log_type", ["image", "text", "probe"]);
export const messageRole = pgEnum("message_role", ["system", "user", "assistant"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: varchar("username", { length: 64 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    role: userRole("role").notNull().default("user"),
    status: userStatus("status").notNull().default("active"),
    mustChangePassword: boolean("must_change_password").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [uniqueIndex("users_username_unique").on(table.username)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  preferences: jsonb("preferences").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const models = pgTable(
  "models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 120 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    capability: modelCapability("capability").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: modelStatus("status").notNull().default("draft"),
    pricePerImage: numeric("price_per_image", { precision: 14, scale: 6 }),
    description: text("description"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps(),
  },
);

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull(),
  protocol: channelProtocol("protocol").notNull(),
  baseUrl: text("base_url").notNull(),
  encryptedApiKey: text("encrypted_api_key"),
  apiKeyHint: varchar("api_key_hint", { length: 32 }),
  status: channelStatus("status").notNull().default("disabled"),
  timeoutMs: integer("timeout_ms").notNull().default(480000),
  maxConcurrency: integer("max_concurrency").notNull().default(1),
  cooldownSeconds: integer("cooldown_seconds").notNull().default(120),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  ...timestamps(),
});

export const modelChannels = pgTable(
  "model_channels",
  {
    modelId: uuid("model_id").notNull().references(() => models.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    upstreamModel: varchar("upstream_model", { length: 160 }).notNull(),
    priority: integer("priority").notNull().default(0),
    weight: integer("weight").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.modelId, table.channelId] }),
    index("model_channels_schedule_idx").on(table.modelId, table.enabled, table.priority),
  ],
);

export const canvasProjects = pgTable(
  "canvas_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 200 }).notNull(),
    snapshot: jsonb("snapshot").notNull(),
    ...timestamps(),
  },
  (table) => [index("canvas_projects_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const canvasProjectHistory = pgTable(
  "canvas_project_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => canvasProjects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }).notNull(),
    note: varchar("note", { length: 200 }),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("canvas_project_history_project_created_idx").on(table.projectId, table.createdAt),
    index("canvas_project_history_user_idx").on(table.userId),
  ],
);

export const mediaObjects = pgTable(
  "media_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    bucket: varchar("bucket", { length: 63 }).notNull(),
    objectKey: text("object_key").notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 80 }).notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    referenceCount: integer("reference_count").notNull().default(0),
    status: mediaStatus("status").notNull().default("ready"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("media_objects_object_unique").on(table.bucket, table.objectKey),
    index("media_objects_owner_created_idx").on(table.ownerId, table.createdAt),
    // 孤儿媒体清理的专用部分索引，避免每天全表扫描 media_objects。
    index("media_objects_orphan_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'ready' and ${table.referenceCount} = 0`),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    scope: assetScope("scope").notNull().default("private"),
    type: assetType("type").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    content: text("content"),
    mediaId: uuid("media_id").references(() => mediaObjects.id, { onDelete: "restrict" }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  (table) => [
    index("assets_owner_scope_idx").on(table.ownerId, table.scope),
    index("assets_scope_created_idx").on(table.scope, table.createdAt),
    // 素材列表的分页排序键，和 routes/assets.ts 的 order by 保持一致。
    index("assets_updated_pagination_idx").on(table.updatedAt.desc(), table.id.desc()),
  ],
);

export const canvasProjectMedia = pgTable(
  "canvas_project_media",
  {
    projectId: uuid("project_id").notNull().references(() => canvasProjects.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id").notNull().references(() => mediaObjects.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.mediaId] }),
    index("canvas_project_media_media_idx").on(table.mediaId),
  ],
);

export const canvasProjectHistoryMedia = pgTable(
  "canvas_project_history_media",
  {
    historyId: uuid("history_id").notNull().references(() => canvasProjectHistory.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id").notNull().references(() => mediaObjects.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.historyId, table.mediaId] }),
    index("canvas_project_history_media_media_idx").on(table.mediaId),
  ],
);

export const generationBatches = pgTable(
  "generation_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    canvasProjectId: uuid("canvas_project_id").references(() => canvasProjects.id, { onDelete: "set null" }),
    modelId: uuid("model_id").notNull().references(() => models.id, { onDelete: "restrict" }),
    prompt: text("prompt").notNull(),
    requestedCount: integer("requested_count").notNull(),
    parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("generation_batches_user_created_idx").on(table.userId, table.createdAt)],
);

export const generationBatchMedia = pgTable(
  "generation_batch_media",
  {
    batchId: uuid("batch_id").notNull().references(() => generationBatches.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id").notNull().references(() => mediaObjects.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.mediaId] }),
    index("generation_batch_media_media_idx").on(table.mediaId),
  ],
);

export const generationTasks = pgTable(
  "generation_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => generationBatches.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    modelId: uuid("model_id").notNull().references(() => models.id, { onDelete: "restrict" }),
    status: requestStatus("status").notNull().default("queued"),
    sequence: integer("sequence").notNull(),
    prompt: text("prompt").notNull(),
    parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
    priceSnapshot: numeric("price_snapshot", { precision: 14, scale: 6 }),
    modelNameSnapshot: varchar("model_name_snapshot", { length: 120 }),
    modelDisplayNameSnapshot: varchar("model_display_name_snapshot", { length: 120 }),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("generation_tasks_batch_sequence_unique").on(table.batchId, table.sequence),
    index("generation_tasks_status_queued_idx").on(table.status, table.queuedAt),
    index("generation_tasks_user_finished_idx").on(table.userId, table.finishedAt),
    index("generation_tasks_queued_at_idx").on(table.queuedAt),
  ],
);

export const generationAttempts = pgTable(
  "generation_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => generationTasks.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
    channelNameSnapshot: varchar("channel_name_snapshot", { length: 120 }),
    upstreamModel: varchar("upstream_model", { length: 160 }).notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: attemptStatus("status").notNull().default("running"),
    httpStatus: integer("http_status"),
    errorCategory: varchar("error_category", { length: 80 }),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    uniqueIndex("generation_attempts_task_number_unique").on(table.taskId, table.attemptNumber),
    index("generation_attempts_channel_started_idx").on(table.channelId, table.startedAt),
  ],
);

export const requestLogs = pgTable(
  "request_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id"),
    type: requestLogType("type").notNull().default("image"),
    taskId: uuid("task_id"),
    textRequestId: uuid("text_request_id"),
    modelId: uuid("model_id"),
    modelNameSnapshot: varchar("model_name_snapshot", { length: 120 }),
    modelDisplayNameSnapshot: varchar("model_display_name_snapshot", { length: 120 }),
    channelId: uuid("channel_id"),
    channelNameSnapshot: varchar("channel_name_snapshot", { length: 120 }),
    upstreamModel: varchar("upstream_model", { length: 160 }),
    status: attemptStatus("status").notNull().default("running"),
    httpStatus: integer("http_status"),
    errorCategory: varchar("error_category", { length: 80 }),
    errorMessage: text("error_message"),
    billedAmount: numeric("billed_amount", { precision: 14, scale: 6 }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    index("request_logs_started_idx").on(table.startedAt),
    index("request_logs_user_started_idx").on(table.userId, table.startedAt),
    index("request_logs_channel_started_idx").on(table.channelId, table.startedAt),
    index("request_logs_model_started_idx").on(table.modelId, table.startedAt),
  ],
);

export const generatedImages = pgTable(
  "generated_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => generationTasks.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id").notNull().references(() => mediaObjects.id, { onDelete: "restrict" }),
    billedAmount: numeric("billed_amount", { precision: 14, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("generated_images_task_unique").on(table.taskId),
    uniqueIndex("generated_images_media_unique").on(table.mediaId),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    canvasProjectId: uuid("canvas_project_id").references(() => canvasProjects.id, { onDelete: "set null" }),
    title: varchar("title", { length: 200 }).notNull(),
    ...timestamps(),
  },
  (table) => [index("conversations_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    attachments: jsonb("attachments").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)],
);

export const textRequests = pgTable(
  "text_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    requestMessageId: uuid("request_message_id").references(() => messages.id, { onDelete: "set null" }),
    responseMessageId: uuid("response_message_id").references(() => messages.id, { onDelete: "set null" }),
    modelId: uuid("model_id").notNull().references(() => models.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "restrict" }),
    upstreamModel: varchar("upstream_model", { length: 160 }),
    status: requestStatus("status").notNull().default("queued"),
    errorCode: varchar("error_code", { length: 80 }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("text_requests_user_created_idx").on(table.userId, table.createdAt),
    index("text_requests_channel_created_idx").on(table.channelId, table.createdAt),
  ],
);

export const messageMedia = pgTable(
  "message_media",
  {
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id").notNull().references(() => mediaObjects.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.mediaId] }),
    index("message_media_media_idx").on(table.mediaId),
  ],
);

export const appSettings = pgTable("app_settings", {
  key: varchar("key", { length: 80 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type MediaObject = typeof mediaObjects.$inferSelect;
