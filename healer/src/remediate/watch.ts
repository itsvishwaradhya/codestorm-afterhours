export interface WatchTotals {
  requests: number;
  errors: number;
  healthy: boolean;
}

export interface WatchOptions {
  readTotals: () => Promise<WatchTotals | null>;
  preFixErrorRate: number;
  durationMs: number;
  intervalMs: number;
  minRequests: number;
  minErrorRate: number;
  consecutive: number;
  sleep: (ms: number) => Promise<void>;
}

function isBreach(current: WatchTotals | null, base: WatchTotals, options: WatchOptions): boolean {
  if (!current || !current.healthy) return true;
  const requests = current.requests - base.requests;
  const errors = current.errors - base.errors;
  if (requests < options.minRequests) return false;
  const rate = errors / requests;
  return rate >= options.minErrorRate && rate > options.preFixErrorRate;
}

export async function watchService(options: WatchOptions): Promise<"ok" | "regressed"> {
  const base = (await options.readTotals()) ?? { requests: 0, errors: 0, healthy: false };
  const checks = Math.ceil(options.durationMs / options.intervalMs);
  let breaches = 0;
  for (let i = 0; i < checks; i += 1) {
    await options.sleep(options.intervalMs);
    const current = await options.readTotals();
    breaches = isBreach(current, base, options) ? breaches + 1 : 0;
    if (breaches >= options.consecutive) return "regressed";
  }
  return "ok";
}
