import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const connectionString = config.databaseUrl;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

// A pooled connection is fine here: the only things that ever touch Postgres are the
// config API, tracking writes, and results reads — never the /assign hot path
// (DESIGN.md §1, §4).
export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });
