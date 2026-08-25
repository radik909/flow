import { fileURLToPath } from "node:url";
import path from "node:path";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { configCache } from "./lib/config-cache.js";
import { registerAssignRoute } from "./routes/assign.js";
import { registerExperimentRoutes } from "./routes/experiments.js";
import { registerResultsRoute } from "./routes/results.js";
import { registerSiteRoutes } from "./routes/sites.js";
import { registerTrackRoutes } from "./routes/track.js";

export async function buildServer() {
  const app = Fastify({ logger: true });

  // Wide-open CORS: /assign and /track/* are meant to be called from arbitrary
  // customer domains, and the site-key in the payload — not the Origin header — is
  // what scopes the request (DESIGN.md §5). The config API is same-origin/server-side
  // only and relies on bearer auth, not CORS, for protection.
  await app.register(cors, { origin: true });

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  await app.register(staticPlugin, { root: publicDir, prefix: "/" });

  app.get("/health", async (_request, reply) => {
    // Deliberately does not check Postgres — a DB outage must not affect health
    // checks that gate traffic to the assignment path (DESIGN.md §4).
    return reply.send({ ok: true, configCacheStale: configCache.isStale(config.configMaxStaleMs) });
  });

  registerAssignRoute(app);
  registerTrackRoutes(app);
  registerExperimentRoutes(app);
  registerSiteRoutes(app);
  registerResultsRoute(app);

  // Prime the cache before accepting traffic, then keep it refreshed on a timer
  // (DESIGN.md §1, §3). A failed initial load isn't fatal — refresh() already
  // swallows errors and /assign fails open to "no experiments" on an empty cache.
  await configCache.refresh(db, app.log);
  configCache.startPolling(db, app.log, config.configPollIntervalMs);

  return app;
}
