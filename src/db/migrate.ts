import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { config } from "../config.js";

// Run as a one-shot process (locally, or as the fly.toml release_command) so
// migrations apply once, before new instances take traffic.
const pool = new Pool({ connectionString: config.databaseUrl });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: "./migrations" });
await pool.end();
console.log("migrations applied");
