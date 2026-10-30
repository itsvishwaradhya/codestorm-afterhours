import { SERVICE_NAMES } from "@nightshift/shared";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const NUMBER = /\d+(?:\.\d+)?/g;
const MAX_LENGTH = 4000;

export function numbersIn(text: string): number[] {
  return (text.match(NUMBER) ?? []).map(Number);
}

export function validateRewording(draft: string, candidate: string): ValidationResult {
  const text = candidate.trim();
  if (text.length === 0) return { ok: false, reason: "empty reply" };
  if (text.length > MAX_LENGTH) return { ok: false, reason: "reply too long" };

  const allowed = new Set(numbersIn(draft));
  for (const value of numbersIn(text)) {
    if (!allowed.has(value)) {
      return { ok: false, reason: `introduced the number ${value}, which is not in the facts` };
    }
  }

  for (const name of SERVICE_NAMES) {
    if (text.includes(name) && !draft.includes(name)) {
      return { ok: false, reason: `mentions ${name}, which is not in the facts` };
    }
  }

  return { ok: true };
}
