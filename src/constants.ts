// Fixed business/algorithmic constants — values that define how the system behaves,
// not deployment-specific settings. Those live in src/config.ts (env-derived) instead.
// Numerical-method-specific magic numbers (e.g. the Abramowitz–Stegun / Lanczos
// coefficients in src/lib/stats.ts) stay next to the formulas that use them rather
// than moving here — they're not tunable, they're literally what defines the formula.

// Allocation space for bucket hashing (DESIGN.md §2). Fine-grained enough for splits
// like 1/9999 without meaningful rounding error, coarse enough that range math stays
// in plain integers.
export const BUCKET_SPACE = 10_000;

// Below this many exposures for a variant, the results endpoint flags the sample as
// too small to trust a significance claim (DESIGN.md §6).
export const MIN_SAMPLE_SIZE = 100;

// Conventional p-value cutoff for the Sample Ratio Mismatch check (DESIGN.md §6) —
// tighter than the usual 0.05 because SRM is an integrity alarm, not a hypothesis test;
// false positives here would make operators distrust every experiment.
export const SRM_P_THRESHOLD = 0.001;

// Conventional p-value cutoff for "variant beats control" in the two-proportion z-test.
// Not corrected for multiple comparisons across >2 variants — see the
// multipleComparisonsWarning built alongside it in the results route (DESIGN.md §6).
export const SIGNIFICANCE_THRESHOLD = 0.05;

// LLM generation (DESIGN.md §7) — used only by the config API at experiment-creation
// time, never on the /assign hot path.
export const LLM_MODEL = "claude-sonnet-5";
export const LLM_MAX_TOKENS = 200;
export const LLM_TIMEOUT_MS = 15_000;
