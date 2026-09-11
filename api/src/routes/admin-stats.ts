import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "../auth/session.js";
import { db } from "../db/client.js";

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  userId: z.string().uuid().optional(),
  modelId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
});

export async function adminStatsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    const admin = await authenticate(request, reply, { admin: true });
    if (!admin) return reply;
  });

  app.get("/", async (request, reply) => {
    const query = querySchema.parse(request.query);
    const toDate = query.to ? new Date(query.to) : new Date();
    const fromDate = query.from ? new Date(query.from) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (fromDate >= toDate) {
      return reply.code(400).send({ error: "invalid_date_range", message: "开始时间必须早于结束时间" });
    }
    const from = fromDate.toISOString();
    const to = toDate.toISOString();

    const userFilter = query.userId ? sql`and gt.user_id = ${query.userId}` : sql``;
    const modelFilter = query.modelId ? sql`and gt.model_id = ${query.modelId}` : sql``;
    const channelTaskFilter = query.channelId
      ? sql`and exists (
          select 1 from generation_attempts fa
          where fa.task_id = gt.id and fa.channel_id = ${query.channelId} and fa.status = 'succeeded'
        )`
      : sql``;
    const channelAttemptFilter = query.channelId ? sql`and a.channel_id = ${query.channelId}` : sql``;
    const textUserFilter = query.userId ? sql`and tr.user_id = ${query.userId}` : sql``;
    const textModelFilter = query.modelId ? sql`and tr.model_id = ${query.modelId}` : sql``;
    const textChannelFilter = query.channelId ? sql`and tr.channel_id = ${query.channelId}` : sql``;

    const queuePromise = db.execute(sql`
      select
        count(*) filter (where status = 'queued')::int as queued_count,
        count(*) filter (where status = 'running')::int as running_count
      from generation_tasks
      where status in ('queued', 'running')
    `);

    const storagePromise = db.execute(sql`
      select count(*)::int as total_count, coalesce(sum(byte_size), 0)::float8 as total_bytes
      from media_objects
      where status = 'ready'
    `);

    const textTotalsPromise = db.execute(sql`
      select
        count(*)::int as request_count,
        count(*) filter (where status = 'succeeded')::int as succeeded_request_count,
        count(*) filter (where status = 'failed')::int as failed_request_count
      from text_requests tr
      where tr.created_at >= ${from} and tr.created_at < ${to}
      ${textUserFilter} ${textModelFilter} ${textChannelFilter}
    `);

    const totalsPromise = db.execute(sql`
      with base_tasks as (
        select gt.*
        from generation_tasks gt
        where gt.queued_at >= ${from} and gt.queued_at < ${to}
        ${userFilter} ${modelFilter}
      ), filtered_tasks as (
        select * from base_tasks gt where true ${channelTaskFilter}
      ), task_totals as (
        select
          count(*)::int as request_count,
          count(*) filter (where status = 'succeeded')::int as succeeded_task_count,
          coalesce(avg(extract(epoch from (finished_at - started_at)) * 1000)
            filter (where finished_at is not null and started_at is not null), 0)::float8 as average_duration_ms,
          coalesce(percentile_cont(0.5) within group (
            order by extract(epoch from (finished_at - started_at)) * 1000
          ) filter (where finished_at is not null and started_at is not null), 0)::float8 as p50_duration_ms,
          coalesce(percentile_cont(0.95) within group (
            order by extract(epoch from (finished_at - started_at)) * 1000
          ) filter (where finished_at is not null and started_at is not null), 0)::float8 as p95_duration_ms
        from filtered_tasks
      ), image_totals as (
        select count(gi.id)::int as success_image_count,
          coalesce(sum(gi.billed_amount), 0)::text as estimated_cost
        from generated_images gi
        inner join filtered_tasks ft on ft.id = gi.task_id
      ), attempt_totals as (
        select count(a.id)::int as attempt_count,
          count(a.id) filter (where a.status = 'succeeded')::int as succeeded_attempt_count
        from generation_attempts a
        inner join base_tasks ft on ft.id = a.task_id
        where true ${channelAttemptFilter}
      )
      select * from task_totals, image_totals, attempt_totals
    `);

    const byUsersPromise = db.execute(sql`
      with filtered_tasks as (
        select gt.* from generation_tasks gt
        where gt.queued_at >= ${from} and gt.queued_at < ${to}
        ${userFilter} ${modelFilter} ${channelTaskFilter}
      ), images as (
        select gi.task_id, count(*)::int as image_count, coalesce(sum(gi.billed_amount), 0)::text as cost
        from generated_images gi
        inner join filtered_tasks ft on ft.id = gi.task_id
        group by gi.task_id
      )
      select u.id, u.username, u.display_name,
        count(ft.id)::int as request_count,
        coalesce(sum(images.image_count), 0)::int as success_image_count,
        coalesce(sum(images.cost::numeric), 0)::text as estimated_cost
      from filtered_tasks ft
      inner join users u on u.id = ft.user_id
      left join images on images.task_id = ft.id
      group by u.id, u.username, u.display_name
      order by request_count desc
    `);

    const byModelsPromise = db.execute(sql`
      with filtered_tasks as (
        select gt.* from generation_tasks gt
        where gt.queued_at >= ${from} and gt.queued_at < ${to}
        ${userFilter} ${modelFilter} ${channelTaskFilter}
      ), images as (
        select gi.task_id, count(*)::int as image_count, coalesce(sum(gi.billed_amount), 0)::text as cost
        from generated_images gi
        inner join filtered_tasks ft on ft.id = gi.task_id
        group by gi.task_id
      )
      select m.id, m.name, m.display_name,
        count(ft.id)::int as request_count,
        coalesce(sum(images.image_count), 0)::int as success_image_count,
        coalesce(sum(images.cost::numeric), 0)::text as estimated_cost
      from filtered_tasks ft
      inner join models m on m.id = ft.model_id
      left join images on images.task_id = ft.id
      group by m.id, m.name, m.display_name
      order by request_count desc
    `);

    const byChannelsPromise = db.execute(sql`
      with filtered_tasks as (
        select gt.* from generation_tasks gt
        where gt.queued_at >= ${from} and gt.queued_at < ${to}
        ${userFilter} ${modelFilter}
      )
      select c.id, c.name,
        count(a.id)::int as attempt_count,
        count(a.id) filter (where a.status = 'succeeded')::int as succeeded_attempt_count,
        coalesce(avg(a.duration_ms) filter (where a.duration_ms is not null), 0)::float8 as average_duration_ms,
        coalesce(percentile_cont(0.5) within group (order by a.duration_ms)
          filter (where a.duration_ms is not null), 0)::float8 as p50_duration_ms,
        coalesce(percentile_cont(0.95) within group (order by a.duration_ms)
          filter (where a.duration_ms is not null), 0)::float8 as p95_duration_ms
      from generation_attempts a
      inner join filtered_tasks ft on ft.id = a.task_id
      inner join channels c on c.id = a.channel_id
      where true ${channelAttemptFilter}
      group by c.id, c.name
      order by attempt_count desc
    `);

    // 7 个统计查询彼此独立，并发执行把总延迟从逐条累加压成最慢那条的耗时。
    const [queue, storage, textTotals, totals, byUsers, byModels, byChannels] = await Promise.all([
      queuePromise,
      storagePromise,
      textTotalsPromise,
      totalsPromise,
      byUsersPromise,
      byModelsPromise,
      byChannelsPromise,
    ]);

    const total = totals[0] as Record<string, unknown> | undefined;
    const currentQueue = queue[0] as Record<string, unknown> | undefined;
    const text = textTotals[0] as Record<string, unknown> | undefined;
    const storageRow = storage[0] as Record<string, unknown> | undefined;
    return {
      range: { from, to },
      filters: { userId: query.userId, modelId: query.modelId, channelId: query.channelId },
      storage: {
        totalCount: Number(storageRow?.total_count ?? 0),
        totalBytes: Number(storageRow?.total_bytes ?? 0),
      },
      queue: {
        queuedCount: Number(currentQueue?.queued_count ?? 0),
        runningCount: Number(currentQueue?.running_count ?? 0),
      },
      textTotals: {
        requestCount: Number(text?.request_count ?? 0),
        succeededRequestCount: Number(text?.succeeded_request_count ?? 0),
        failedRequestCount: Number(text?.failed_request_count ?? 0),
      },
      totals: {
        requestCount: Number(total?.request_count ?? 0),
        succeededTaskCount: Number(total?.succeeded_task_count ?? 0),
        successImageCount: Number(total?.success_image_count ?? 0),
        estimatedCost: String(total?.estimated_cost ?? "0"),
        averageDurationMs: Number(total?.average_duration_ms ?? 0),
        p50DurationMs: Number(total?.p50_duration_ms ?? 0),
        p95DurationMs: Number(total?.p95_duration_ms ?? 0),
        attemptCount: Number(total?.attempt_count ?? 0),
        succeededAttemptCount: Number(total?.succeeded_attempt_count ?? 0),
      },
      byUsers: byUsers.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        requestCount: Number(row.request_count),
        successImageCount: Number(row.success_image_count),
        estimatedCost: String(row.estimated_cost),
      })),
      byModels: byModels.map((row) => ({
        id: row.id,
        name: row.name,
        displayName: row.display_name,
        requestCount: Number(row.request_count),
        successImageCount: Number(row.success_image_count),
        estimatedCost: String(row.estimated_cost),
      })),
      byChannels: byChannels.map((row) => ({
        id: row.id,
        name: row.name,
        attemptCount: Number(row.attempt_count),
        succeededAttemptCount: Number(row.succeeded_attempt_count),
        averageDurationMs: Number(row.average_duration_ms),
        p50DurationMs: Number(row.p50_duration_ms),
        p95DurationMs: Number(row.p95_duration_ms),
      })),
    };
  });
}
