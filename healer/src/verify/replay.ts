import type { WindowMetrics } from "@nightshift/shared";

export interface ReplayRecord {
  method: string;
  path: string;
  body: unknown;
}

export interface ReplayResult {
  ok: boolean;
  latencyMs: number;
}

export function summarize(results: ReplayResult[]): WindowMetrics {
  const requests = results.length;
  if (requests === 0) {
    return { requests: 0, errorRate: 0, p95LatencyMs: 0 };
  }
  const failures = results.filter((result) => !result.ok).length;
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  return {
    requests,
    errorRate: failures / requests,
    p95LatencyMs: latencies[Math.ceil(requests * 0.95) - 1],
  };
}

export async function replay(
  baseUrl: string,
  records: ReplayRecord[],
  concurrency: number,
): Promise<WindowMetrics> {
  const results: ReplayResult[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < records.length) {
      const record = records[next];
      next += 1;
      const started = Date.now();
      let ok = false;
      try {
        const response = await fetch(`${baseUrl}${record.path}`, {
          method: record.method,
          headers: {
            "content-type": "application/json",
            "x-nightshift-shadow": "1",
          },
          body: record.method === "GET" ? undefined : JSON.stringify(record.body ?? {}),
          signal: AbortSignal.timeout(5000),
        });
        ok = response.ok;
        await response.text();
      } catch {
        ok = false;
      }
      results.push({ ok, latencyMs: Date.now() - started });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, () => worker()));
  return summarize(results);
}
