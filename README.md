# Experiment Assignment Service — Design Document

### Out of scope:

Due to time restrictions & personal availability

- Cookie(first/third party), localStorage/sessionStorage & limitations.
- Browser side UUID for identifying a user: Same user(auth) in different devices/browser(or incognito) are identified as different users.
- GDPR/CCPA: Even a random UUID used to single out a browser over time is personal data under GDPR, and an experimentation cookie is not "strictly necessary" under ePrivacy.
- Syncing the changes in config: Polling the changes in regular interval or a service worker in the background
- Error recovery mechanism for Tracking (since it's fire & forget event)
- DB backups & config backups and error recovery mechanism if the service is down

### Assumptions:

To avoid additional time consumption for the initial assignment.

- There will not be 1000's of experiments: To keep network bandwidth & size of the script minimal to adhere to the "fast" in the requirement
- The details of the experiment in the script will be publicly visible to anyone who visits the site. So anything related to security is moved out of the scope.
- Config changes are append-safe. So that the below architecture adheres to the requirement.

## 1. Architecture

Three concerns, deliberately decoupled, because they have opposite performance profiles:

| Concern                           | Read/Write                     | Latency budget                | Consistency need                                 |
| --------------------------------- | ------------------------------ | ----------------------------- | ------------------------------------------------ |
| Assignment                        | Read-heavy, on every page load | <10ms, no network hop ideally | Must be deterministic, can tolerate stale config |
| Tracking (exposure/conversion)    | Write-heavy                    | Fire-and-forget, can be async | Must be durable, dedup-safe                      |
| Config (experiment/variant setup) | Read-mostly, rarely written    | Not latency-sensitive         | Source of truth                                  |

```
Browser (JS snippet)
  ├─ GET /assign?visitor=X&experiments=a,b   → Assignment Service (stateless, in-memory config)
  │     one round trip for ALL active experiments on the page, not one call each
  ├─ POST /track/exposure                    → fired AFTER the variant is applied to the DOM
  └─ POST /track/conversion                  → Tracking Service → durable store (async)

Config API (CRUD experiments/variants) → Postgres (source of truth)
Assignment Service instances poll → refresh in-memory config cache every N seconds
```

The key move: **the assignment service holds a full copy of experiment config in memory** and computes assignment as a pure function. It never touches a database on the hot path. This is what makes it fast and fail-safe simultaneously — those aren't separate problems, they're the same problem.

**Fleet staleness window.** Each instance polls and refreshes independently, so for up to one poll interval after a config change, different instances can be serving different config versions — a visitor could in principle see a different variant depending on which instance handled the request during that window. This is an accepted, bounded inconsistency (§ Determinism's config-version rule keeps it from corrupting stickiness — see below), not an oversight: it trades a few seconds of fleet-wide propagation lag for zero coordination overhead on the hot path. It would matter if config needed sub-second propagation; it doesn't.

**Assignment ≠ exposure.** These are deliberately two moments, not one. `/assign` tells the snippet which variant to render; the snippet fires the exposure event only _after_ it has actually applied the variant to the page. If exposure were logged server-side at assignment time, every visitor who was assigned but bounced before render (or hit an experiment on a page element below the fold that never mounted) would dilute the denominator of the conversion rate. Logging exposure at render time keeps the reported population equal to the population that actually experienced the treatment.

**Visitor identity.** Determinism is only as stable as `visitor_id`, so it needs to be explicit: the JS snippet generates a UUID on first visit and persists it in a first-party cookie (with localStorage as fallback), scoped to the customer's domain. Known limitations, accepted deliberately: the same person on two devices or after clearing cookies is two visitors; Safari ITP caps script-set cookie lifetimes. These are the standard trade-offs of anonymous web experimentation — the alternative (server-set cookies or a customer-supplied stable user ID) is offered as an optional input (`visitor_id` can be passed in by the customer's own auth system) but not required.

## 2. Determinism

Assignment is computed, not stored:

```
bucket = hash(visitor_id + ":" + experiment_id + ":" + experiment_salt) mod 10000
variant = the variant whose cumulative allocation range contains `bucket`
```

- Use a well-distributed hash (SHA-256 truncated, or MurmurHash3 — not needed cryptographically, just uniform). Same visitor + same experiment + same salt → same bucket, forever, regardless of restarts, regardless of which instance serves the request.
- Allocation is expressed as cumulative ranges over 0–9999 (e.g., control: 0–4999, variant_b: 5000–8999, holdback: 9000–9999). A visitor falls into exactly one range. This is standard consistent-hashing-style bucketing, and it has a nice property _if_ one specific invariant holds: **existing ranges are never renumbered, only grown or shrunk from their own edges.** Ramping variant_b from 10% to 50% by extending its range (5000–8999 → 5000–8999 ∪ new space taken from holdback/control) only flips the visitors who fall in the newly-reassigned sub-range — everyone else's bucket number is unchanged, so they stay put. This is what "only visitors near the boundary flip" actually depends on, and it's worth stating precisely because the naive version of this idea breaks under a case that looks superficially similar:
  - **Adding a variant is not the same operation as ramping one.** Going from 2 variants (control 0–4999, b 5000–9999) to 3 evenly-split variants (control 0–3332, b 3333–6665, c 6666–9999) recomputes every boundary — the majority of visitors who were in `b` get renumbered into `control` or `c`. That's a full reshuffle, not a boundary flip, and it silently breaks stickiness for anyone whose bucket falls after the first moved boundary.
  - The rule this system enforces: a **new variant may only carve its range out of currently-unallocated space** (an explicit holdback/undecided range reserved at experiment creation) or out of one existing variant's range from that variant's own edge inward. It may never cause an existing variant's range to move without also being resized. If a config change would require renumbering ranges that aren't the one being resized, it's rejected — the operator must instead create a new experiment (new salt), which is a clean version bump rather than a silent reshuffle.
- The experiment's `salt` (usually just its own ID) ensures a visitor's bucket in experiment A is statistically independent of their bucket in experiment B — no correlation between which variants they land in across experiments.
- No per-visitor assignment table is required for correctness. This is the part I want to flag as a real design decision, not an oversight: storing "visitor X got variant Y" in a table feels intuitive but it's redundant work — it's a write on every unique visitor's first request, on the critical path, protecting against a failure mode (the hash function producing a different answer) that a pure function doesn't have. We do still log the _exposure event_ for tracking/reporting, but that's decoupled and non-blocking (see below).
- Config **version** matters: any change that isn't a pure edge-resize under the rule above (new variant count, salt change, reordering) must be a new `version` of the experiment (in practice, a new experiment ID / new salt). I'd store a config `version` field and refuse to mutate live allocation ranges in place in any way that violates the invariant above — only edge-resizes and brand-new experiments are hot-swappable without care.

## 3. Scale

- **Assignment**: pure CPU + memory lookup. Trivially horizontally scalable — every instance is stateless and interchangeable. At millions of calls/day this is a non-issue; the real ceiling is network/instance count, not compute. This could even be pushed to an edge function (Cloudflare Workers/Vercel Edge) since it needs no DB connection per request — that's a "next steps" item, not core.
- **Config propagation**: experiments are few (dozens to low hundreds, not millions), so "poll Postgres every 5–10s and swap an in-memory map" is sufficient. No need for Kafka/pub-sub at this scale. I'd only reach for push-based invalidation (Redis pub/sub) if config needed to propagate in under a second, which it doesn't — a new experiment being live 5s later than the API call is fine.
- **Tracking writes are the actual bottleneck** at scale, not assignment. Millions of exposure events/day means write-heavy load on whatever durable store holds them. Mitigations, roughly in order I'd reach for them:
  1. Batch client-side sends aren't realistic (fire-and-forget single events from browsers), so batch server-side: buffer incoming events briefly and bulk-insert.
  2. Partition/index the events table by experiment_id + day for cheap aggregation later.
  3. At real scale, decouple ingestion from storage with a queue (SQS/Kinesis/Kafka) so the tracking endpoint just enqueues and returns — but for this build I'll do direct-but-batched writes to Postgres and call out the queue as the next step.
- **Reporting**: never compute conversion rates by scanning raw events on every dashboard load. Pre-aggregate into a rollup table (exposures/conversions per experiment/variant/day), refreshed on a schedule or incrementally. Dashboard reads the rollup, not the event log.

## 4. Reliability & failure modes

This is the part I'd weight heaviest, since the prompt is explicit that this sits on the render path.

**Principle: fail open, always return a variant, never block or error the page.**

- Config cache empty (cold start) or refresh failing → serve last-known-good config; if there's truly no config yet, return the designated default/control variant rather than erroring.
- Storage (Postgres) down → assignment is unaffected, since it doesn't read storage per-request. Tracking writes queue in-memory, bounded to a fixed size and age (e.g. 10k events or 60s, whichever hits first); once the bound is exceeded, new events are dropped and a counter is incremented rather than growing the queue unboundedly. This is a per-instance buffer with no cross-instance coordination, so a longer outage loses events proportional to however many instances were absorbing writes during it — that's the accepted trade, made explicit rather than left implicit: better to lose some exposure events than to hang a page load, crash, or OOM an instance holding an unbounded queue.
- Assignment endpoint itself has a hard timeout budget (e.g. 50ms) enforced by the client SDK/snippet: if the call doesn't return in time, the snippet falls back to the control variant locally. This means even a total service outage degrades to "everyone sees control," not a broken page. **This fail-open behavior is shipped inside the JS snippet itself, not left as an integration requirement** — a customer dropping in the snippet gets the timeout/fallback for free, rather than needing to implement it correctly on their own. Making this an opt-in customer responsibility would mean the failure mode of the whole design depends on every integrator getting it right, which defeats the point.
- No single request to the assignment service should ever be able to 500 due to a downstream dependency, because it has no required downstream dependency at request time.
- **Observability, minimally**: the failure modes above (dropped tracking events, rate-limited keys, config refresh failures) are only useful as design decisions if they're visible when they happen. For the 24h build this means structured logs with counters for each of those three events, scraped or just grepped from logs — not a full metrics stack. Real dashboards/alerting on these counters is a named next step, not built now.

## 5. Multi-tenancy, auth, and abuse surface

These endpoints are called from browsers on arbitrary customer websites, which shapes the security model more than it first appears:

- **Two trust tiers.** The browser-facing endpoints (`/assign`, `/track/*`) carry a per-site **public key** (like an analytics write key) — it identifies _which customer site_ the traffic belongs to, scopes experiments and events to that site, and lets us set CORS `Access-Control-Allow-Origin` per site. It is not a secret; anything shipped to a browser is public by definition, so these endpoints must be safe under the assumption that anyone can call them.
- **The config API is a different animal.** It mutates experiments and — importantly — can trigger LLM generation, i.e., it spends money. It gets real authentication (bearer token per customer account), is never called from the browser snippet, and is rate-limited. An unauthenticated config API on this system means anyone on the internet can burn your LLM budget; that's the specific scenario the split exists to prevent.
- **What the public endpoints can and can't be abused for.** Worst case with a stolen public key is event pollution (junk exposures/conversions skewing a customer's stats) — mitigated with per-key rate limiting and, as a next step, basic bot filtering. They cannot leak other customers' data (all queries scoped by site key) and cannot spend LLM money.
- For the 24h build: token auth on the config API and site-key scoping on the public endpoints get implemented; per-key rate limiting gets a middleware stub and a paragraph here; bot filtering is named as future work.

## 6. Correctness (tracking & reporting)

- **Idempotent exposure**: unique constraint on `(visitor_id, experiment_id, variant_id)` for the "first exposure" record — duplicate calls no-op rather than double-count. Crucially this must survive batching: bulk inserts use `INSERT ... ON CONFLICT DO NOTHING`, so idempotency is enforced by the database constraint itself, not by application logic that a batch path could bypass. Separately, I'd keep a raw append-only event log (unconstrained) for debugging/audit, but all _reported_ metrics come from the deduped view.
- **Conversion**: similarly deduped per `(visitor_id, experiment_id, goal_id)` for "did this visitor convert" (binary), which is what conversion-rate math needs. If revenue/count metrics are wanted later, that's a separate non-deduped sum — worth noting as a distinction in the doc rather than conflating the two.
- **Orphaned conversions**: because exposure is logged client-side after render (not server-side at assignment time — see Architecture), a conversion event can arrive for a visitor who has no corresponding exposure row (script blocked, tab closed before the exposure fired, network drop). The reporting query's denominator is the deduped exposure count, and a conversion is only counted toward a variant's numerator if a matching exposure row exists for that `(visitor_id, experiment_id)` — a conversion with no matching exposure is logged (for audit) but excluded from the reported rate. Without this join, orphaned conversions would inflate the numerator without a matching denominator entry and bias every rate upward.
- **Statistical reporting**: conversion rate per variant plus a basic two-proportion z-test / confidence interval against control, and a minimum-sample-size warning so the dashboard doesn't imply significance on 40 visitors. With more than one non-control variant, each gets its own z-test against control, which means the reported "significant" flags are subject to the standard multiple-comparisons inflation (more pairwise tests, higher chance one shows p < 0.05 by chance); I'd flag this on the dashboard next to the significance indicator rather than silently apply a correction (e.g. Bonferroni) that most readers won't expect. I will _not_ build sequential-testing correction (peeking protection) in the 24h window — I'll name it explicitly as a known gap, since teams that check dashboards daily without correction do inflate false-positive rates, and that's worth being honest about rather than silently omitting.
- **Sample Ratio Mismatch (SRM) check**: the dashboard runs a chi-squared goodness-of-fit test comparing observed exposure counts per variant against the configured allocation, and flags the experiment if the deviation is improbable (p < 0.001 is the conventional threshold). This is a few lines of code and it's the cheapest possible end-to-end integrity check on the whole system: if hashing, config propagation, snippet behavior, and tracking are all correct, observed traffic matches the configured split; if any of them is broken (a redirect dropping one variant's exposures, a caching bug, a biased hash), SRM catches it before anyone trusts a misleading "winner." Real experimentation platforms treat SRM as a first-class alarm, and results from an SRM-flagged experiment should not be trusted regardless of how significant they look.

## 7. The LLM decision

Constraint: assignment must stay off any slow path. So the LLM call cannot run during `/assign`.

Decision: **generate LLM variant content ahead of time, at experiment-configuration time, not at request time.** When someone defines an experiment with an LLM-generated variant (e.g. "generate a headline for X"), that generation happens once, synchronously in the config API (which isn't latency-sensitive — it's an admin action), and the result is stored as static content on the variant, versioned like any other config.

Concretely: `POST /experiments` with a variant marked `generate: true` blocks on the LLM call before returning — this is a deliberate simplification for the 24h build (no job queue, no polling endpoint, no "generation pending" UI state). It's acceptable because the caller is an admin creating an experiment, not a page render, so a few extra seconds on that one request is a fair trade for the simplicity. If the call fails or times out, the create request fails with a clear error and a suggested static fallback string, rather than silently creating an experiment with empty/placeholder variant content — an experiment shouldn't be able to go live with a broken variant. The operator can retry generation or supply the text by hand. At real scale, or if generation latency grows (larger prompts, slower model), this moves to async-with-status (create the experiment in a `pending` state, generate in the background, flip to `active` on success) — named here as the next step rather than built now.

At assignment/render time, the LLM-generated variant is just... a string sitting in the config cache. Identical cost profile to a hand-written variant. No runtime LLM call, no runtime failure mode, no runtime cost per page view.

If true per-visitor personalization is wanted later (not just "one generated variant shown to everyone in the bucket"), that's a materially harder problem — I'd handle it as: assignment returns instantly with a cached default, a background job generates personalized content keyed by visitor+experiment on first exposure, and subsequent visits serve the cached result (cache-aside). I'll scope this out of the 24h build and describe it in trade-offs, since it roughly doubles the system's complexity (needs a job queue, a cache-miss fallback UX, and per-visitor storage growth) for a feature the prompt doesn't strictly require.

Either way: LLM failures during generation fall back to a static default variant string, with retry/backoff for the background/admin path — never surfaced to a page render.

## 8. Trade-offs and what I'm actually building in 24h

**Building:**

- Assignment service: stateless, hash-bucket based, in-memory config, fail-open defaults.
- Config API: CRUD for experiments/variants/allocations, Postgres-backed, includes the "generate LLM variant" action at creation time.
- Tracking endpoints: exposure + conversion, idempotent via unique constraints, direct-but-simple writes to Postgres.
- Results endpoint/dashboard: per-experiment/variant exposures, conversions, rate, significance indicator, and the SRM check. At demo scale this is a plain indexed aggregate query over the deduped tables — simple and defensible; the rollup/materialized-view layer is described in Scale as the step you take when the event table gets large, not built preemptively.
- One real LLM-generated variant end to end, generated at config time, cached, with a fallback default.
- Auth split: bearer-token auth on the config API, site-key scoping + CORS on the public endpoints.

**Explicitly not building, and why:**

- Queue-based ingestion (Kafka/SQS) — not needed at demo scale; named as the first thing to add before real production traffic.
- Edge-deployed assignment — same computation, just a deployment topology change; not worth the setup time for a take-home, but I'll note it since it's the natural evolution of "assignment is a pure function."
- Mutual exclusion / experiment layers (preventing a visitor from being in two conflicting experiments at once) — real feature, real complexity, out of scope.
- Sequential testing / peeking correction on the stats — flagged as a known limitation rather than silently absent.
- Per-visitor LLM personalization — described above, deliberately scoped out.
- Admin UI beyond minimal JSON forms or a thin HTML page — API-first, UI is a nice-to-have per the prompt.

---

## 9. Stack and delivery decisions

- **Stack**: Node/TypeScript + Postgres, hosted on Fly.io or Railway. Reasoning: fast to stand up within the 24h window, Postgres unique constraints carry real correctness weight (§ Correctness), and nothing about this design needs a more specialized store — assignment never hits the DB on the hot path, so the DB choice is about durability and constraint support, not raw throughput.
- **LLM provider**: called directly server-side (Anthropic API), key held only in the config API's environment, never exposed to the browser or the assignment path. Not abstracted behind a provider-agnostic interface — that abstraction is real work with no payoff inside this scope (one call site, one provider, generation happens once at config time per §7), and adding it now would be speculative generality against a requirement that doesn't ask for multi-provider support.
- **Delivery order**: build the core locally first, deploy once the shape (assignment, tracking, config, LLM call, results) is working end to end — deploying early would burn setup time against a moving target and doesn't de-risk anything specific to this design, since the architecture doesn't depend on the hosting choice to be validated.
