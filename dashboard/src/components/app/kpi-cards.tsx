import type { ReactNode } from "react";
import { Activity, Siren, Timer, Zap, type LucideIcon } from "lucide-react";
import type { CapStatus, Scorecard } from "@/api";
import CountUp from "@/components/reactbits/CountUp";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function Kpi({
  label,
  icon: Icon,
  iconClass,
  children,
  footer,
}: {
  label: string;
  icon: LucideIcon;
  iconClass: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <SpotlightCard className="rounded-xl p-4" spotlightColor="rgba(129, 140, 248, 0.22)" intensity={0.8}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={cn("grid size-7 place-items-center rounded-md", iconClass)}>
          <Icon className="size-3.5" />
        </span>
      </div>
      <div className="tabular mt-3 text-2xl font-semibold tracking-tight">{children}</div>
      <div className="mt-2 text-xs text-muted-foreground">{footer}</div>
    </SpotlightCard>
  );
}

export function KpiCards({
  services,
  healthy,
  activeIncident,
  scorecard,
  cap,
}: {
  services: number;
  healthy: number;
  activeIncident: boolean;
  scorecard: Scorecard | null;
  cap: CapStatus;
}) {
  const fix = scorecard?.timeToFix;
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Kpi
        label="Services operational"
        icon={Activity}
        iconClass={healthy === services ? "bg-success/15 text-success" : "bg-rose-500/15 text-rose-400"}
        footer={healthy === services ? "All checks passing" : `${services - healthy} need attention`}
      >
        <CountUp to={healthy} duration={0.6} />
        <span className="text-muted-foreground">/{services}</span>
      </Kpi>
      <Kpi
        label="Active incident"
        icon={Siren}
        iconClass={activeIncident ? "bg-rose-500/15 text-rose-400" : "bg-muted text-muted-foreground"}
        footer={activeIncident ? "Agent is working on it" : "Quiet night"}
      >
        {activeIncident ? <span className="text-rose-300">1 open</span> : <span>None</span>}
      </Kpi>
      <Kpi
        label="Median time to heal"
        icon={Timer}
        iconClass="bg-primary/15 text-primary"
        footer={
          fix && fix.count > 0
            ? `fastest ${fix.fastestSeconds}s · ${fix.count} heal${fix.count === 1 ? "" : "s"}`
            : "First bad sample → fix live"
        }
      >
        {fix?.medianSeconds != null ? (
          <CountUp to={fix.medianSeconds} decimals={1} suffix="s" duration={0.8} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Kpi>
      <Kpi
        label="Automatic actions"
        icon={Zap}
        iconClass={cap.remaining === 0 ? "bg-rose-500/15 text-rose-400" : "bg-amber-400/15 text-amber-300"}
        footer={
          <div className="space-y-1.5">
            <Progress
              value={(cap.used / Math.max(cap.max, 1)) * 100}
              indicatorClassName={cap.remaining === 0 ? "bg-rose-500" : cap.remaining === 1 ? "bg-amber-400" : "bg-primary"}
            />
            <span>{cap.remaining === 0 ? "Cap reached, new fixes wait" : `per ${cap.windowMinutes} min rolling window`}</span>
          </div>
        }
      >
        {cap.used}
        <span className="text-muted-foreground">/{cap.max}</span>
      </Kpi>
    </div>
  );
}

export function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="size-7" />
          </div>
          <Skeleton className="mt-4 h-7 w-16" />
          <Skeleton className="mt-3 h-3 w-32" />
        </div>
      ))}
    </div>
  );
}
