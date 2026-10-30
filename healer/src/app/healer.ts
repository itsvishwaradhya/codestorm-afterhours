import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEntry } from "@nightshift/shared";
import type { LlmProvider } from "../receipt/chain.js";
import {
  APP_ROOT,
  GOOD_ROOT,
  changedFiles,
  hasGoodSnapshot,
  listFiles,
  prepareClone,
  removeClone,
  readAppFile,
  restoreGood,
  snapshotGood,
  writeAppFile,
} from "./files.js";
import { injectBug, type Injection } from "./inject.js";
import { AppTraffic, MeasuringProxy, discoverRoutes, summarize, type Sample, type WindowStats } from "./proxy.js";
import { AppRunner, isServerCommand, waitForPort, type AppLog } from "./runner.js";

type AuditInput = Omit<AuditEntry, "id" | "at">;

export type AppPhase = "detected" | "verifying" | "promoting" | "watching" | "resolved" | "escalated";

export interface CandidateResult {
  id: "restart" | "rollback";
  label: string;
  verdict: "promote" | "reject";
  requests: number;
  errorRate: number;
  p95Ms: number;
}

export interface AppIncident {
  id: string;
  phase: AppPhase;
  openedAt: string;
  firstBadAt: string;
  closedAt: string | null;
  trigger: WindowStats;
  changedFiles: string[];
  injection: Omit<Injection, "before" | "after"> | null;
  candidates: CandidateResult[];
  outcome: string | null;
  receipt: string | null;
}

const TICK_MS = 2000;
const WINDOW_MS = 4000;
const STARTUP_GRACE_MS = 6000;
const WATCH_MS = 20_000;
const PASS_ERROR_RATE = 0.05;
// One broken route out of six still crosses this line.
const BAD_ERROR_RATE = 0.15;
const CLONE_PORTS = [4600, 4601];

export interface AppHealerDeps {
  providers: LlmProvider[];
  publish: (channel: string, payload: unknown) => void;
  audit: (entry: AuditInput) => Promise<void>;
}

// NightShift for an uploaded Express app: measure through the proxy, detect, prove a fix on a
// shadow copy with replayed traffic, promote it, watch production, then write a receipt.
export class AppHealer {
  readonly runner: AppRunner;
  readonly proxy = new MeasuringProxy();
  private readonly traffic: AppTraffic;
  private routes: string[] = ["/"];
  private timer: NodeJS.Timeout | null = null;
  private badStreak = 0;
  private graceUntil = 0;
  private busy = false;
  private lastInjection: Injection | null = null;
  incident: AppIncident | null = null;

  constructor(private readonly deps: AppHealerDeps) {
    this.runner = new AppRunner((entry) => this.publishLog(entry));
    this.traffic = new AppTraffic(() => this.routes);
  }

  start(): void {
    this.proxy.start();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.traffic.stop();
    this.proxy.stop();
    void this.runner.stop();
  }

  private publishLog(entry: AppLog): void {
    this.deps.publish("app-log", entry);
  }

  private say(line: string, stream: AppLog["stream"] = "system"): void {
    this.publishLog({ source: "nightshift", line, stream, at: new Date().toISOString() });
  }

  private emit(): void {
    this.deps.publish("app-incident", this.incident);
  }

  private async refreshRoutes(): Promise<void> {
    const sources: string[] = [];
    for (const file of await listFiles()) {
      if (/\.(c|m)?js$/.test(file.path)) sources.push((await readAppFile(file.path)) ?? "");
    }
    this.routes = discoverRoutes(sources);
  }

  state() {
    return {
      ...this.runner.status(),
      proxyPort: 4500,
      routes: this.routes,
      health: this.proxy.window(WINDOW_MS),
      incident: this.incident,
      hasSnapshot: this.lastInjection !== null,
    };
  }

  async uploaded(): Promise<void> {
    await this.runner.stop();
    this.traffic.stop();
    this.proxy.clear();
    this.incident = null;
    this.lastInjection = null;
    await this.refreshRoutes();
    this.emit();
  }

  async exec(command: string): Promise<void> {
    await this.runner.exec(command);
    if (!isServerCommand(command)) return;
    await this.refreshRoutes();
    this.graceUntil = Date.now() + STARTUP_GRACE_MS;
    this.traffic.start();
    this.say(`NightShift is watching ${this.routes.join(", ")} through the proxy on :4500`);
  }

  async stopApp(): Promise<void> {
    this.traffic.stop();
    await this.runner.stop();
  }

  async inject(): Promise<Injection | null> {
    if (!this.runner.status().running) {
      this.say("start the app first (for example: npm start)", "stderr");
      return null;
    }
    if (this.incident && !this.isClosed(this.incident)) {
      this.say("an incident is already open", "stderr");
      return null;
    }
    await snapshotGood();
    const injection = await injectBug(this.deps.providers, (line) => this.say(line), (file, content) => this.breaksApp(file, content));
    if (!injection) return null;
    await writeAppFile(injection.file, injection.after);
    this.lastInjection = injection;
    this.say(`bug injected by ${injection.injectedBy} into ${injection.file}: ${injection.description}`, "stderr");
    this.say("deploying the change (restarting the app)…");
    await this.deps.audit({
      actor: "chaos-ai",
      action: "app.bug.injected",
      trigger: `${injection.injectedBy}: ${injection.description}`,
      incidentId: null,
      details: { file: injection.file },
    });
    this.graceUntil = Date.now() + STARTUP_GRACE_MS;
    await this.runner.restart();
    return injection;
  }

  private isClosed(incident: AppIncident): boolean {
    return incident.phase === "resolved" || incident.phase === "escalated";
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.runner.status().command || Date.now() < this.graceUntil) return;
    if (this.incident && !this.isClosed(this.incident)) return;
    const stats = this.proxy.window(WINDOW_MS);
    const bad = (stats.requests >= 3 && stats.errorRate >= BAD_ERROR_RATE) || (stats.requests > 0 && !stats.reachable);
    this.badStreak = bad ? this.badStreak + 1 : 0;
    if (this.badStreak >= 2) {
      this.badStreak = 0;
      this.busy = true;
      try {
        await this.heal(stats);
      } catch (error) {
        this.say(`healing failed: ${error instanceof Error ? error.message : String(error)}`, "stderr");
      } finally {
        this.busy = false;
      }
    }
  }

  private async phase(phase: AppPhase, note: string, action: string): Promise<void> {
    if (!this.incident) return;
    this.incident.phase = phase;
    this.say(`incident ${this.incident.id.slice(0, 8)} → ${phase}: ${note}`, phase === "escalated" ? "stderr" : "system");
    this.emit();
    await this.deps.audit({ actor: "healer", action, trigger: note, incidentId: this.incident.id, details: {} });
  }

  private async replay(port: number): Promise<WindowStats> {
    const paths = this.proxy.replayPaths().length ? this.proxy.replayPaths() : this.routes;
    const samples: Sample[] = [];
    for (let round = 0; samples.length < 30 && round < 30; round++) {
      for (const route of paths) {
        if (samples.length >= 30) break;
        const started = performance.now();
        const status = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000) })
          .then(async (response) => {
            await response.arrayBuffer();
            return response.status;
          })
          .catch(() => 502);
        samples.push({ at: Date.now(), status, ms: performance.now() - started });
      }
    }
    return summarize(samples);
  }

  // Runs the candidate bug on a throwaway copy; it counts only if it fails enough requests to be detected.
  private async breaksApp(file: string, content: string): Promise<boolean> {
    const port = 4602;
    const dir = await prepareClone(APP_ROOT, port);
    await writeFile(path.join(dir, file), content);
    const clone = this.runner.clone(dir, port);
    try {
      if (!clone || !(await waitForPort(port, 15_000))) return false;
      return (await this.replay(port)).errorRate >= BAD_ERROR_RATE;
    } finally {
      await clone?.stop();
      await removeClone(dir);
    }
  }

  private async shadowTest(id: CandidateResult["id"], label: string, source: string, port: number): Promise<CandidateResult> {
    const dir = await prepareClone(source, port);
    const clone = this.runner.clone(dir, port);
    try {
      const ready = clone ? await waitForPort(port, 15_000) : false;
      const stats = ready ? await this.replay(port) : { requests: 0, errors: 0, errorRate: 1, p95Ms: 0, reachable: false };
      const verdict = ready && stats.requests > 0 && stats.errorRate <= PASS_ERROR_RATE ? "promote" : "reject";
      return { id, label, verdict, requests: stats.requests, errorRate: stats.errorRate, p95Ms: stats.p95Ms };
    } finally {
      await clone?.stop();
      await removeClone(dir);
    }
  }

  private async heal(trigger: WindowStats): Promise<void> {
    const now = new Date();
    const changed = (await hasGoodSnapshot()) ? await changedFiles() : [];
    this.incident = {
      id: randomUUID(),
      phase: "detected",
      openedAt: now.toISOString(),
      firstBadAt: new Date(now.getTime() - 2 * TICK_MS).toISOString(),
      closedAt: null,
      trigger,
      changedFiles: changed,
      injection: this.lastInjection
        ? { file: this.lastInjection.file, description: this.lastInjection.description, injectedBy: this.lastInjection.injectedBy }
        : null,
      candidates: [],
      outcome: null,
      receipt: null,
    };
    const what = trigger.reachable ? `${Math.round(trigger.errorRate * 100)}% of requests failing` : "app unreachable";
    await this.phase("detected", `${what}${changed.length ? `; code changed since last good: ${changed.join(", ")}` : ""}`, "app.incident.opened");

    await this.phase("verifying", "testing candidate fixes on shadow copies with replayed production requests", "app.verifying");
    const candidates: [CandidateResult["id"], string, string][] = [["restart", "Restart the app", APP_ROOT]];
    if (changed.length) candidates.push(["rollback", `Roll back ${changed.join(", ")} to last known good`, GOOD_ROOT]);

    let chosen: CandidateResult | null = null;
    for (const [index, [id, label, source]] of candidates.entries()) {
      const result = await this.shadowTest(id, label, source, CLONE_PORTS[index]);
      this.incident.candidates.push(result);
      this.emit();
      const detail = `${result.label}: ${result.verdict} (${Math.round(result.errorRate * 100)}% errors over ${result.requests} replayed requests)`;
      this.say(`shadow test → ${detail}`, result.verdict === "promote" ? "stdout" : "stderr");
      await this.deps.audit({ actor: "healer", action: "app.shadow.verdict", trigger: detail, incidentId: this.incident.id, details: {} });
      if (result.verdict === "promote") {
        chosen = result;
        break;
      }
    }

    if (!chosen) {
      this.incident.outcome = "escalated: no candidate fix passed the shadow test";
      this.incident.closedAt = new Date().toISOString();
      await this.phase("escalated", "no fix passed its shadow test, a human is needed", "app.escalated");
      this.incident.receipt = this.receipt();
      this.emit();
      return;
    }

    await this.phase("promoting", `applying ${chosen.label} to production`, "app.action.applied");
    if (chosen.id === "rollback") await restoreGood();
    this.graceUntil = Date.now() + STARTUP_GRACE_MS;
    await this.runner.restart();
    await waitForPort(4501, 15_000);
    const liveAt = Date.now();
    await this.phase("watching", `fix live, watching production for ${WATCH_MS / 1000}s`, "app.watching");

    await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
    const after = this.proxy.window(WATCH_MS - 4000);
    this.incident.closedAt = new Date().toISOString();
    if (after.errorRate <= PASS_ERROR_RATE && after.reachable) {
      this.incident.outcome = `fixed by ${chosen.label}`;
      const healed = ((liveAt - Date.parse(this.incident.firstBadAt)) / 1000).toFixed(1);
      await this.phase("resolved", `${this.incident.outcome}; healed in ${healed}s, error rate now ${Math.round(after.errorRate * 100)}%`, "app.resolved");
      if (chosen.id === "rollback") this.lastInjection = null;
    } else {
      this.incident.outcome = `escalated: errors returned after ${chosen.label}`;
      await this.phase("escalated", this.incident.outcome, "app.escalated");
    }
    this.incident.receipt = this.receipt(liveAt);
    this.say("Heal Receipt written");
    this.emit();
  }

  private receipt(liveAt?: number): string {
    const incident = this.incident!;
    const lines: string[] = [];
    const trigger = incident.trigger.reachable
      ? `${Math.round(incident.trigger.errorRate * 100)}% of requests failed (p95 ${incident.trigger.p95Ms} ms)`
      : "the app stopped answering";
    lines.push(`What broke: ${trigger}.`);
    if (incident.injection) {
      lines.push(`Cause: a code change to ${incident.injection.file} (${incident.injection.description}), injected by ${incident.injection.injectedBy}.`);
    } else if (incident.changedFiles.length) {
      lines.push(`Code changed since the last good version: ${incident.changedFiles.join(", ")}.`);
    }
    for (const candidate of incident.candidates) {
      lines.push(
        `Shadow test, ${candidate.label}: ${candidate.verdict} (${Math.round(candidate.errorRate * 100)}% errors over ${candidate.requests} replayed requests).`,
      );
    }
    if (liveAt && incident.phase === "resolved") {
      lines.push(`Healed in ${((liveAt - Date.parse(incident.firstBadAt)) / 1000).toFixed(1)} s from the first bad sample. No human was paged.`);
    }
    lines.push(`Outcome: ${incident.outcome}.`);
    return lines.join("\n");
  }
}
