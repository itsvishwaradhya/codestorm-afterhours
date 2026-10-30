import { randomUUID } from "node:crypto";
import express from "express";
import {
  FAULT_TYPES,
  SERVICE_NAMES,
  SERVICE_PORTS,
  type FaultType,
  type ServiceName,
  type ServiceStatus,
} from "@nightshift/shared";

const name = process.env.SERVICE_NAME;
if (!name || !(SERVICE_NAMES as readonly string[]).includes(name)) {
  throw new Error(`SERVICE_NAME must be one of: ${SERVICE_NAMES.join(", ")}`);
}
const service = name as ServiceName;
const port = SERVICE_PORTS[service];

const SLOW_MS = 2000;
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
let configMode: "ok" | "corrupt" = "ok";

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

function currentMetrics(): ServiceStatus["metrics"] {
  const cutoff = Date.now() - WINDOW_MS;
  const recent = samples.filter((sample) => sample.at >= cutoff);
  const errors = recent.filter((sample) => !sample.ok).length;
  const latencies = recent.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const p95 =
    latencies.length > 0 ? latencies[Math.ceil(latencies.length * 0.95) - 1] : 0;
  return {
    windowSeconds: WINDOW_MS / 1000,
    requests: recent.length,
    errors,
    errorRate: recent.length > 0 ? errors / recent.length : 0,
    p95LatencyMs: p95,
    memoryMb: Math.round(memoryMb()),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callDownstream(target: ServiceName, path: string, payload: unknown): Promise<unknown> {
  const response = await fetch(`http://localhost:${SERVICE_PORTS[target]}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${target} responded ${response.status}`);
  }
  return response.json();
}

async function handleBusinessRequest(res: express.Response, work: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  if (activeFault === "slow") {
    await sleep(SLOW_MS);
  }
  if (activeFault === "memory_leak") {
    leaked.push(Buffer.alloc(LEAK_CHUNK_BYTES, 1));
  }

  let outcome: Outcome;
  if (configMode === "corrupt") {
    outcome = { status: 500, body: { error: "invalid configuration" } };
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

  recordSample(Date.now() - started, outcome.status < 400);
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
    config: { mode: configMode },
    healthy: isHealthy(),
    metrics: currentMetrics(),
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
  activeFault = fault;
  res.json({ service, activeFault });
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
    void handleBusinessRequest(res, async () => {
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
    void handleBusinessRequest(res, async () => ({
      chargeId: randomUUID(),
      amount: req.body?.amount ?? 0,
      status: "captured",
    }));
  });
}

if (service === "inventory") {
  app.post("/reserve", (req, res) => {
    void handleBusinessRequest(res, async () => ({
      reservationId: randomUUID(),
      item: req.body?.item ?? null,
      quantity: req.body?.quantity ?? 0,
    }));
  });
}

app.listen(port, () => {
  console.log(`[${service}] listening on http://localhost:${port}`);
});
