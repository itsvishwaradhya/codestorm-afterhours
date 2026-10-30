import type { ReactNode } from "react";
import type {
  Attempt,
  AuditEntry,
  FaultType,
  GrayFault,
  Impact,
  Incident,
  Receipt,
  ServiceRecord,
  Snapshot,
  WindowMetrics,
} from "@nightshift/shared";
import type { CapStatus, GuardStatus, ImpactSummary, IncidentDetail } from "./api.ts";

type Tone = "green" | "red" | "amber" | "blue" | "slate";

const TONES: Record<Tone, string> = {
  green: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  red: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  amber: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  blue: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  slate: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const STATE_TONE: Record<string, Tone> = {
  resolved: "green",
  escalated: "red",
  awaiting_approval: "amber",
  rate_limited: "amber",
  suppressed: "amber",
  watching: "blue",
  promoting: "blue",
  verifying: "blue",
  diagnosed: "slate",
  detected: "slate",
};

export function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? "slate"}>{state.replace(/_/g, " ")}</Badge>;
}

export function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleTimeString() : "";
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

const FAULTS: { label: string; fault: FaultType | null; gray?: Partial<GrayFault> }[] = [
  { label: "Crash", fault: "crash" },
  { label: "Slow", fault: "slow" },
  { label: "Memory leak", fault: "memory_leak" },
  { label: "Bad config", fault: "bad_config" },
  { label: "Gray 20% errors", fault: "gray", gray: { rate: 0.2, mode: "error" } },
  { label: "Gray 20% slow", fault: "gray", gray: { rate: 0.2, mode: "slow" } },
  { label: "Clear", fault: null },
];

// Matches the healer's gray thresholds: health passes, but users are not being served well.
function isDegraded(snapshot: Snapshot): boolean {
  return snapshot.reachable && snapshot.healthy && (snapshot.errorRate >= 0.05 || (snapshot.slowRate ?? 0) >= 0.05);
}

const seconds = (ms: number) => `${Math.ceil(ms / 1000)} s`;

export function ServiceCard({
  service,
  snapshot,
  role,
  guard,
  onChaos,
  onResetGuard,
}: {
  service: ServiceRecord;
  snapshot: Snapshot | undefined;
  role: "root" | "symptom" | null;
  guard: GuardStatus | undefined;
  onChaos: (fault: FaultType | null, gray?: Partial<GrayFault>) => void;
  onResetGuard: () => void;
}) {
  const health = !snapshot
    ? { label: "Waiting", tone: "slate" as Tone }
    : !snapshot.reachable
      ? { label: "Unreachable", tone: "red" as Tone }
      : !snapshot.healthy
        ? { label: "Unhealthy", tone: "red" as Tone }
        : isDegraded(snapshot)
          ? { label: "Degraded (health check OK)", tone: "amber" as Tone }
          : { label: "Healthy", tone: "green" as Tone };

  const ring = role === "root" ? "ring-2 ring-rose-500/60" : role === "symptom" ? "ring-1 ring-amber-500/40" : "ring-1 ring-slate-800";

  return (
    <div className={`rounded-xl bg-slate-900/70 p-4 ${ring}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold capitalize">{service.name}</h3>
          <p className="text-xs text-slate-500">port {service.port}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone={health.tone}>{health.label}</Badge>
          {role === "root" && <Badge tone="red">Root cause</Badge>}
          {role === "symptom" && <Badge tone="amber">Symptom</Badge>}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-4 gap-2 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Errors</dt>
          <dd>{snapshot?.reachable ? percent(snapshot.errorRate) : "-"}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Slow &gt;1s</dt>
          <dd>{snapshot?.reachable ? percent(snapshot.slowRate ?? 0) : "-"}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">p95</dt>
          <dd>{snapshot?.reachable ? `${Math.round(snapshot.p95LatencyMs)} ms` : "-"}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Memory</dt>
          <dd>{snapshot?.reachable ? `${snapshot.memoryMb} MB` : "-"}</dd>
        </div>
      </dl>

      {snapshot?.activeFault && (
        <p className="mt-2 text-xs text-amber-300">Active fault: {snapshot.activeFault.replace(/_/g, " ")}</p>
      )}

      {guard && guard.breaker === "open" && (
        <div className="mt-2 rounded-md bg-rose-500/10 px-2 py-1.5 text-xs text-rose-200 ring-1 ring-rose-500/30">
          <p className="font-medium">Auto-healing paused for {seconds(guard.breakerRemainingMs)}</p>
          <p className="text-rose-300/80">{guard.breakerReason}</p>
          <button onClick={onResetGuard} className="mt-1 underline hover:text-white">
            Reset breaker
          </button>
        </div>
      )}
      {guard && guard.breaker !== "open" && guard.cooldownRemainingMs > 0 && (
        <p className="mt-2 text-xs text-sky-300">
          Cooling down {seconds(guard.cooldownRemainingMs)} after {guard.recentActions} recent action(s)
        </p>
      )}
      {guard?.breaker === "half_open" && (
        <p className="mt-1 text-xs text-amber-300">Breaker half-open: one more repeat will pause auto-healing</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {FAULTS.map((entry) => (
          <button
            key={entry.label}
            onClick={() => onChaos(entry.fault, entry.gray)}
            className="rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700 active:bg-slate-600"
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CapPill({ cap }: { cap: CapStatus }) {
  const tone: Tone = cap.remaining === 0 ? "red" : cap.remaining === 1 ? "amber" : "green";
  return (
    <Badge tone={tone}>
      Automatic actions {cap.used}/{cap.max} in {cap.windowMinutes} min
      {cap.remaining === 0 ? " (rate limit reached)" : ""}
    </Badge>
  );
}

export function ApprovalsPanel({
  attempts,
  onDecide,
}: {
  attempts: Attempt[];
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  if (attempts.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <h2 className="font-semibold text-amber-200">Waiting for your approval</h2>
      <p className="mt-1 text-sm text-slate-300">
        These fixes passed the shadow test but are risky, so NightShift will not apply them without you.
      </p>
      <ul className="mt-3 space-y-3">
        {attempts.map((attempt) => (
          <li key={attempt.id} className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">{attempt.label}</p>
              <p className="text-xs text-slate-400">
                {attempt.risk} risk. Shadow error rate {percent(attempt.candidateMetrics.errorRate)} against baseline{" "}
                {percent(attempt.baseline.errorRate)}.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => onDecide(attempt.id, "approve")}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
              >
                Approve
              </button>
              <button
                onClick={() => onDecide(attempt.id, "reject")}
                className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-slate-600"
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const IMPACT_TONE: Record<Impact, Tone> = { helped: "green", no_effect: "slate", hurt: "red", temporary: "amber" };

export function ImpactBadge({ impact }: { impact: Impact | null | undefined }) {
  if (!impact) return <span className="text-slate-500">-</span>;
  return <Badge tone={IMPACT_TONE[impact]}>{impact.replace(/_/g, " ")}</Badge>;
}

function metricsLine(metrics: WindowMetrics): string {
  return `${percent(metrics.errorRate)} err, ${percent(metrics.slowRate ?? 0)} slow, ${Math.round(metrics.p95LatencyMs)} ms p95`;
}

export function AttemptsTable({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) {
    return <p className="text-sm text-slate-400">No fix was tested for this incident.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-200 text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr>
            <th className="py-2 pr-3">Fix</th>
            <th className="py-2 pr-3">Verdict</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Baseline</th>
            <th className="py-2 pr-3">Shadow</th>
            <th className="py-2 pr-3">Samples</th>
            <th className="py-2 pr-3">Production after</th>
            <th className="py-2 pr-3">Downtime</th>
            <th className="py-2 pr-3">Impact</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((attempt) => (
            <tr key={attempt.id} className="border-t border-slate-800 align-top">
              <td className="py-2 pr-3">
                <div className="font-medium">{attempt.label}</div>
                <div className="text-xs text-slate-500">{attempt.risk} risk</div>
              </td>
              <td className="py-2 pr-3">
                <Badge tone={attempt.verdict === "promote" ? "green" : "red"}>{attempt.verdict}</Badge>
              </td>
              <td className="py-2 pr-3 text-slate-300">{attempt.status.replace(/_/g, " ")}</td>
              <td className="py-2 pr-3">
                {percent(attempt.baseline.errorRate)} errors, {Math.round(attempt.baseline.p95LatencyMs)} ms p95
              </td>
              <td className="py-2 pr-3">
                {percent(attempt.candidateMetrics.errorRate)} errors, {Math.round(attempt.candidateMetrics.p95LatencyMs)} ms
                p95
              </td>
              <td className="py-2 pr-3">{attempt.sampleSize}</td>
              <td className="py-2 pr-3">{attempt.prodAfter ? metricsLine(attempt.prodAfter) : "-"}</td>
              <td className="py-2 pr-3">
                {attempt.actionDowntimeMs != null ? `${(attempt.actionDowntimeMs / 1000).toFixed(1)} s` : "-"}
              </td>
              <td className="py-2 pr-3">
                <ImpactBadge impact={attempt.impact} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-2 space-y-1 text-xs text-slate-400">
        {attempts.map((attempt) => (
          <li key={attempt.id}>
            {attempt.label}: {attempt.reasons.join("; ")}
            {attempt.impactReasons && attempt.impactReasons.length > 0 && (
              <span className="text-slate-300"> Impact: {attempt.impactReasons.join("; ")}.</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IncidentView({ detail, receipt }: { detail: IncidentDetail | null; receipt: Receipt | null }) {
  if (!detail) {
    return (
      <section className="rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-800">
        <p className="text-sm text-slate-400">No incidents yet. Press a Crash, Slow, Memory leak, Bad config or Gray button to start one.</p>
      </section>
    );
  }
  return (
    <section className="space-y-4 rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-800">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Incident {detail.id.slice(0, 8)}</h2>
          <p className="text-xs text-slate-500">
            Opened {time(detail.openedAt)}
            {detail.closedAt ? `, closed ${time(detail.closedAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StateBadge state={detail.state} />
          {detail.failure && <Badge tone="slate">{detail.failure.replace(/_/g, " ")}</Badge>}
          {detail.recurrenceOf && (
            <Badge tone="amber">
              Recurrence #{(detail.recurrenceCount ?? 0) + 1} of {detail.recurrenceOf.slice(0, 8)}
            </Badge>
          )}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase text-slate-500">Diagnosis</h3>
          <p className="mt-1 text-sm">
            Root cause: <span className="font-semibold capitalize text-rose-300">{detail.rootCause ?? "unknown"}</span>
          </p>
          {detail.symptoms.length > 0 && (
            <p className="text-sm text-slate-300">Symptoms only: {detail.symptoms.join(", ")}</p>
          )}
          <ul className="mt-2 space-y-1 text-xs text-slate-400">
            {detail.causes.map((cause) => (
              <li key={cause.service}>{cause.reason}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase text-slate-500">Timeline</h3>
          <ol className="mt-1 space-y-1 text-sm">
            {detail.stateHistory.map((entry, index) => (
              <li key={`${entry.state}-${index}`} className="flex gap-2">
                <span className="w-20 shrink-0 text-xs text-slate-500">{time(entry.at)}</span>
                <span>{entry.state.replace(/_/g, " ")}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {detail.outcome && (
        <p className="rounded-md bg-slate-950 px-3 py-2 text-sm">
          Outcome: <span className="font-medium">{detail.outcome}</span>
        </p>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Shadow verification and production impact</h3>
        <AttemptsTable attempts={detail.attempts} />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">
          Heal receipt{receipt ? ` (worded by ${receipt.wordedBy})` : ""}
        </h3>
        {receipt ? (
          <pre className="whitespace-pre-wrap rounded-md bg-slate-950 p-3 text-sm leading-relaxed text-slate-200">
            {receipt.text}
          </pre>
        ) : (
          <p className="text-sm text-slate-400">The receipt is written when the incident closes.</p>
        )}
      </div>
    </section>
  );
}

export function IncidentList({
  incidents,
  selectedId,
  onSelect,
}: {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-800">
      <h2 className="font-semibold">Incidents</h2>
      {incidents.length === 0 && <p className="mt-2 text-sm text-slate-400">None yet.</p>}
      <ul className="mt-3 space-y-2">
        {incidents.slice(0, 15).map((incident) => (
          <li key={incident.id}>
            <button
              onClick={() => onSelect(incident.id)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                incident.id === selectedId ? "bg-slate-800" : "hover:bg-slate-800/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="capitalize">{incident.rootCause ?? "unknown"}</span>
                <StateBadge state={incident.state} />
              </div>
              <div className="text-xs text-slate-500">{time(incident.openedAt)}</div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function HealerScorecard({ impact }: { impact: ImpactSummary | null }) {
  const counts = impact?.counts ?? { helped: 0, no_effect: 0, hurt: 0, temporary: 0 };
  const total = counts.helped + counts.no_effect + counts.hurt + counts.temporary;
  const cells: Impact[] = ["helped", "temporary", "no_effect", "hurt"];
  return (
    <section className="rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-800">
      <h2 className="font-semibold">Did the healer help?</h2>
      <p className="mt-1 text-xs text-slate-400">Every automatic action, judged on production before and after it ran.</p>
      {total === 0 ? (
        <p className="mt-2 text-sm text-slate-400">No automatic actions yet.</p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          {cells.map((cell) => (
            <div key={cell} className="flex items-center justify-between rounded-md bg-slate-950 px-2 py-1.5">
              <dt>
                <ImpactBadge impact={cell} />
              </dt>
              <dd className="font-semibold">{counts[cell]}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function AuditFeed({ entries }: { entries: AuditEntry[] }) {
  return (
    <section className="rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-800">
      <h2 className="font-semibold">Audit trail</h2>
      <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto pr-1 text-xs">
        {entries.map((entry) => (
          <li key={entry.id} className="border-b border-slate-800 pb-2">
            <div className="flex justify-between gap-2 text-slate-500">
              <span>{time(entry.at)}</span>
              <span>{entry.actor}</span>
            </div>
            <div className="text-slate-200">{entry.action}</div>
            <div className="text-slate-400">{entry.trigger}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
