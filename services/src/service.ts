import { randomUUID } from "node:crypto";
import express from "express";
import {
  FAULT_TYPES,
  GRAY_MODES,
  SERVICE_NAMES,
  SERVICE_PORTS,
  maskDeep,
  maskHeaders,
  type FaultType,
  type GrayFault,
  type GrayMode,
  type ServiceName,
  type ServiceStatus,
} from "@nightshift/shared";

const name = process.env.SERVICE_NAME;
if (!name || !(SERVICE_NAMES as readonly string[]).includes(name)) {
  throw new Error(`SERVICE_NAME must be one of: ${SERVICE_NAMES.join(", ")}`);
}
const service = name as ServiceName;
const port = Number(process.env.PORT ?? SERVICE_PORTS[service]);
const HEALER_URL = process.env.HEALER_URL ?? "http://localhost:4000";
const IS_SHADOW = process.env.SHADOW === "1";

const SLOW_MS = 2000;
const SLOW_THRESHOLD_MS = 1000;
const DEFAULT_GRAY: GrayFault = { rate: 0.2, mode: "mixed" };
const DOWNSTREAM_TIMEOUT_MS = 3000;
const LEAK_CHUNK_BYTES = 4 * 1024 * 1024;
const LEAK_LIMIT_MB = 300;
const WINDOW_MS = 60_000;
const MB = 1024 * 1024;
const UNIT_PRICE = 10;

type Outcome = { status: number; body: unknown };
interface Sample {
  at: number;
  latencyMs: number;
  ok: boolean;
}

const samples: Sample[] = [];
const leaked: Buffer[] = [];
const startedAt = new Date().toISOString();
let activeFault: FaultType | null = null;
let gray: GrayFault | null = null;
let configMode: "ok" | "corrupt" = "ok";
let totalRequests = 0;
let totalErrors = 0;

function memoryMb(): number {
  return process.memoryUsage().rss / MB;
}

function leakExhausted(): boolean {
  return memoryMb() > LEAK_LIMIT_MB;
}

function isHealthy(): boolean {
  return configMode === "ok" && !leakExhausted();
}

function recordSample(latencyMs: number, ok: boolean): void {
  const now = Date.now();
  samples.push({ at: now, latencyMs, ok });
  while (samples.length > 0 && samples[0].at < now - WINDOW_MS) {
    samples.shift();
  }
}

function percentile(sorted: number[], fraction: number): number {
  return sorted.length > 0 ? sorted[Math.ceil(sorted.length * fraction) - 1] : 0;
}

function currentMetrics(): ServiceStatus["metrics"] {
  const cutoff = Date.now() - WINDOW_MS;
  const recent = samples.filter((sample) => sample.at >= cutoff);
  const errors = recent.filter((sample) => !sample.ok).length;
  const slow = recent.filter((sample) => sample.latencyMs >= SLOW_THRESHOLD_MS).length;
  const latencies = recent.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  return {
    windowSeconds: WINDOW_MS / 1000,
    requests: recent.length,
    errors,
    errorRate: recent.length > 0 ? errors / recent.length : 0,
    p95LatencyMs: percentile(latencies, 0.95),
    p50LatencyMs: percentile(latencies, 0.5),
    p99LatencyMs: percentile(latencies, 0.99),
    slowRate: recent.length > 0 ? slow / recent.length : 0,
    memoryMb: Math.round(memoryMb()),
  };
}

// A gray fault hits only a fraction of requests and never touches /health.
function grayEffect(): "error" | "slow" | null {
  if (activeFault !== "gray" || !gray || Math.random() >= gray.rate) return null;
  if (gray.mode === "mixed") return Math.random() < 0.5 ? "error" : "slow";
  return gray.mode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureRequest(req: express.Request): void {
  if (IS_SHADOW) return;
  const record = {
    service,
    at: new Date().toISOString(),
    method: req.method,
    path: req.path,
    headers: maskHeaders(req.headers as Record<string, unknown>),
    body: maskDeep(req.body ?? {}),
  };
  fetch(`${HEALER_URL}/api/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(500),
  }).catch(() => undefined);
}

async function callDownstream(target: ServiceName, path: string, payload: unknown): Promise<unknown> {
  const response = await fetch(`http://localhost:${SERVICE_PORTS[target]}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(IS_SHADOW ? { "x-nightshift-shadow": "1" } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${target} responded ${response.status}`);
  }
  return response.json();
}

async function handleBusinessRequest(
  req: express.Request,
  res: express.Response,
  work: () => Promise<unknown>,
): Promise<void> {
  captureRequest(req);
  const started = Date.now();
  const grayHit = grayEffect();
  if (activeFault === "slow" || grayHit === "slow") {
    await sleep(SLOW_MS);
  }
  if (activeFault === "memory_leak") {
    leaked.push(Buffer.alloc(LEAK_CHUNK_BYTES, 1));
  }

  let outcome: Outcome;
  if (configMode === "corrupt") {
    outcome = { status: 500, body: { error: "invalid configuration" } };
  } else if (grayHit === "error") {
    outcome = { status: 500, body: { error: "intermittent failure" } };
  } else if (leakExhausted()) {
    outcome = { status: 503, body: { error: "out of memory" } };
  } else {
    try {
      outcome = { status: 200, body: await work() };
    } catch (error) {
      outcome = {
        status: 502,
        body: { error: error instanceof Error ? error.message : "downstream failure" },
      };
    }
  }

  const ok = outcome.status < 400;
  totalRequests += 1;
  if (!ok) totalErrors += 1;
  recordSample(Date.now() - started, ok);
  res.status(outcome.status).json(outcome.body);
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  const healthy = isHealthy();
  res.status(healthy ? 200 : 503).json({ service, status: healthy ? "ok" : "unhealthy" });
});

app.get("/metrics", (_req, res) => {
  const status: ServiceStatus = {
    name: service,
    pid: process.pid,
    startedAt,
    activeFault,
    gray: activeFault === "gray" ? gray : null,
    config: { mode: configMode },
    healthy: isHealthy(),
    metrics: currentMetrics(),
    totals: { requests: totalRequests, errors: totalErrors },
  };
  res.json(status);
});

app.post("/__chaos", (req, res) => {
  const fault = req.body?.fault ?? null;
  if (fault !== null && !(FAULT_TYPES as readonly string[]).includes(fault)) {
    res.status(400).json({ error: `fault must be one of: ${FAULT_TYPES.join(", ")} or null` });
    return;
  }
  if (fault === "crash") {
    res.json({ service, activeFault: "crash" });
    setTimeout(() => process.exit(1), 100);
    return;
  }
  if (fault === "bad_config") {
    configMode = "corrupt";
  }
  if (fault === "gray") {
    const rate = Number(req.body?.rate ?? DEFAULT_GRAY.rate);
    const mode = (req.body?.mode ?? DEFAULT_GRAY.mode) as GrayMode;
    if (!(rate > 0 && rate <= 1) || !(GRAY_MODES as readonly string[]).includes(mode)) {
      res.status(400).json({ error: `gray needs rate in (0, 1] and mode one of: ${GRAY_MODES.join(", ")}` });
      return;
    }
    gray = { rate, mode };
  } else {
    gray = null;
  }
  activeFault = fault;
  res.json({ service, activeFault, gray });
});

app.get("/config", (_req, res) => {
  res.json({ mode: configMode });
});

app.put("/config", (req, res) => {
  const mode = req.body?.mode;
  if (mode !== "ok" && mode !== "corrupt") {
    res.status(400).json({ error: "mode must be 'ok' or 'corrupt'" });
    return;
  }
  configMode = mode;
  res.json({ mode });
});

if (service === "orders") {
  app.post("/checkout", (req, res) => {
    const { item, quantity, cardNumber } = req.body ?? {};
    if (typeof item !== "string" || typeof quantity !== "number" || typeof cardNumber !== "string") {
      res.status(400).json({ error: "item, quantity and cardNumber are required" });
      return;
    }
    void handleBusinessRequest(req, res, async () => {
      const charge = await callDownstream("payments", "/charge", {
        amount: quantity * UNIT_PRICE,
        cardNumber,
      });
      const reservation = await callDownstream("inventory", "/reserve", { item, quantity });
      return { orderId: randomUUID(), charge, reservation };
    });
  });
}

if (service === "payments") {
  app.post("/charge", (req, res) => {
    void handleBusinessRequest(req, res, async () => ({
      chargeId: randomUUID(),
      amount: req.body?.amount ?? 0,
      status: "captured",
    }));
  });
}

if (service === "inventory") {
  app.post("/reserve", (req, res) => {
    void handleBusinessRequest(req, res, async () => ({
      reservationId: randomUUID(),
      item: req.body?.item ?? null,
      quantity: req.body?.quantity ?? 0,
    }));
  });
}

app.listen(port, () => {
  console.log(`[${service}${IS_SHADOW ? " shadow" : ""}] listening on http://localhost:${port}`);
});
