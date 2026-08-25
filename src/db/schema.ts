import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// A customer site. The `key` is the public, browser-facing identifier (DESIGN.md §5:
// not a secret, scopes /assign and /track/* traffic and CORS to this site).
export const sites = pgTable("sites", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One experiment. `salt` is what the bucket hash is keyed on (defaults to id).
// Changing salt is how the design forces a clean version bump (DESIGN.md §2) instead
// of silently reshuffling an existing experiment's assignments.
export const experiments = pgTable("experiments", {
  id: text("id").primaryKey(),
  siteKey: text("site_key")
    .notNull()
    .references(() => sites.key),
  name: text("name").notNull(),
  salt: text("salt").notNull(),
  status: text("status").notNull().default("active"), // active | paused | archived
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A variant's allocation is a half-open-in-spirit inclusive range over [0, 9999].
// The reallocation invariant in DESIGN.md §2 (edge-resize only, never renumber) is
// enforced in application code at write time, not by a DB constraint — Postgres can't
// express "this range change didn't move anyone else's boundary."
export const variants = pgTable("variants", {
  id: text("id").notNull(),
  experimentId: text("experiment_id")
    .notNull()
    .references(() => experiments.id),
  name: text("name").notNull(),
  rangeStart: integer("range_start").notNull(),
  rangeEnd: integer("range_end").notNull(),
  isControl: boolean("is_control").notNull().default(false),
  // Static content served to the snippet — hand-written or LLM-generated at config
  // time (DESIGN.md §7). Never regenerated on the assignment path.
  content: jsonb("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.experimentId, t.id] }),
}));

// Deduped "first exposure" record — the source of truth for reporting denominators.
// One row per (visitor, experiment): a visitor's variant is deterministic, so there's
// never a legitimate second variant to record (DESIGN.md §6).
export const exposures = pgTable("exposures", {
  visitorId: text("visitor_id").notNull(),
  experimentId: text("experiment_id").notNull(),
  variantId: text("variant_id").notNull(),
  siteKey: text("site_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.visitorId, t.experimentId] }),
}));

// Deduped conversion record — one row per (visitor, experiment, goal). Binary "did
// this visitor convert," which is what conversion-rate math needs (DESIGN.md §6).
export const conversions = pgTable("conversions", {
  visitorId: text("visitor_id").notNull(),
  experimentId: text("experiment_id").notNull(),
  goalId: text("goal_id").notNull(),
  siteKey: text("site_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.visitorId, t.experimentId, t.goalId] }),
}));

// Raw, unconstrained append-only log of every tracking call received, duplicates
// included. Kept for audit/debugging only — all reported metrics come from the
// deduped exposures/conversions tables above (DESIGN.md §6).
export const rawEvents = pgTable("raw_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  kind: text("kind").notNull(), // "exposure" | "conversion"
  visitorId: text("visitor_id").notNull(),
  experimentId: text("experiment_id").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
