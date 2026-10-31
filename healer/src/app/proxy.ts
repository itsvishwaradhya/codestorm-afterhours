import http from "node:http";
import { APP_PORT } from "./terminal.js";

export const PROXY_PORT = 4500;
const MAX_CAPTURES = 30;

export interface Sample {
  at: number;
  status: number;
  ms: number;
  path?: string;
}

export interface WindowStats {
  requests: number;
  errors: number;
  errorRate: number;
  p95Ms: number;
  reachable: boolean;
  // Routes failing at least half of their requests. One broken route out of many barely moves
  // the overall error rate, but its users still get errors on every call.
  failingRoutes: string[];
}

const ROUTE_MIN_REQUESTS = 2;
const ROUTE_FAIL_RATE = 0.5;

export function summarize(samples: Sample[]): WindowStats {
  const errors = samples.filter((sample) => sample.status >= 500).length;
  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;
  const byRoute = new Map<string, { requests: number; errors: number }>();
  for (const sample of samples) {
    if (!sample.path) continue;
    const route = byRoute.get(sample.path) ?? { requests: 0, errors: 0 };
    route.requests += 1;
    if (sample.status >= 500) route.errors += 1;
    byRoute.set(sample.path, route);
  }
  return {
    requests: samples.length,
    errors,
    errorRate: samples.length ? errors / samples.length : 0,
    p95Ms: Math.round(p95),
    reachable: samples.length === 0 || samples.some((sample) => sample.status !== 502),
    failingRoutes: [...byRoute.entries()]
      .filter(([, route]) => route.requests >= ROUTE_MIN_REQUESTS && route.errors / route.requests >= ROUTE_FAIL_RATE)
      .map(([path]) => path),
  };
}

const pathOf = (url: string | undefined) => (url ?? "/").split("?")[0] || "/";

// Sits in front of the user's app and measures every request, so the app needs no instrumentation.
export class MeasuringProxy {
  private samples: Sample[] = [];
  private captures: string[] = [];
  private server: http.Server | null = null;

  start(): void {
    this.server = http.createServer((req, res) => {
      const started = performance.now();
      const done = (status: number) => {
        this.samples.push({ at: Date.now(), status, ms: performance.now() - started, path: pathOf(req.url) });
        if (this.samples.length > 2000) this.samples.splice(0, 1000);
      };
      if (req.method === "GET" && req.url) {
        this.captures.push(req.url);
        if (this.captures.length > MAX_CAPTURES) this.captures.shift();
      }
      const upstream = http.request(
        { host: "127.0.0.1", port: APP_PORT, method: req.method, path: req.url, headers: req.headers, timeout: 5000 },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
          response.on("end", () => done(response.statusCode ?? 502));
        },
      );
      upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end("app unreachable");
        done(502);
      });
      req.pipe(upstream);
    });
    this.server.listen(PROXY_PORT);
  }

  window(ms: number): WindowStats {
    const since = Date.now() - ms;
    return summarize(this.samples.filter((sample) => sample.at >= since));
  }

  replayPaths(): string[] {
    return [...new Set(this.captures)];
  }

  clear(): void {
    this.samples = [];
    this.captures = [];
  }

  stop(): void {
    this.server?.close();
  }
}

const ROUTE = /(?:app|router)\.get\(\s*['"`]([^'"`:*]+)['"`]/g;

export function discoverRoutes(sources: string[]): string[] {
  const routes = new Set<string>();
  for (const source of sources) for (const match of source.matchAll(ROUTE)) routes.add(match[1]);
  return routes.size ? [...routes] : ["/"];
}

// Steady synthetic traffic through the proxy so problems show up without a human clicking around.
export class AppTraffic {
  private timer: NodeJS.Timeout | null = null;
  private index = 0;

  constructor(private readonly routes: () => string[]) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(perSecond = 3): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const list = this.routes();
      const route = list[this.index++ % list.length];
      fetch(`http://127.0.0.1:${PROXY_PORT}${route}`, { signal: AbortSignal.timeout(6000) })
        .then((response) => response.arrayBuffer())
        .catch(() => undefined);
    }, 1000 / perSecond);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
