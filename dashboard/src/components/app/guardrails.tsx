import type { Impact } from "@nightshift/shared";
import {
  Ban,
  FlaskConicalOff,
  Hand,
  ShieldCheck,
  Target,
  Undo2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { ImpactSummary, Scorecard } from "@/api";
import CountUp from "@/components/reactbits/CountUp";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const GUARDRAIL_ROWS: { key: Exclude<keyof Scorecard, "timeToFix">; label: string; detail: string; icon: LucideIcon }[] = [
  {
    key: "symptomRestartsAvoided",
    label: "Wrong-service restarts",
    detail: "Services that only looked broken because a dependency failed. A blind policy restarts them too.",
    icon: Target,
  },
  {
    key: "unprovenFixesBlocked",
    label: "Unproven fixes kept out",
    detail: "Fixes that failed the shadow replay or are not allowed in production.",
    icon: FlaskConicalOff,
  },
  {
    key: "restartStormsStopped",
    label: "Restart storms stopped",
    detail: "Incidents where the cooldown or circuit breaker held back another restart.",
    icon: Ban,
  },
  {
    key: "riskyFixesHeld",
    label: "Risky fixes held",
    detail: "Medium and high-risk fixes that waited for a human instead of running.",
    icon: Hand,
  },
  {
    key: "badFixesRolledBack",
    label: "Bad fixes rolled back",
    detail: "Fixes that made production worse during the watch and were undone.",
    icon: Undo2,
  },
];

export function GuardrailCard({ scorecard }: { scorecard: Scorecard | null }) {
  const total = scorecard ? GUARDRAIL_ROWS.reduce((sum, row) => sum + scorecard[row.key], 0) : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          What blind auto-restart would have done
        </CardTitle>
        <CardDescription>
          Actions a restart-whatever-alerts policy takes that NightShift refused. Counted from the incident record.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!scorecard ? (
          <div className="space-y-2">
            {GUARDRAIL_ROWS.map((row) => (
              <Skeleton key={row.key} className="h-10 w-full" />
            ))}
          </div>
        ) : total === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            <Zap className="mx-auto mb-2 size-4 text-amber-400" />
            Nothing yet. Inject a fault to see the guardrails work.
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {GUARDRAIL_ROWS.map((row) => {
              const value = scorecard[row.key];
              return (
                <Tooltip key={row.key}>
                  <TooltipTrigger asChild>
                    <li className="flex cursor-default items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/50">
                      <span
                        className={cn(
                          "grid size-7 shrink-0 place-items-center rounded-md",
                          value > 0 ? "bg-amber-400/15 text-amber-300" : "bg-muted text-muted-foreground",
                        )}
                      >
                        <row.icon className="size-3.5" />
                      </span>
                      <span className="flex-1 text-sm">{row.label}</span>
                      <span className={cn("tabular font-mono text-base font-semibold", value > 0 ? "text-foreground" : "text-muted-foreground")}>
                        <CountUp to={value} duration={0.6} />
                      </span>
                    </li>
                  </TooltipTrigger>
                  <TooltipContent side="left">{row.detail}</TooltipContent>
                </Tooltip>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const IMPACT_ROWS: { impact: Impact; label: string; bar: string }[] = [
  { impact: "helped", label: "Helped", bar: "bg-success" },
  { impact: "temporary", label: "Temporary", bar: "bg-amber-400" },
  { impact: "no_effect", label: "No effect", bar: "bg-zinc-500" },
  { impact: "hurt", label: "Hurt", bar: "bg-rose-500" },
];

export function ImpactCard({ impact }: { impact: ImpactSummary | null }) {
  const counts = impact?.counts ?? { helped: 0, no_effect: 0, hurt: 0, temporary: 0 };
  const total = counts.helped + counts.no_effect + counts.hurt + counts.temporary;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Did the healer help?</CardTitle>
        <CardDescription>Every automatic action, judged on production before and after it ran.</CardDescription>
      </CardHeader>
      <CardContent>
        {!impact ? (
          <Skeleton className="h-16 w-full" />
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">No automatic actions yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              {IMPACT_ROWS.map((row) =>
                counts[row.impact] > 0 ? (
                  <div key={row.impact} className={row.bar} style={{ width: `${(counts[row.impact] / total) * 100}%` }} />
                ) : null,
              )}
            </div>
            <dl className="grid grid-cols-2 gap-2">
              {IMPACT_ROWS.map((row) => (
                <div key={row.impact} className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5 text-sm">
                  <dt className="flex items-center gap-2 text-muted-foreground">
                    <span className={cn("size-2 rounded-full", row.bar)} />
                    {row.label}
                  </dt>
                  <dd className="tabular font-mono font-semibold">{counts[row.impact]}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
