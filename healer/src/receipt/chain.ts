import type { ReceiptFacts } from "./facts.js";
import { validateRewording } from "./validate.js";

export interface LlmProvider {
  id: string;
  complete: (system: string, user: string, signal: AbortSignal) => Promise<string>;
}

export interface ChainOptions {
  perProviderMs: number;
  totalMs: number;
  log?: (message: string) => void;
}

export interface Rewording {
  text: string;
  wordedBy: string;
}

export const SYSTEM_PROMPT = [
  "You rewrite incident receipts for an engineering audience.",
  "Rewrite the draft in clear, plain English with short paragraphs.",
  "Keep every number, percentage and service name exactly as given.",
  "Do not add facts, do not change the outcome, and do not choose or recommend fixes.",
  "Reply with the rewritten receipt only.",
].join(" ");

export function buildUserPrompt(facts: ReceiptFacts, draft: string): string {
  return `Facts (JSON):\n${JSON.stringify(facts)}\n\nDraft receipt:\n${draft}`;
}

export async function rewordReceipt(
  facts: ReceiptFacts,
  draft: string,
  providers: LlmProvider[],
  options: ChainOptions,
): Promise<Rewording> {
  const log = options.log ?? (() => undefined);
  const deadline = Date.now() + options.totalMs;
  const user = buildUserPrompt(facts, draft);

  for (const provider of providers) {
    const remaining = Math.min(options.perProviderMs, deadline - Date.now());
    if (remaining <= 0) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const raw = await provider.complete(SYSTEM_PROMPT, user, controller.signal);
      const check = validateRewording(draft, raw);
      if (check.ok) {
        return { text: raw.trim(), wordedBy: provider.id };
      }
      log(`[receipt] ${provider.id} reply rejected: ${check.reason}`);
    } catch (error) {
      log(`[receipt] ${provider.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { text: draft, wordedBy: "template" };
}
