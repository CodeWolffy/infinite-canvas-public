import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const sqlClient = postgres(config.DATABASE_URL, {
  max: 30,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(sqlClient, { schema });

const serializeTimestamp = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
sqlClient.options.serializers["1114"] = serializeTimestamp;
sqlClient.options.serializers["1184"] = serializeTimestamp;

export async function migrateDatabase() {
  await migrate(db, { migrationsFolder: config.MIGRATIONS_DIR });
}

export async function closeDatabase() {
  await sqlClient.end();
}
