import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

/**
 * Bearer-token check for the config API only (DESIGN.md §5). Deliberately separate
 * from site-key scoping used by /assign and /track/* — those are public by design,
 * this is not: the config API can mutate live experiments and trigger LLM spend.
 */
export function requireConfigAuth(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
  const header = request.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!provided || config.configApiTokens.length === 0 || !config.configApiTokens.includes(provided)) {
    reply.code(401).send({ error: "unauthorized" });
    return done(new Error("unauthorized"));
  }
  done();
}
