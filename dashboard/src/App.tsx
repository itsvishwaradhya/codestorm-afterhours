import { useEffect, useState } from "react";
import { SERVICE_NAMES, type FaultType, type GrayFault, type ServiceName } from "@nightshift/shared";
import { AlertTriangle, PlugZap, RefreshCw, X } from "lucide-react";
import { api } from "./api.ts";
import { useDashboard, useIncidentDetail } from "./useDashboard.ts";
import { AgentPipeline, OnWatch } from "@/components/app/agent-pipeline";
import { ApprovalsBanner } from "@/components/app/approvals";
import { AuditFeed } from "@/components/app/audit-feed";
import { GuardrailCard, ImpactCard } from "@/components/app/guardrails";
import { IncidentDetailView } from "@/components/app/incident-detail";
import { IncidentList } from "@/components/app/incident-list";
import { KpiCards, KpiSkeleton } from "@/components/app/kpi-cards";
import { ServiceCard } from "@/components/app/service-card";
import { ServiceMap } from "@/components/app/service-map";
import { Sidebar, Topbar, type View } from "@/components/app/shell";
import { Workspace } from "@/components/app/workspace-modes";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { healthOf } from "@/lib/format";

function ServiceSkeletons() {
  return (
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 4 }, (_, cell) => (
              <Skeleton key={cell} className="h-8" />
            ))}
          </div>
          <Skeleton className="h-7 w-full" />
        </div>
      ))}
    </div>
  );
}

function Offline({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border bg-card p-8 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-full bg-amber-400/10 text-amber-300">
        <PlugZap className="size-6" />
      </span>
      <h2 className="mt-4 font-semibold">Can't reach the healer</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The dashboard expects the healer on port 4000. Start it with <code className="font-mono text-foreground">npm start</code>.
      </p>
      <p className="mt-2 font-mono text-xs text-muted-foreground">{error}</p>
      <Button className="mt-5" variant="outline" onClick={onRetry}>
        <RefreshCw />
        Retry
      </Button>
    </div>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 6000);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-rose-500/30 bg-popover p-3.5 shadow-2xl animate-in fade-in slide-in-from-bottom-4">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-400" />
      <div className="flex-1 text-sm">
        <p className="font-medium">Action failed</p>
        <p className="text-muted-foreground">{message}</p>
      </div>
      <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
        <X className="size-4" />
      </button>
    </div>
  );
}

export default function App() {
  const { health, incidents, audit, impact, scorecard, history, connected, loaded, error, refresh } = useDashboard();
  const [view, setView] = useState<View>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const active = health?.activeIncident ?? null;
  const shownId = selectedId ?? active?.id ?? incidents[0]?.id ?? null;
  const { detail, receipt, loading } = useIncidentDetail(shownId, incidents);
  const latestId = active?.id ?? incidents[0]?.id ?? null;
  const { detail: latestDetail, receipt: latestReceipt, loading: latestLoading } = useIncidentDetail(latestId, incidents);

  const pendingIds = health?.pendingApprovals ?? [];
  const pendingAttempts = (latestDetail?.attempts ?? []).filter((attempt) => pendingIds.includes(attempt.id));

  // Keep the agent panel on the most recent incident for a short while after it closes,
  // so the audience sees the receipt being written and the final outcome.
  const latest = incidents[0];
  const recentlyClosed =
    latest && latest.closedAt && Date.now() - Date.parse(latest.closedAt) < 45_000 ? latest : null;
  const agentIncident = active ?? recentlyClosed;

  // Request-flow order (orders, then its dependencies) reads better than alphabetical.
  const services = [...(health?.services ?? [])].sort(
    (a, b) => SERVICE_NAMES.indexOf(a.name) - SERVICE_NAMES.indexOf(b.name),
  );
  const snapshots = health?.snapshots ?? [];
  const healthyCount = services.filter(
    (service) => healthOf(snapshots.find((snapshot) => snapshot.service === service.name)) === "healthy",
  ).length;

  const roleFor = (service: ServiceName): "root" | "symptom" | null => {
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
  const decide = (attemptId: string, decision: "approve" | "reject") => runAction(() => api.decide(attemptId, decision));

  const openIncident = (id: string) => {
    setSelectedId(id);
    setView("incidents");
  };

  return (
    <TooltipProvider>
      <div className="flex min-h-screen bg-background">
        <Sidebar view={view} onView={setView} openIncident={active !== null} connected={connected} />
        <div className="min-w-0 flex-1">
          <Topbar view={view} onView={setView} connected={connected} />
          <main className="mx-auto max-w-[1440px] space-y-4 p-4 lg:p-6">
            {loaded && !health && error ? (
              <Offline error={error} onRetry={() => void refresh()} />
            ) : (
              <>
                <ApprovalsBanner attempts={pendingAttempts} onDecide={(id, decision) => void decide(id, decision)} />

                {view === "overview" && (
                  <>
                    <div>
                      <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
                      <p className="text-sm text-muted-foreground">
                        Live health, the agent's current work, and every guardrail it applied.
                      </p>
                    </div>

                    {!health ? (
                      <Skeleton className="h-24 w-full rounded-xl" />
                    ) : agentIncident ? (
                      <AgentPipeline
                        incident={agentIncident}
                        hasReceipt={latestReceipt !== null && latestReceipt.incidentId === agentIncident.id}
                      />
                    ) : (
                      <OnWatch services={services.length} healthy={healthyCount} />
                    )}

                    {health ? (
                      <KpiCards
                        services={services.length}
                        healthy={healthyCount}
                        activeIncident={active !== null}
                        scorecard={scorecard}
                        cap={health.cap}
                      />
                    ) : (
                      <KpiSkeleton />
                    )}

                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                      <div className="min-w-0 space-y-4">
                        {health ? (
                          <>
                            <ServiceMap services={services} snapshots={snapshots} roleFor={roleFor} />
                            <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
                              {services.map((service) => (
                                <ServiceCard
                                  key={service.name}
                                  service={service}
                                  snapshot={snapshots.find((snapshot) => snapshot.service === service.name)}
                                  history={history[service.name] ?? []}
                                  role={roleFor(service.name)}
                                  guard={health.guard?.find((entry) => entry.service === service.name)}
                                  onChaos={(fault, gray) => void chaos(service.name, fault, gray)}
                                  onResetGuard={() => void runAction(() => api.resetGuard(service.name))}
                                />
                              ))}
                            </div>
                          </>
                        ) : (
                          <>
                            <Skeleton className="h-72 w-full rounded-xl" />
                            <ServiceSkeletons />
                          </>
                        )}
                        <div className="flex items-center justify-between pt-2">
                          <h2 className="text-sm font-semibold">Latest incident</h2>
                          {latestId && (
                            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openIncident(latestId)}>
                              Open in Incidents →
                            </Button>
                          )}
                        </div>
                        <IncidentDetailView detail={latestDetail} receipt={latestReceipt} loading={!loaded || latestLoading} />
                      </div>
                      <div className="min-w-0 space-y-4">
                        <GuardrailCard scorecard={scorecard} />
                        <ImpactCard impact={impact} />
                        <AuditFeed entries={audit.slice(0, 30)} loaded={loaded} height="h-[360px]" />
                      </div>
                    </div>
                  </>
                )}

                {view === "workspace" && (
                  <Workspace
                    snapshots={snapshots}
                    incidents={incidents}
                    activeIncident={active}
                    pendingAttempts={pendingAttempts}
                    scorecard={scorecard}
                    roleFor={roleFor}
                    onChaos={(service, fault) => chaos(service, fault)}
                    onDecide={decide}
                  />
                )}

                {view === "incidents" && (
                  <>
                    <div>
                      <h1 className="text-xl font-semibold tracking-tight">Incidents</h1>
                      <p className="text-sm text-muted-foreground">
                        Root cause, shadow-test evidence, production impact and the Heal Receipt for every incident.
                      </p>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
                      <IncidentList
                        incidents={incidents}
                        selectedId={shownId}
                        onSelect={setSelectedId}
                        loaded={loaded}
                        className="lg:sticky lg:top-20 lg:self-start"
                      />
                      <IncidentDetailView detail={detail} receipt={receipt} loading={!loaded || loading} />
                    </div>
                  </>
                )}

                {view === "audit" && (
                  <>
                    <div>
                      <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
                      <p className="text-sm text-muted-foreground">
                        Every detection, verdict, action and operator decision, newest first.
                      </p>
                    </div>
                    <AuditFeed entries={audit} loaded={loaded} height="h-[calc(100vh-220px)]" />
                  </>
                )}
              </>
            )}
          </main>
        </div>
      </div>
      {actionError && <Toast message={actionError} onClose={() => setActionError(null)} />}
    </TooltipProvider>
  );
}
