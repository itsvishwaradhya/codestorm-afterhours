import { useState } from "react";
import type { FaultType, GrayFault, ServiceName } from "@nightshift/shared";
import { api } from "./api.ts";
import {
  ApprovalsPanel,
  AuditFeed,
  CapPill,
  HealerScorecard,
  IncidentList,
  IncidentView,
  ServiceCard,
} from "./components.tsx";
import { useDashboard, useIncidentDetail } from "./useDashboard.ts";

export default function App() {
  const { health, incidents, audit, impact, connected, error, refresh } = useDashboard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const activeId = health?.activeIncident?.id ?? null;
  const shownId = selectedId ?? activeId ?? incidents[0]?.id ?? null;
  const { detail, receipt } = useIncidentDetail(shownId, incidents);
  const { detail: activeDetail } = useIncidentDetail(activeId, incidents);

  const pendingIds = health?.pendingApprovals ?? [];
  const pendingAttempts = (activeDetail?.attempts ?? []).filter((attempt) => pendingIds.includes(attempt.id));

  const roleFor = (service: ServiceName): "root" | "symptom" | null => {
    const active = health?.activeIncident;
    if (!active) return null;
    if (active.rootCause === service) return "root";
    if (active.symptoms.includes(service)) return "symptom";
    return null;
  };

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "the action failed");
    }
  };

  const chaos = (service: string, fault: FaultType | null, gray?: Partial<GrayFault>) =>
    runAction(() => api.chaos(service, fault, gray));

  const decide = (attemptId: string, decision: "approve" | "reject") =>
    runAction(() => api.decide(attemptId, decision));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">NightShift</h1>
          <p className="text-xs text-slate-400">An on-call engineer that proves its fixes before applying them</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs ring-1 ${
              connected ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" : "bg-amber-500/15 text-amber-300 ring-amber-500/30"
            }`}
          >
            {connected ? "Live" : "Polling every 5 s"}
          </span>
          {health && <CapPill cap={health.cap} />}
        </div>
      </header>

      {(error || actionError) && (
        <div className="bg-rose-950/60 px-4 py-2 text-sm text-rose-200">{actionError ?? error}</div>
      )}

      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-3">
        <section className="space-y-4 lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(health?.services ?? []).map((service) => (
              <ServiceCard
                key={service.name}
                service={service}
                snapshot={health?.snapshots.find((snapshot) => snapshot.service === service.name)}
                role={roleFor(service.name)}
                guard={health?.guard?.find((entry) => entry.service === service.name)}
                onChaos={(fault, gray) => void chaos(service.name, fault, gray)}
                onResetGuard={() => void runAction(() => api.resetGuard(service.name))}
              />
            ))}
          </div>

          <ApprovalsPanel attempts={pendingAttempts} onDecide={(id, decision) => void decide(id, decision)} />

          <IncidentView detail={detail} receipt={receipt} />
        </section>

        <aside className="space-y-4">
          <HealerScorecard impact={impact} />
          <IncidentList incidents={incidents} selectedId={shownId} onSelect={setSelectedId} />
          <AuditFeed entries={audit} />
        </aside>
      </main>
    </div>
  );
}
