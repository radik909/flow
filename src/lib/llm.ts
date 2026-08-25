import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { LLM_MAX_TOKENS, LLM_MODEL, LLM_TIMEOUT_MS } from "../constants.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required to generate variant content");
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

export class LlmGenerationError extends Error {}

/**
 * Generates static variant copy from a short prompt. Called only from the config API
 * at experiment-creation time (DESIGN.md §7) — never from /assign. Blocking by design
 * for the 24h build: the caller is an admin request, not a page render, so a few extra
 * seconds here is an acceptable trade for not building a job queue.
 *
 * Throws LlmGenerationError on failure/timeout rather than returning a placeholder —
 * per §7, an experiment shouldn't be able to go live with broken variant content. The
 * config API route is responsible for surfacing this as a clear 502 to the operator,
 * who can retry or supply the text by hand.
 */
export async function generateVariantContent(prompt: string): Promise<string> {
  try {
    const response = await getClient().messages.create(
      {
        model: LLM_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: `Write short, punchy marketing copy for an A/B test variant. Return only the copy text, no preamble or quotes.\n\nBrief: ${prompt}`,
          },
        ],
      },
      { timeout: LLM_TIMEOUT_MS },
    );

    const text = response.content.find((block) => block.type === "text");
    if (!text || !text.text.trim()) {
      throw new LlmGenerationError("LLM returned no usable text");
    }
    return text.text.trim();
  } catch (err) {
    if (err instanceof LlmGenerationError) throw err;
    throw new LlmGenerationError(`LLM generation failed: ${(err as Error).message}`);
  }
}
