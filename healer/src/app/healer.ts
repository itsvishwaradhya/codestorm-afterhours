import { randomUUID } from "node:crypto";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
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
import { injectBug, type InjectOptions, type Injection } from "./inject.js";
import { writePatch, type Patch } from "./patch.js";
import { AppTraffic, MeasuringProxy, discoverRoutes, summarize, type Sample, type WindowStats } from "./proxy.js";
import { AppRunner, isPortOpen, waitForPort, type AppLog } from "./runner.js";
import { APP_PORT, AppTerminal } from "./terminal.js";

type AuditInput = Omit<AuditEntry, "id" | "at">;

export type AppPhase = "detected" | "verifying" | "promoting" | "watching" | "resolved" | "escalated";

export interface CandidateResult {
  id: "restart" | "patch" | "rollback";
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
  // Set when the AI wrote a fix for this incident (applied only if its shadow test passed).
  patch: { file: string; description: string; patchedBy: string } | null;
  outcome: string | null;
  receipt: string | null;
}

const TICK_MS = 2000;
const WINDOW_MS = 4000;
const STARTUP_GRACE_MS = 6000;
// How long the app must serve cleanly after a start before its code becomes "last known good".
const GOOD_AFTER_MS = 10_000;
const WATCH_MS = 20_000;
const PASS_ERROR_RATE = 0.05;
// One broken route out of six still crosses this line.
const BAD_ERROR_RATE = 0.15;
const CLONE_PORTS = { restart: 4600, patch: 4601, rollback: 4603 };
const ROUTE_WINDOW_MS = 8000;

interface Candidate {
  id: CandidateResult["id"];
  label: string;
  source: string;
  port: number;
  // A file to replace in the copy before it starts (the AI fix).
  override?: { file: string; content: string };
}

export interface AppHealerDeps {
  providers: LlmProvider[];
  publish: (channel: string, payload: unknown) => void;
  audit: (entry: AuditInput) => Promise<void>;
}

// NightShift for an uploaded Express app: measure through the proxy, detect, prove a fix on a
// shadow copy with replayed traffic, promote it, watch production, then write a receipt.
export class AppHealer {
  readonly terminal: AppTerminal;
  readonly runner: AppRunner;
  readonly proxy = new MeasuringProxy();
  private readonly traffic: AppTraffic;
  private routes: string[] = ["/"];
  private timer: NodeJS.Timeout | null = null;
  private badStreak = 0;
  private graceUntil = 0;
  private busy = false;
  private ticking = false;
  private wasUp = false;
  private upSince = 0;
  private savedGood = false;
  private expectDown = false;
  private waitingForRecovery = false;
  private lastInjection: Injection | null = null;
  private watcher: FSWatcher | null = null;
  private treeTimer: NodeJS.Timeout | null = null;
  incident: AppIncident | null = null;
  // The changed files as NightShift found them when the incident opened, so the diff still
  // shows the bug after a rollback has made the live code good again.
  private incidentFiles = new Map<string, { before: string; after: string }>();
  // The AI fix as written: the broken file before, the fixed file after.
  private incidentFix: { file: string; before: string; after: string } | null = null;
  private appErrors: { at: number; line: string }[] = [];

  constructor(private readonly deps: AppHealerDeps) {
    this.terminal = new AppTerminal((data) => deps.publish("pty-data", data));
    this.runner = new AppRunner(this.terminal, (entry) => this.publishLog(entry));
    this.traffic = new AppTraffic(() => this.routes);
  }

  start(): void {
    this.proxy.start();
    this.terminal.start();
    this.watchTree();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  // Tells the explorer when files change on disk (terminal, npm, injection, rollback).
  private watchTree(): void {
    this.watcher?.close();
    this.watcher = null;
    try {
      mkdirSync(APP_ROOT, { recursive: true });
      this.watcher = watch(APP_ROOT, { recursive: true }, (_event, name) => {
        if (name && /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(name)) return;
        if (this.treeTimer) clearTimeout(this.treeTimer);
        this.treeTimer = setTimeout(() => this.deps.publish("app-tree", null), 300);
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.traffic.stop();
    this.proxy.stop();
    void this.runner.stop();
    this.terminal.kill();
  }

  private publishLog(entry: AppLog): void {
    // The app's own error output is what the AI reads when it writes a fix.
    if (entry.source === "app" && entry.stream === "stderr" && entry.line.trim()) {
      this.appErrors.push({ at: Date.now(), line: entry.line.slice(0, 400) });
      if (this.appErrors.length > 200) this.appErrors.splice(0, 100);
    }
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
      hasSnapshot: this.savedGood || this.lastInjection !== null,
    };
  }

  // The shell's working folder is about to be deleted; Windows refuses while a process sits in it.
  async beforeReset(): Promise<void> {
    await this.stopApp();
    this.terminal.kill();
    this.watcher?.close();
    this.watcher = null;
  }

  incidentDiff(file: string, which: "bug" | "fix" = "bug"): { before: string; after: string } | null {
    if (which === "fix") return this.incidentFix?.file === file ? this.incidentFix : null;
    return this.incidentFiles.get(file) ?? null;
  }

  async uploaded(): Promise<void> {
    this.proxy.clear();
    this.incident = null;
    this.incidentFiles.clear();
    this.incidentFix = null;
    this.appErrors = [];
    this.lastInjection = null;
    this.savedGood = false;
    this.terminal.restart();
    this.watchTree();
    await this.refreshRoutes();
    this.emit();
  }

  // Types a command into the shared terminal, exactly as if the user had.
  run(command: string): void {
    this.terminal.run(command);
  }

  async stopApp(): Promise<void> {
    this.expectDown = true;
    this.traffic.stop();
    await this.runner.stop();
  }

  private async restartApp(): Promise<void> {
    this.expectDown = true;
    this.graceUntil = Date.now() + STARTUP_GRACE_MS;
    await this.runner.restart();
  }

  private async appStarted(): Promise<void> {
    this.expectDown = false;
    if (!this.busy) this.waitingForRecovery = false;
    this.upSince = Date.now();
    this.savedGood = false;
    this.graceUntil = Date.now() + STARTUP_GRACE_MS;
    await this.refreshRoutes();
    this.traffic.start();
    this.say(`app is up on :${APP_PORT}; NightShift is watching ${this.routes.join(", ")} through the proxy on :4500`, "stdout");
  }

  private appStopped(): void {
    const intended = this.expectDown || Date.now() - this.terminal.lastInterruptAt < 8000;
    if (intended) {
      // A deliberate stop (Ctrl+C, Stop, a NightShift restart) is not an outage: forget the
      // last few samples so they cannot open an incident.
      this.proxy.clear();
      this.badStreak = 0;
      if (!this.busy) this.traffic.stop();
      this.say("app stopped");
    } else {
      this.say("app went down without being stopped", "stderr");
    }
  }

  async inject(options: InjectOptions = {}): Promise<Injection | null> {
    if (!this.runner.status().running) {
      this.say("start the app first (for example: npm start)", "stderr");
      return null;
    }
    if (this.busy || (this.incident && !this.isClosed(this.incident))) {
      this.say("an incident is already open", "stderr");
      return null;
    }
    await snapshotGood();
    const injection = await injectBug(
      this.deps.providers,
      (line) => this.say(line),
      (file, content) => this.breaksApp(file, content),
      options,
    );
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
      details: { file: injection.file, route: injection.route, kind: injection.kind },
    });
    await this.restartApp();
    return injection;
  }

  private isClosed(incident: AppIncident): boolean {
    return incident.phase === "resolved" || incident.phase === "escalated";
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.observe();
    } finally {
      this.ticking = false;
    }
  }

  private async observe(): Promise<void> {
    const up = await isPortOpen(APP_PORT);
    this.runner.running = up;
    if (up && !this.wasUp) await this.appStarted();
    if (!up && this.wasUp) this.appStopped();
    this.wasUp = up;
    if (this.busy) return;

    const open = this.incident !== null && !this.isClosed(this.incident);
    if (up && !open && !this.savedGood && Date.now() - this.upSince >= GOOD_AFTER_MS) {
      const recent = this.proxy.window(GOOD_AFTER_MS - 2000);
      if (recent.requests >= 5 && recent.errorRate < 0.02) {
        try {
          await snapshotGood();
          this.savedGood = true;
          this.say("app served cleanly for 10 s; this code is now the last known good version");
        } catch (error) {
          this.say(`could not save the last known good version: ${error instanceof Error ? error.message : String(error)}`, "stderr");
        }
      }
    }

    if (open || Date.now() < this.graceUntil) return;
    if (!up && !this.traffic.running) return;
    if (this.waitingForRecovery) {
      // After an escalation, stay quiet until the app is healthy again or is restarted.
      const now = this.proxy.window(WINDOW_MS);
      if (now.requests >= 3 && now.errorRate <= PASS_ERROR_RATE && now.reachable && this.proxy.window(ROUTE_WINDOW_MS).failingRoutes.length === 0) {
        this.waitingForRecovery = false;
        this.say("app is healthy again; NightShift is back on watch", "stdout");
      }
      return;
    }
    const stats = this.proxy.window(WINDOW_MS);
    // Per-route needs a longer window: with many routes each one gets only a request or two per tick.
    const failingRoutes = this.proxy.window(ROUTE_WINDOW_MS).failingRoutes;
    const bad =
      (stats.requests >= 3 && stats.errorRate >= BAD_ERROR_RATE) || (stats.requests > 0 && !stats.reachable) || failingRoutes.length > 0;
    this.badStreak = bad ? this.badStreak + 1 : 0;
    if (this.badStreak >= 2) {
      this.badStreak = 0;
      this.busy = true;
      try {
        await this.heal({ ...stats, failingRoutes });
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
        samples.push({ at: Date.now(), status, ms: performance.now() - started, path: route.split("?")[0] });
      }
    }
    return summarize(samples);
  }

  // Runs the candidate bug on a throwaway copy; it counts only if NightShift would detect it.
  private async breaksApp(file: string, content: string): Promise<boolean> {
    const port = 4602;
    const dir = await prepareClone(APP_ROOT, port);
    await writeFile(path.join(dir, file), content);
    const clone = this.runner.clone(dir, port);
    try {
      if (!clone || !(await waitForPort(port, 15_000))) return true;
      const stats = await this.replay(port);
      return !stats.reachable || stats.errorRate >= BAD_ERROR_RATE || stats.failingRoutes.length > 0;
    } finally {
      await clone?.stop();
      await removeClone(dir);
    }
  }

  private async shadowTest({ id, label, source, port, override }: Candidate): Promise<CandidateResult> {
    const dir = await prepareClone(source, port);
    if (override) await writeFile(path.join(dir, override.file), override.content);
    const clone = this.runner.clone(dir, port);
    try {
      const ready = clone ? await waitForPort(port, 15_000) : false;
      const stats = ready ? await this.replay(port) : null;
      const passed = stats !== null && stats.requests > 0 && stats.errorRate <= PASS_ERROR_RATE && stats.failingRoutes.length === 0;
      return {
        id,
        label,
        verdict: passed ? "promote" : "reject",
        requests: stats?.requests ?? 0,
        errorRate: stats?.errorRate ?? 1,
        p95Ms: stats?.p95Ms ?? 0,
      };
    } finally {
      await clone?.stop();
      await removeClone(dir);
    }
  }

  // Gives the AI the broken file, what changed since it last worked, the errors and the failing
  // routes. Picks the injected file, else the changed file the error stacks mention, else the first.
  private async writeFix(changed: string[], trigger: WindowStats): Promise<Patch | null> {
    if (this.deps.providers.length === 0) {
      this.say("no AI provider configured, skipping the AI fix");
      return null;
    }
    const since = Date.parse(this.incident?.firstBadAt ?? new Date().toISOString()) - 15_000;
    const errors = this.appErrors.filter((entry) => entry.at >= since).map((entry) => entry.line).slice(-20);
    const injected = this.lastInjection && changed.includes(this.lastInjection.file) ? this.lastInjection.file : null;
    const mentioned = changed.find((file) => errors.some((line) => line.replace(/\\/g, "/").includes(file)));
    const file = injected ?? mentioned ?? changed[0];
    const broken = (await readAppFile(file)) ?? "";
    const good = await readAppFile(file, GOOD_ROOT);
    this.say(`asking the AI to fix ${file} (${errors.length} error lines, failing routes: ${trigger.failingRoutes.join(", ") || "none listed"})`);
    const patch = await writePatch(this.deps.providers, { file, broken, good, errors, failingRoutes: trigger.failingRoutes }, (line) => this.say(line));
    if (patch) this.say(`${patch.patchedBy} wrote a fix: ${patch.description}`, "stdout");
    else this.say("no usable AI fix, falling back to the next candidate", "stderr");
    return patch;
  }

  private async heal(trigger: WindowStats): Promise<void> {
    const now = new Date();
    const changed = (await hasGoodSnapshot()) ? await changedFiles() : [];
    this.incidentFiles.clear();
    this.incidentFix = null;
    for (const file of changed) {
      this.incidentFiles.set(file, { before: (await readAppFile(file, GOOD_ROOT)) ?? "", after: (await readAppFile(file)) ?? "" });
    }
    if (this.lastInjection && !this.incidentFiles.has(this.lastInjection.file)) {
      this.incidentFiles.set(this.lastInjection.file, { before: this.lastInjection.before, after: this.lastInjection.after });
    }
    this.incident = {
      id: randomUUID(),
      phase: "detected",
      openedAt: now.toISOString(),
      firstBadAt: new Date(now.getTime() - 2 * TICK_MS).toISOString(),
      closedAt: null,
      trigger,
      changedFiles: changed,
      injection: this.lastInjection
        ? {
            file: this.lastInjection.file,
            route: this.lastInjection.route,
            kind: this.lastInjection.kind,
            description: this.lastInjection.description,
            injectedBy: this.lastInjection.injectedBy,
          }
        : null,
      candidates: [],
      patch: null,
      outcome: null,
      receipt: null,
    };
    const routes = trigger.failingRoutes.length ? ` (failing: ${trigger.failingRoutes.join(", ")})` : "";
    const what = trigger.reachable ? `${Math.round(trigger.errorRate * 100)}% of requests failing${routes}` : "app unreachable";
    await this.phase("detected", `${what}${changed.length ? `; code changed since last good: ${changed.join(", ")}` : ""}`, "app.incident.opened");

    await this.phase("verifying", "testing candidate fixes on shadow copies with replayed production requests", "app.verifying");
    const incidentId = this.incident.id;
    const test = async (candidate: Candidate): Promise<CandidateResult> => {
      const result = await this.shadowTest(candidate);
      this.incident?.candidates.push(result);
      this.emit();
      const detail = `${result.label}: ${result.verdict} (${Math.round(result.errorRate * 100)}% errors over ${result.requests} replayed requests)`;
      this.say(`shadow test → ${detail}`, result.verdict === "promote" ? "stdout" : "stderr");
      await this.deps.audit({ actor: "healer", action: "app.shadow.verdict", trigger: detail, incidentId, details: {} });
      return result;
    };

    // Cheapest first: a restart. For a code change, an AI-written fix that keeps the rest of the
    // change, and only then the blunt rollback of whole files.
    let chosen: CandidateResult | null = null;
    let patch: Patch | null = null;
    const restart = await test({ id: "restart", label: "Restart the app", source: APP_ROOT, port: CLONE_PORTS.restart });
    if (restart.verdict === "promote") chosen = restart;

    if (!chosen && changed.length) {
      patch = await this.writeFix(changed, trigger);
      if (patch) {
        this.incident.patch = { file: patch.file, description: patch.description, patchedBy: patch.patchedBy };
        this.incidentFix = { file: patch.file, before: patch.before, after: patch.after };
        this.emit();
        const result = await test({
          id: "patch",
          label: `Apply ${patch.patchedBy}'s fix to ${patch.file}`,
          source: APP_ROOT,
          port: CLONE_PORTS.patch,
          override: { file: patch.file, content: patch.after },
        });
        if (result.verdict === "promote") chosen = result;
      }
    }

    if (!chosen && changed.length) {
      const rollback = await test({ id: "rollback", label: `Roll back ${changed.join(", ")} to last known good`, source: GOOD_ROOT, port: CLONE_PORTS.rollback });
      if (rollback.verdict === "promote") chosen = rollback;
    }

    if (!chosen) {
      this.incident.outcome = "escalated: no candidate fix passed the shadow test";
      this.incident.closedAt = new Date().toISOString();
      await this.phase("escalated", "no fix passed its shadow test, a human is needed", "app.escalated");
      this.waitingForRecovery = true;
      this.incident.receipt = this.receipt();
      this.emit();
      return;
    }

    await this.phase("promoting", `applying ${chosen.label} to production`, "app.action.applied");
    if (chosen.id === "rollback") await restoreGood();
    if (chosen.id === "patch" && patch) await writeAppFile(patch.file, patch.after);
    await this.restartApp();
    await waitForPort(APP_PORT, 20_000);
    const liveAt = Date.now();
    await this.phase("watching", `fix live, watching production for ${WATCH_MS / 1000}s`, "app.watching");

    await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
    const after = this.proxy.window(WATCH_MS - 4000);
    this.incident.closedAt = new Date().toISOString();
    if (after.errorRate <= PASS_ERROR_RATE && after.reachable && after.failingRoutes.length === 0) {
      this.incident.outcome = `fixed by ${chosen.label}`;
      const healed = ((liveAt - Date.parse(this.incident.firstBadAt)) / 1000).toFixed(1);
      await this.phase("resolved", `${this.incident.outcome}; healed in ${healed}s, error rate now ${Math.round(after.errorRate * 100)}%`, "app.resolved");
      if (chosen.id !== "restart") this.lastInjection = null;
    } else {
      this.incident.outcome = `escalated: errors returned after ${chosen.label}`;
      await this.phase("escalated", this.incident.outcome, "app.escalated");
      this.waitingForRecovery = true;
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
    if (incident.trigger.failingRoutes.length) lines.push(`Failing routes: ${incident.trigger.failingRoutes.join(", ")}.`);
    if (incident.injection) {
      lines.push(`Cause: a code change to ${incident.injection.file} (${incident.injection.description}), injected by ${incident.injection.injectedBy}.`);
    } else if (incident.changedFiles.length) {
      lines.push(`Code changed since the last good version: ${incident.changedFiles.join(", ")}.`);
    }
    if (incident.patch) lines.push(`AI fix by ${incident.patch.patchedBy} for ${incident.patch.file}: ${incident.patch.description}`);
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
