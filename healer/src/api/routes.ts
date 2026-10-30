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
import type { ServiceRegistry } from "../registry.js";
import * as repo from "../store/repository.js";
import { approvalSchema, captureSchema, chaosSchema, serviceUpdateSchema } from "./schemas.js";

type AuditInput = Omit<AuditEntry, "id" | "at">;

export interface ApiContext {
  db: Db;
  registry: ServiceRegistry;
  latestSnapshots: () => Snapshot[];
  activeIncident: () => Incident | null;
  audit: (entry: AuditInput) => Promise<void>;
  approvals: ApprovalGate;
  cap: ActionCap;
  reset: () => Promise<boolean>;
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
    });
  });

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
      res.json({ ...incident, attempts: await repo.listAttempts(ctx.db, id) });
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
      const { service, fault } = parsed.data;
      await injectFault(ctx.registry.get(service), fault);
      await ctx.audit({
        actor: "chaos-button",
        action: "chaos.injected",
        trigger: `${fault ?? "clear"} on ${service}`,
        incidentId: null,
        details: { service, fault },
      });
      res.status(202).json({ service, fault });
    }),
  );
}
