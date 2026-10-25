import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join } from "node:path";
import { submissions } from "./schema.ts";

// Operator-only command. No wallet initialization, migrations, or public read endpoint.
const database = new Database(join(process.env.DATA_DIR ?? "./data", "app.sqlite"), { readonly: true });
try {
  const rows = drizzle(database).select().from(submissions).orderBy(submissions.createdAt, submissions.id).all();
  console.log(JSON.stringify(rows, null, 2));
} finally {
  database.close();
}
