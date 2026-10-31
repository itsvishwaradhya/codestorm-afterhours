import type { Db } from "mongodb";
import type { Express, Request, RequestHandler, Response } from "express";
import {
  SERVICE_NAMES,
  maskDeep,
  maskHeaders,
  type AuditEntry,
  type Incident,
  type ServiceName,
  type Snapshot,
} from "@nightshift/shared";
import { injectFault } from "../chaos/injector.js";
import type { ApprovalGate } from "../remediate/approvals.js";
import type { ActionCap } from "../remediate/cap.js";
import type { RemediationGuard } from "../remediate/guard.js";
import type { ServiceRegistry } from "../registry.js";
import { guardrailSavings } from "../report/guardrails.js";
import { healTiming } from "../report/timing.js";
import * as repo from "../store/repository.js";
import type { LogLine } from "../supervisor/supervisor.js";
import type { AppHealer } from "../app/healer.js";
import { GOOD_ROOT, deleteAppPath, listTree, makeAppDir, readAppFile, renameAppPath, resetApp, writeAppFile, zipApp } from "../app/files.js";
import { BUG_CATALOG, BUG_KINDS, listTargets } from "../app/inject.js";
import { PROXY_PORT } from "../app/proxy.js";
import {
  appExecSchema,
  appFileSchema,
  appInjectSchema,
  appRenameSchema,
  appRequestSchema,
  approvalSchema,
  captureSchema,
  chaosSchema,
  guardResetSchema,
  serviceUpdateSchema,
  workspaceFileSchema,
} from "./schemas.js";
import { workspaceFile, workspaceTree } from "./workspace.js";

type AuditInput = Omit<AuditEntry, "id" | "at">;

export interface ApiContext {
  db: Db;
  registry: ServiceRegistry;
  latestSnapshots: () => Snapshot[];
  activeIncident: () => Incident | null;
  audit: (entry: AuditInput) => Promise<void>;
  approvals: ApprovalGate;
  cap: ActionCap;
  guard: RemediationGuard;
  reset: () => Promise<boolean>;
  recentLogs: () => LogLine[];
  app: AppHealer;
}

type Handler = (req: Request, res: Response) => Promise<void>;

function wrap(handler: Handler): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

export function registerRoutes(app: Express, ctx: ApiContext): void {
  app.get("/health", (_req, res) => {
    res.json({ service: "healer", status: "ok" });
  });

  app.get("/api/state", (_req, res) => {
    res.json({
      services: ctx.registry.list(),
      snapshots: ctx.latestSnapshots(),
      activeIncident: ctx.activeIncident(),
      pendingApprovals: ctx.approvals.pending(),
      cap: ctx.cap.status(),
      guard: ctx.guard.status(),
    });
  });

  app.post(
    "/api/guard/:service/reset",
    wrap(async (req, res) => {
      const parsed = guardResetSchema.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
      }
      ctx.guard.reset(parsed.data.service);
      await ctx.audit({
        actor: "operator",
        action: "guard.reset",
        trigger: `cooldown and circuit breaker reset on ${parsed.data.service}`,
        incidentId: null,
        details: { service: parsed.data.service },
      });
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/impact",
    wrap(async (_req, res) => {
      const attempts = await repo.listActedAttempts(ctx.db, 200);
      const counts = { helped: 0, no_effect: 0, hurt: 0, temporary: 0 };
      for (const attempt of attempts) {
        if (attempt.impact) counts[attempt.impact] += 1;
      }
      res.json({ counts, recent: attempts.slice(0, 20) });
    }),
  );

  app.get(
    "/api/scorecard",
    wrap(async (_req, res) => {
      const [incidents, attempts, suppressed] = await Promise.all([
        repo.listIncidents(ctx.db, 200),
        repo.listRecentAttempts(ctx.db, 500),
        repo.listAuditByAction(ctx.db, "action.suppressed", 500),
      ]);
      res.json(guardrailSavings({ incidents, attempts, suppressed }));
    }),
  );

  // Uploaded app workspace. Localhost only: /api/app/exec runs shell commands on this machine.
  app.post(
    "/api/app/reset",
    wrap(async (_req, res) => {
      await ctx.app.beforeReset();
      await resetApp();
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/app/files",
    wrap(async (req, res) => {
      const parsed = appFileSchema.safeParse(req.body);
      if (!parsed.success || !(await writeAppFile(parsed.data.path, parsed.data.content))) {
        res.status(400).json({ error: "file rejected" });
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/app/uploaded",
    wrap(async (_req, res) => {
      await ctx.app.uploaded();
      res.json(await listTree());
    }),
  );

  app.get(
    "/api/app/tree",
    wrap(async (_req, res) => {
      res.json(await listTree());
    }),
  );

  app.get(
    "/api/app/file",
    wrap(async (req, res) => {
      const parsed = workspaceFileSchema.safeParse(req.query);
      const content = parsed.success ? await readAppFile(parsed.data.path) : null;
      if (!parsed.success || content === null) {
        res.status(404).json({ error: "file not found" });
        return;
      }
      res.json({ path: parsed.data.path, content });
    }),
  );

  // The last known good copy NightShift rolls back to, for the bug-vs-heal diff.
  app.get(
    "/api/app/good-file",
    wrap(async (req, res) => {
      const parsed = workspaceFileSchema.safeParse(req.query);
      const content = parsed.success ? await readAppFile(parsed.data.path, GOOD_ROOT) : null;
      if (!parsed.success || content === null) {
        res.status(404).json({ error: "no good copy of this file" });
        return;
      }
      res.json({ path: parsed.data.path, content });
    }),
  );

  // The bug as NightShift caught it: last known good against the broken file at detection time.
  app.get(
    "/api/app/incident-diff",
    wrap(async (req, res) => {
      const parsed = workspaceFileSchema.safeParse(req.query);
      const diff = parsed.success ? ctx.app.incidentDiff(parsed.data.path) : null;
      if (!parsed.success || !diff) {
        res.status(404).json({ error: "this file was not part of the incident" });
        return;
      }
      res.json({ path: parsed.data.path, ...diff });
    }),
  );

  app.get(
    "/api/app/download",
    wrap(async (_req, res) => {
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", 'attachment; filename="my-app.zip"');
      res.send(await zipApp());
    }),
  );

  // Sends one request through NightShift's proxy, so it counts in the app's metrics like real traffic.
  app.post(
    "/api/app/request",
    wrap(async (req, res) => {
      const parsed = appRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "path must start with /" });
        return;
      }
      const { method, path: route, body } = parsed.data;
      const started = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${PROXY_PORT}${route}`, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: method === "GET" || method === "DELETE" ? undefined : body,
          signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();
        res.json({
          status: response.status,
          ms: Math.round(performance.now() - started),
          contentType: response.headers.get("content-type"),
          body: text.length > 50_000 ? `${text.slice(0, 50_000)}\n… (truncated)` : text,
        });
      } catch (error) {
        res.json({ status: 0, ms: Math.round(performance.now() - started), contentType: null, body: error instanceof Error ? error.message : String(error) });
      }
    }),
  );

  app.post(
    "/api/app/exec",
    wrap(async (req, res) => {
      const parsed = appExecSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "command required" });
        return;
      }
      ctx.app.run(parsed.data.command);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/app/mkdir",
    wrap(async (req, res) => {
      const parsed = workspaceFileSchema.safeParse(req.body);
      res.status(parsed.success && (await makeAppDir(parsed.data.path)) ? 200 : 400).json(await listTree());
    }),
  );

  app.post(
    "/api/app/delete",
    wrap(async (req, res) => {
      const parsed = workspaceFileSchema.safeParse(req.body);
      res.status(parsed.success && (await deleteAppPath(parsed.data.path)) ? 200 : 400).json(await listTree());
    }),
  );

  app.post(
    "/api/app/rename",
    wrap(async (req, res) => {
      const parsed = appRenameSchema.safeParse(req.body);
      res.status(parsed.success && (await renameAppPath(parsed.data.from, parsed.data.to)) ? 200 : 400).json(await listTree());
    }),
  );

  app.post(
    "/api/app/stop",
    wrap(async (_req, res) => {
      await ctx.app.stopApp();
      res.json({ ok: true });
    }),
  );

  // What the inject picker offers: GET routes NightShift's traffic reaches, and the bug catalog.
  app.get(
    "/api/app/inject-options",
    wrap(async (_req, res) => {
      res.json({
        targets: await listTargets(),
        kinds: BUG_KINDS.map((id) => ({ id, label: BUG_CATALOG[id].label, effect: BUG_CATALOG[id].effect })),
      });
    }),
  );

  app.post(
    "/api/app/inject",
    wrap(async (req, res) => {
      const parsed = appInjectSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "unknown route or bug kind" });
        return;
      }
      const injection = await ctx.app.inject(parsed.data);
      res.json(
        injection
          ? { file: injection.file, route: injection.route, kind: injection.kind, description: injection.description, injectedBy: injection.injectedBy }
          : null,
      );
    }),
  );

  app.get("/api/app/state", (_req, res) => {
    res.json(ctx.app.state());
  });

  app.get("/api/logs", (_req, res) => {
    res.json(ctx.recentLogs());
  });

  app.get(
    "/api/workspace/tree",
    wrap(async (_req, res) => {
      res.json(await workspaceTree());
    }),
  );

  app.get(
    "/api/workspace/file",
    wrap(async (req, res) => {
      const parsed = workspaceFileSchema.safeParse(req.query);
      const content = parsed.success ? await workspaceFile(parsed.data.path).catch(() => null) : null;
      if (!parsed.success || content === null) {
        res.status(404).json({ error: "file not in the workspace" });
        return;
      }
      res.json({ path: parsed.data.path, content });
    }),
  );

  app.get("/api/services", (_req, res) => {
    res.json(ctx.registry.list());
  });

  app.post(
    "/api/services",
    wrap(async (req, res) => {
      const parsed = serviceUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
      }
      const record = await ctx.registry.update(parsed.data.name, {
        dependencies: parsed.data.dependencies,
        allowedFixTypes: parsed.data.allowedFixTypes,
      });
      res.json(record);
    }),
  );

  app.post(
    "/api/capture",
    wrap(async (req, res) => {
      const parsed = captureSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
      }
      await repo.insertCapture(ctx.db, {
        ...parsed.data,
        headers: maskHeaders(parsed.data.headers),
        body: maskDeep(parsed.data.body),
      });
      res.status(202).end();
    }),
  );

  app.get(
    "/api/captures",
    wrap(async (req, res) => {
      const service = String(req.query.service ?? "orders");
      const limit = Math.min(Number(req.query.limit ?? 20), 200);
      if (!(SERVICE_NAMES as readonly string[]).includes(service)) {
        res.status(400).json({ error: "unknown service" });
        return;
      }
      res.json(await repo.listCaptures(ctx.db, service as ServiceName, limit));
    }),
  );

  app.post(
    "/api/reset",
    wrap(async (_req, res) => {
      const reset = await ctx.reset();
      if (!reset) {
        res.status(409).json({ error: "a remediation or reset is already in progress" });
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/incidents",
    wrap(async (_req, res) => {
      res.json(await repo.listIncidents(ctx.db, 50));
    }),
  );

  app.get(
    "/api/incidents/:id",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const incident = await repo.getIncident(ctx.db, id);
      if (!incident) {
        res.status(404).json({ error: "incident not found" });
        return;
      }
      res.json({ ...incident, attempts: await repo.listAttempts(ctx.db, id), timing: healTiming(incident) });
    }),
  );

  app.post(
    "/api/approvals/:id",
    wrap(async (req, res) => {
      const parsed = approvalSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
      }
      const decided = ctx.approvals.decide(String(req.params.id), parsed.data.decision);
      if (!decided) {
        res.status(404).json({ error: "no pending approval with that id" });
        return;
      }
      res.status(202).json({ decision: parsed.data.decision });
    }),
  );

  app.get(
    "/api/receipts/:incidentId",
    wrap(async (req, res) => {
      const receipt = await repo.getReceipt(ctx.db, String(req.params.incidentId));
      if (!receipt) {
        res.status(404).json({ error: "no receipt for that incident yet" });
        return;
      }
      res.json(receipt);
    }),
  );

  app.get(
    "/api/audit",
    wrap(async (_req, res) => {
      res.json(await repo.listAudit(ctx.db, 200));
    }),
  );

  app.post(
    "/api/chaos",
    wrap(async (req, res) => {
      const parsed = chaosSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
      }
      const { service, fault, rate, mode } = parsed.data;
      await injectFault(ctx.registry.get(service), fault, { rate, mode });
      const grayLabel = fault === "gray" ? ` (${Math.round((rate ?? 0.2) * 100)}% ${mode ?? "mixed"})` : "";
      await ctx.audit({
        actor: "chaos-button",
        action: "chaos.injected",
        trigger: `${fault ?? "clear"}${grayLabel} on ${service}`,
        incidentId: null,
        details: { service, fault, rate, mode },
      });
      res.status(202).json({ service, fault });
    }),
  );
}
