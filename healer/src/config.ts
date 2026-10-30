export const config = {
  healerPort: Number(process.env.HEALER_PORT ?? 4000),
  healerUrl: process.env.HEALER_URL ?? `http://localhost:${process.env.HEALER_PORT ?? 4000}`,
  collectIntervalMs: 2000,
  readyTimeoutMs: 30_000,
  clearTicksToClose: 1,
  captureCapBytes: 5 * 1024 * 1024,
  captureCapDocs: 10_000,
  snapshotTtlSeconds: 24 * 60 * 60,
  detector: {
    errorRate: 0.05,
    minRequests: 5,
    p95LatencyMs: 1000,
    memoryMb: 250,
    consecutiveSamples: 2,
  },
} as const;
