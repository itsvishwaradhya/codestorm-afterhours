export const MASKED = "[masked]";

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "cardnumber",
  "cvv",
  "email",
  "authorization",
  "cookie",
  "x-api-key",
]);

function maskPrimitive(value: unknown): unknown {
  if (typeof value === "string") return MASKED;
  if (typeof value === "number") return 0;
  if (typeof value === "boolean") return false;
  return value;
}

function maskAll(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAll);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, maskAll(child)]));
  }
  return maskPrimitive(value);
}

export function maskDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? maskAll(child) : maskDeep(child),
      ]),
    );
  }
  return value;
}

export function maskHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return maskDeep(headers) as Record<string, unknown>;
}
