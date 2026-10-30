import { useState } from "react";
import type { Attempt, Receipt, WindowMetrics } from "@nightshift/shared";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  FileText,
  FlaskConical,
  GitBranch,
  History,
  RefreshCw,
  Sparkles,
  Stethoscope,
  Timer,
} from "lucide-react";
import type { HealTiming, IncidentDetail } from "@/api";
import ShinyText from "@/components/reactbits/ShinyText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { clock, humanize, percent, secs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ImpactBadge, STATE_ICON, StateBadge } from "./status";

const PHASE_COLOR: Record<string, string> = {
  "first bad sample": "bg-rose-500",
  detected: "bg-zinc-500",
  diagnosed: "bg-zinc-400",
  suppressed: "bg-amber-600",
  verifying: "bg-indigo-500",
  awaiting_approval: "bg-amber-400",
  rate_limited: "bg-amber-600",
  promoting: "bg-violet-500",
  watching: "bg-emerald-700",
};

function HealSummary({ detail, timing }: { detail: IncidentDetail; timing: HealTiming }) {
  const kept = detail.attempts.some((attempt) => attempt.status === "kept");
  const healed = detail.state === "resolved" && kept && timing.fixLiveSeconds !== null;
  const phases = [
    ...(timing.detectSeconds > 0 ? [{ state: "first bad sample", seconds: timing.detectSeconds }] : []),
    ...timing.phases,
  ];
  const total = phases.reduce((sum, phase) => sum + phase.seconds, 0);

  return (
    <div className="rounded-xl border bg-background/40 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {healed ? (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Time to heal</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="tabular text-3xl font-semibold tracking-tight text-emerald-300">
                {secs(timing.fixLiveSeconds ?? 0)}
              </span>
              <span className="text-sm text-muted-foreground">
                {timing.humanWaitSeconds > 0 ? `incl. ${secs(timing.humanWaitSeconds)} waiting for approval` : "no human paged"}
              </span>
            </p>
          </div>
        ) : (
          <div>
            <p className="text-xs font-medium text-muted-foreground">{detail.closedAt ? "Closed after" : "Running for"}</p>
            <p className="tabular mt-1 text-3xl font-semibold tracking-tight">
              {detail.closedAt ? secs(timing.confirmedSeconds ?? 0) : <ShinyText text="in progress" color="#a1a1aa" shineColor="#fff" speed={2} />}
            </p>
          </div>
        )}
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <div>
            <dt className="text-muted-foreground">Detected</dt>
            <dd className="tabular font-mono">{secs(timing.detectSeconds)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Fix live</dt>
            <dd className="tabular font-mono">{timing.fixLiveSeconds !== null ? secs(timing.fixLiveSeconds) : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Confirmed</dt>
            <dd className="tabular font-mono">{healed && timing.confirmedSeconds !== null ? secs(timing.confirmedSeconds) : "—"}</dd>
          </div>
        </dl>
      </div>
      {total > 0 && (
        <>
          <div className="mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full">
            {phases.map((phase, index) =>
              phase.seconds > 0 ? (
                <div
                  key={`${phase.state}-${index}`}
                  className={cn("h-full first:rounded-l-full last:rounded-r-full", PHASE_COLOR[phase.state] ?? "bg-rose-500")}
                  style={{ width: `${(phase.seconds / total) * 100}%` }}
                  title={`${humanize(phase.state)}: ${secs(phase.seconds)}`}
                />
              ) : null,
            )}
          </div>
          <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {phases
              .filter((phase) => phase.seconds > 0)
              .map((phase, index) => (
                <li key={`${phase.state}-${index}`} className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-sm", PHASE_COLOR[phase.state] ?? "bg-rose-500")} />
                  <span className="capitalize">{humanize(phase.state)}</span>
                  <span className="tabular font-mono text-foreground/80">{secs(phase.seconds)}</span>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Delta({ before, after, kind }: { before: number; after: number; kind: "rate" | "ms" }) {
  const diff = after - before;
  const flat = kind === "rate" ? Math.abs(diff) < 0.005 : Math.abs(diff) < 5;
  if (flat) return <ArrowRight className="size-3 text-muted-foreground" />;
  const better = diff < 0;
  const Icon = better ? ArrowDownRight : ArrowUpRight;
  return <Icon className={cn("size-3", better ? "text-success" : "text-rose-400")} />;
}

function MetricColumn({ title, metrics, base, accent }: { title: string; metrics: WindowMetrics | null | undefined; base?: WindowMetrics; accent?: string }) {
  return (
    <div className={cn("rounded-lg border bg-background/40 p-3", accent)}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {metrics ? (
        <dl className="mt-2 space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Errors</dt>
            <dd className="tabular flex items-center gap-1 font-mono">
              {base && <Delta before={base.errorRate} after={metrics.errorRate} kind="rate" />}
              {percent(metrics.errorRate)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">p95</dt>
            <dd className="tabular flex items-center gap-1 font-mono">
              {base && <Delta before={base.p95LatencyMs} after={metrics.p95LatencyMs} kind="ms" />}
              {Math.round(metrics.p95LatencyMs)}ms
            </dd>
          </div>
          {metrics.slowRate !== undefined && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Slow</dt>
              <dd className="tabular font-mono">{percent(metrics.slowRate)}</dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Requests</dt>
            <dd className="tabular font-mono">{metrics.requests}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">Not applied</p>
      )}
    </div>
  );
}

function AttemptCard({ attempt }: { attempt: Attempt }) {
  const promoted = attempt.verdict === "promote";
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 font-medium">
            <FlaskConical className="size-4 text-primary" />
            {attempt.label}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="capitalize">{attempt.risk}</span> risk · {attempt.sampleSize} replayed requests ·{" "}
            <span className="capitalize">{humanize(attempt.status)}</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant={promoted ? "success" : attempt.verdict === "reject" ? "destructive" : "warning"} className="capitalize">
            {promoted ? <Check /> : null}
            {attempt.verdict}
          </Badge>
          <ImpactBadge impact={attempt.impact} />
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <MetricColumn title="Production baseline" metrics={attempt.baseline} />
        <MetricColumn
          title="Shadow clone"
          metrics={attempt.candidateMetrics}
          base={attempt.baseline}
          accent={promoted ? "border-success/30" : "border-rose-500/30"}
        />
        <MetricColumn title="Production after" metrics={attempt.prodAfter} base={attempt.baseline} />
      </div>
      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
        {attempt.reasons.map((reason) => (
          <li key={reason} className="flex gap-1.5">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />
            {reason}
          </li>
        ))}
        {(attempt.impactReasons ?? []).map((reason) => (
          <li key={reason} className="flex gap-1.5 text-foreground/80">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
            {reason}
          </li>
        ))}
        {attempt.actionDowntimeMs != null && attempt.actionDowntimeMs > 0 && (
          <li className="flex gap-1.5">
            <Timer className="mt-0.5 size-3 shrink-0" />
            {(attempt.actionDowntimeMs / 1000).toFixed(1)}s of downtime caused by the action
          </li>
        )}
      </ul>
    </div>
  );
}

function ReceiptPanel({ receipt, closed }: { receipt: Receipt | null; closed: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!receipt) {
    return (
      <div className="rounded-xl border border-dashed p-5">
        {closed ? (
          <div className="space-y-2.5">
            <p className="flex items-center gap-2 text-sm">
              <Sparkles className="size-4 text-primary" />
              <ShinyText text="Writing the Heal Receipt…" color="#a1a1aa" shineColor="#fff" speed={1.6} />
            </p>
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">The receipt is written when the incident closes.</p>
        )}
      </div>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(receipt.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="rounded-xl border bg-background/40">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <FileText className="size-4 text-primary" />
          Heal Receipt
        </p>
        <div className="flex items-center gap-2">
          <Badge variant={receipt.wordedBy === "template" ? "muted" : "default"}>
            {receipt.wordedBy === "template" ? "Template" : <><Sparkles />Reworded by {receipt.wordedBy}</>}
          </Badge>
          <Button variant="ghost" size="xs" onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-sm leading-relaxed text-foreground/90">{receipt.text}</pre>
      {receipt.wordedBy !== "template" && (
        <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">
          The LLM only rewords. A rewording that adds a number or service name not in the facts is rejected.
        </p>
      )}
    </div>
  );
}

export function IncidentDetailView({
  detail,
  receipt,
  loading,
}: {
  detail: IncidentDetail | null;
  receipt: Receipt | null;
  loading: boolean;
}) {
  if (loading || !detail) {
    return loading ? <IncidentDetailSkeleton /> : (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          <Stethoscope className="mx-auto mb-3 size-6 opacity-60" />
          No incidents yet. Inject a fault from a service card to start one.
        </CardContent>
      </Card>
    );
  }
  const closed = detail.state === "resolved" || detail.state === "escalated";
  return (
    <Card className="gap-5">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">
              <span className="capitalize">{detail.rootCause ?? "Unknown service"}</span>
              {detail.failure && <span className="text-muted-foreground"> · {humanize(detail.failure)}</span>}
            </h2>
            <span className="font-mono text-xs text-muted-foreground">#{detail.id.slice(0, 8)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {detail.recurrenceOf && (
              <Badge variant="warning">
                <RefreshCw />
                Recurrence #{(detail.recurrenceCount ?? 0) + 1}
              </Badge>
            )}
            <StateBadge state={detail.state} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Opened {clock(detail.openedAt)}
          {detail.closedAt && ` · closed ${clock(detail.closedAt)}`}
          {detail.outcome && <> · <span className="text-foreground/80">{detail.outcome}</span></>}
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {detail.timing && <HealSummary detail={detail} timing={detail.timing} />}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border bg-background/40 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <GitBranch className="size-4 text-rose-400" />
              Root-cause analysis
            </p>
            <ul className="mt-3 space-y-2">
              {detail.causes.map((cause) => (
                <li key={cause.service} className="flex gap-2.5 text-xs">
                  <Badge variant={cause.service === detail.rootCause ? "destructive" : "warning"} className="capitalize">
                    {cause.service}
                  </Badge>
                  <span className="text-muted-foreground">{cause.reason}</span>
                </li>
              ))}
              {detail.causes.length === 0 && <li className="text-xs text-muted-foreground">Diagnosis pending.</li>}
            </ul>
          </div>
          <div className="rounded-xl border bg-background/40 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <History className="size-4 text-primary" />
              State timeline
            </p>
            <ol className="relative mt-3 space-y-2.5 border-l pl-4">
              {detail.stateHistory.map((entry, index) => {
                const Icon = STATE_ICON[entry.state];
                return (
                  <li key={`${entry.state}-${index}`} className="relative flex items-center justify-between gap-2 text-xs">
                    <span className="absolute -left-[22.5px] grid size-3 place-items-center rounded-full border bg-card">
                      <span className="size-1 rounded-full bg-primary" />
                    </span>
                    <span className="flex items-center gap-1.5 capitalize">
                      <Icon className="size-3 text-muted-foreground" />
                      {humanize(entry.state)}
                    </span>
                    <span className="tabular font-mono text-muted-foreground">{clock(entry.at)}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        <Tabs defaultValue="shadow">
          <TabsList>
            <TabsTrigger value="shadow">
              <FlaskConical />
              Shadow tests
              <Badge variant="muted" className="ml-0.5 px-1 py-0">{detail.attempts.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="receipt">
              <FileText />
              Heal Receipt
            </TabsTrigger>
          </TabsList>
          <TabsContent value="shadow" className="space-y-3">
            {detail.attempts.length === 0 ? (
              <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
                {closed ? "No fix was tested for this incident." : (
                  <ShinyText text="Preparing candidate fixes…" color="#a1a1aa" shineColor="#fff" speed={1.6} />
                )}
              </p>
            ) : (
              detail.attempts.map((attempt) => <AttemptCard key={attempt.id} attempt={attempt} />)
            )}
          </TabsContent>
          <TabsContent value="receipt">
            <ReceiptPanel receipt={receipt} closed={closed} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export function IncidentDetailSkeleton() {
  return (
    <Card className="gap-5">
      <CardHeader>
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-3 w-72" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-28 w-full rounded-xl" />
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </CardContent>
    </Card>
  );
}

