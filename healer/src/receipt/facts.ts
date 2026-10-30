import { z } from "zod";
import type { Attempt, Incident } from "@nightshift/shared";

const metricsSchema = z.object({
  errorRate: z.number(),
  p95LatencyMs: z.number(),
});

export const receiptFactsSchema = z.object({
  incidentId: z.string(),
  state: z.string(),
  rootCause: z.string().nullable(),
  symptoms: z.array(z.string()),
  failure: z.string().nullable(),
  anomalies: z.array(
    z.object({
      service: z.string(),
      kind: z.string(),
      value: z.number(),
      threshold: z.number(),
    }),
  ),
  causes: z.array(z.object({ service: z.string(), reason: z.string() })),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  outcome: z.string().nullable(),
  candidates: z.array(
    z.object({
      label: z.string(),
      risk: z.string(),
      verdict: z.string(),
      status: z.string(),
      reasons: z.array(z.string()),
      sampleSize: z.number(),
      baseline: metricsSchema,
      candidate: metricsSchema,
      impact: z.string().nullable(),
      impactReasons: z.array(z.string()),
      downtimeMs: z.number().nullable(),
    }),
  ),
  before: metricsSchema.nullable(),
  after: metricsSchema.nullable(),
  impact: z.string().nullable(),
  recurrenceOf: z.string().nullable(),
});

export type ReceiptFacts = z.infer<typeof receiptFactsSchema>;

export function buildFacts(incident: Incident, attempts: Attempt[]): ReceiptFacts {
  const decisive =
    [...attempts].reverse().find((attempt) => attempt.status === "kept" || attempt.status === "rolled_back") ??
    attempts[attempts.length - 1] ??
    null;
  const durationSeconds = incident.closedAt
    ? Math.round((Date.parse(incident.closedAt) - Date.parse(incident.openedAt)) / 1000)
    : null;

  return receiptFactsSchema.parse({
    incidentId: incident.id,
    state: incident.state,
    rootCause: incident.rootCause,
    symptoms: incident.symptoms,
    failure: incident.failure,
    anomalies: incident.anomalies.map((anomaly) => ({
      service: anomaly.service,
      kind: anomaly.kind,
      value: anomaly.value,
      threshold: anomaly.threshold,
    })),
    causes: incident.causes.map((cause) => ({ service: cause.service, reason: cause.reason })),
    openedAt: incident.openedAt,
    closedAt: incident.closedAt,
    durationSeconds,
    outcome: incident.outcome,
    candidates: attempts.map((attempt) => ({
      label: attempt.label,
      risk: attempt.risk,
      verdict: attempt.verdict,
      status: attempt.status,
      reasons: attempt.reasons,
      sampleSize: attempt.sampleSize,
      baseline: {
        errorRate: attempt.baseline.errorRate,
        p95LatencyMs: attempt.baseline.p95LatencyMs,
      },
      candidate: {
        errorRate: attempt.candidateMetrics.errorRate,
        p95LatencyMs: attempt.candidateMetrics.p95LatencyMs,
      },
      impact: attempt.impact ?? null,
      impactReasons: attempt.impactReasons ?? [],
      downtimeMs: attempt.actionDowntimeMs ?? null,
    })),
    before: decisive
      ? { errorRate: decisive.baseline.errorRate, p95LatencyMs: decisive.baseline.p95LatencyMs }
      : null,
    // Measured on production after the action, never the shadow replay.
    after: decisive?.prodAfter
      ? { errorRate: decisive.prodAfter.errorRate, p95LatencyMs: decisive.prodAfter.p95LatencyMs }
      : null,
    impact: decisive?.impact ?? null,
    recurrenceOf: incident.recurrenceOf ?? null,
  });
}
