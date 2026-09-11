import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../src/db/schema.ts";

// Production uses postgres-js, whose raw execute result is the row array.
function postgresResults(database) {
  const execute = database.execute.bind(database);
  const transaction = database.transaction.bind(database);
  database.execute = async (...args) => (await execute(...args)).rows;
  database.transaction = (action, ...args) => transaction((tx) => action(postgresResults(tx)), ...args);
  return database;
}

export async function createTestDatabase({ beforeMigration } = {}) {
  const client = new PGlite();
  try {
    const journal = JSON.parse(await readFile(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    for (const { tag } of journal.entries) {
      await beforeMigration?.(client, tag);
      const migration = await readFile(new URL(`../../drizzle/${tag}.sql`, import.meta.url), "utf8");
      // gen_random_uuid is built into PostgreSQL; PGlite does not need the pgcrypto extension.
      await client.exec(migration.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
    }
    return { client, db: postgresResults(drizzle(client, { schema })) };
  } catch (error) {
    await client.close();
    throw error;
  }
}
