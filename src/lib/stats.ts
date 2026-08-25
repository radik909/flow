// Statistical helpers for the results endpoint. Deliberately simple — DESIGN.md §6
// names what's NOT here: sequential-testing/peeking correction, and a multiple-
// comparisons correction across >2 variants. Both are flagged in the response instead
// of silently applied or silently missing.

import { SRM_P_THRESHOLD } from "../constants.js";

/** Two-proportion z-test, variant vs. control. Returns null if either sample is empty. */
export function twoProportionZTest(
  controlConversions: number,
  controlExposures: number,
  variantConversions: number,
  variantExposures: number,
): { z: number; pValue: number } | null {
  if (controlExposures === 0 || variantExposures === 0) return null;

  const p1 = controlConversions / controlExposures;
  const p2 = variantConversions / variantExposures;
  const pooled = (controlConversions + variantConversions) / (controlExposures + variantExposures);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / controlExposures + 1 / variantExposures));
  if (se === 0) return null;

  const z = (p2 - p1) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue };
}

/**
 * Sample Ratio Mismatch check (DESIGN.md §6): compares observed exposure counts per
 * variant against the configured allocation via a chi-squared goodness-of-fit test.
 * A low p-value means observed traffic doesn't match the configured split — a strong
 * signal something upstream (hashing, config propagation, snippet, tracking) is broken,
 * independent of whatever the conversion-rate numbers claim.
 */
export function srmCheck(
  observed: { variantId: string; exposures: number; expectedShare: number }[],
): { chiSquared: number; pValue: number; flagged: boolean } {
  const total = observed.reduce((sum, o) => sum + o.exposures, 0);
  if (total === 0) return { chiSquared: 0, pValue: 1, flagged: false };

  let chiSquared = 0;
  for (const o of observed) {
    const expected = total * o.expectedShare;
    if (expected === 0) continue;
    chiSquared += (o.exposures - expected) ** 2 / expected;
  }

  const degreesOfFreedom = observed.length - 1;
  const pValue = chiSquaredSurvival(chiSquared, degreesOfFreedom);
  return { chiSquared, pValue, flagged: pValue < SRM_P_THRESHOLD };
}

// --- Numerical helpers (no external stats library — this is intentionally small) ---

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26 approximation, ~1e-7 max error — plenty for a
  // significance indicator, not a claim of research-grade precision.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** P(X > chiSquared) for a chi-squared distribution with `df` degrees of freedom. */
function chiSquaredSurvival(chiSquared: number, df: number): number {
  if (df <= 0) return 1;
  // Regularized upper incomplete gamma function Q(df/2, chiSquared/2).
  return upperIncompleteGammaQ(df / 2, chiSquared / 2);
}

function upperIncompleteGammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return 1;
  if (x === 0) return 1;
  // Series/continued-fraction split, standard numerical-recipes approach.
  if (x < a + 1) {
    return 1 - lowerIncompleteGammaSeries(a, x);
  }
  return upperIncompleteGammaContinuedFraction(a, x);
}

function lowerIncompleteGammaSeries(a: number, x: number): number {
  let sum = 1 / a;
  let term = sum;
  for (let n = 1; n < 200; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function upperIncompleteGammaContinuedFraction(a: number, x: number): number {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function logGamma(x: number): number {
  // Lanczos approximation.
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = coefficients[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += coefficients[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
