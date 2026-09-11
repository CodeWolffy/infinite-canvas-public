import { closeDatabase, migrateDatabase } from "./db/client.js";

try {
  await migrateDatabase();
} finally {
  await closeDatabase();
}
