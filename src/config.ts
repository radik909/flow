// Env-derived runtime configuration, read and parsed once at import time. Centralizing
// this fixes a real inconsistency: CONFIG_MAX_STALE_MS's default used to be hardcoded
// separately in both server.ts and assign.ts, which could silently drift if only one
// was ever updated.
//
// Import order matters: this reads process.env at module-evaluation time, so whatever
// loads dotenv (currently `import "dotenv/config"`, first line of src/index.ts) must
// run before anything imports this module — standard ESM eval order guarantees that
// as long as the dotenv import stays first in index.ts.

function parseTokens(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",

  databaseUrl: process.env.DATABASE_URL,

  // How often each instance polls Postgres and swaps its in-memory config cache
  // (DESIGN.md §1, §3).
  configPollIntervalMs: Number(process.env.CONFIG_POLL_INTERVAL_MS ?? 7000),
  // How long /assign will keep serving a config snapshot before /health reports it
  // stale (DESIGN.md §4) — assignment itself still serves it either way; this is a
  // visibility signal, not a circuit breaker.
  configMaxStaleMs: Number(process.env.CONFIG_MAX_STALE_MS ?? 120_000),

  // Bearer tokens accepted by the config API (DESIGN.md §5). Never used by the public,
  // browser-facing endpoints — those are scoped by per-site key instead.
  configApiTokens: parseTokens(process.env.CONFIG_API_TOKENS),

  // Read lazily by src/lib/llm.ts on first use, not here — generation should only fail
  // when something actually tries to generate content, not at process start for routes
  // that never touch the LLM (DESIGN.md §7).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
} as const;
