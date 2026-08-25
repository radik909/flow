import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import type { db as DbType } from "../db/client.js";
import { experiments, variants } from "../db/schema.js";

export interface CachedVariant {
  id: string;
  name: string;
  rangeStart: number;
  rangeEnd: number;
  isControl: boolean;
  content: unknown;
}

export interface CachedExperiment {
  id: string;
  salt: string;
  variants: CachedVariant[];
}

type BySite = Map<string, CachedExperiment[]>;

/**
 * Holds a full copy of active experiment config in memory, per DESIGN.md §1: the
 * assignment path reads only this, never Postgres. Refreshed on a timer; on refresh
 * failure it keeps serving the last-known-good snapshot rather than throwing, which is
 * what makes a Postgres outage invisible to /assign (DESIGN.md §4).
 */
export class ConfigCache {
  private bySite: BySite = new Map();
  private lastGoodAt: number | null = null;

  getExperiments(siteKey: string): CachedExperiment[] {
    return this.bySite.get(siteKey) ?? [];
  }

  isStale(maxAgeMs: number): boolean {
    return this.lastGoodAt === null || Date.now() - this.lastGoodAt > maxAgeMs;
  }

  private set(next: BySite): void {
    this.bySite = next;
    this.lastGoodAt = Date.now();
  }

  async refresh(db: typeof DbType, log: FastifyBaseLogger): Promise<void> {
    try {
      const rows = await db
        .select({
          siteKey: experiments.siteKey,
          experimentId: experiments.id,
          salt: experiments.salt,
          variantId: variants.id,
          variantName: variants.name,
          rangeStart: variants.rangeStart,
          rangeEnd: variants.rangeEnd,
          isControl: variants.isControl,
          content: variants.content,
        })
        .from(experiments)
        .innerJoin(variants, eq(variants.experimentId, experiments.id))
        .where(eq(experiments.status, "active"));

      const next: BySite = new Map();
      for (const row of rows) {
        const bucket = next.get(row.siteKey) ?? [];
        let exp = bucket.find((e) => e.id === row.experimentId);
        if (!exp) {
          exp = { id: row.experimentId, salt: row.salt, variants: [] };
          bucket.push(exp);
        }
        exp.variants.push({
          id: row.variantId,
          name: row.variantName,
          rangeStart: row.rangeStart,
          rangeEnd: row.rangeEnd,
          isControl: row.isControl,
          content: row.content,
        });
        next.set(row.siteKey, bucket);
      }

      this.set(next);
    } catch (err) {
      // Deliberately swallowed: a failed refresh must never crash the process or clear
      // the cache. We keep serving whatever config we last had (DESIGN.md §4).
      log.error({ err }, "config cache refresh failed; serving last-known-good config");
    }
  }

  startPolling(db: typeof DbType, log: FastifyBaseLogger, intervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.refresh(db, log);
    }, intervalMs);
    return () => clearInterval(timer);
  }
}

export const configCache = new ConfigCache();
