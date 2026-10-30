import type { FaultType, GrayFault, ServiceRecord, Snapshot } from "@nightshift/shared";
import {
  Bug,
  ChevronDown,
  CircleOff,
  CloudFog,
  Cpu,
  FileWarning,
  Gauge,
  Power,
  RotateCcw,
  ShieldOff,
  Snowflake,
  Timer,
  Turtle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { GuardStatus } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEALTH_META, healthOf, humanize, msToSecs, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";
import { StatusDot } from "./status";

type ChaosHandler = (fault: FaultType | null, gray?: Partial<GrayFault>) => void;

const FAULTS: { label: string; hint: string; icon: LucideIcon; fault: FaultType; gray?: Partial<GrayFault> }[] = [
  { label: "Crash", hint: "Process exits", icon: Power, fault: "crash" },
  { label: "Slow", hint: "+2s on every request", icon: Turtle, fault: "slow" },
  { label: "Memory leak", hint: "4 MB per request", icon: Cpu, fault: "memory_leak" },
  { label: "Bad config", hint: "Corrupt config, 500s", icon: FileWarning, fault: "bad_config" },
  { label: "Gray · 20% errors", hint: "Health check stays green", icon: CloudFog, fault: "gray", gray: { rate: 0.2, mode: "error" } },
  { label: "Gray · 20% slow", hint: "Health check stays green", icon: CloudFog, fault: "gray", gray: { rate: 0.2, mode: "slow" } },
];

export function ChaosMenu({ onChaos, compact = false }: { onChaos: ChaosHandler; compact?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={compact ? "xs" : "sm"} className="gap-1.5">
          <Zap className="text-amber-400" />
          Inject fault
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Chaos button</DropdownMenuLabel>
        {FAULTS.map((entry) => (
          <DropdownMenuItem key={entry.label} onSelect={() => onChaos(entry.fault, entry.gray)}>
            <entry.icon />
            <div className="flex flex-col">
              <span>{entry.label}</span>
              <span className="text-xs text-muted-foreground">{entry.hint}</span>
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChaos(null)}>
          <CircleOff />
          Clear fault
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  alert,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  alert?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </dt>
      <dd className={cn("tabular mt-0.5 truncate font-mono text-sm", alert ? "text-rose-400" : "text-foreground")}>
        {value}
      </dd>
    </div>
  );
}

export function ServiceCard({
  service,
  snapshot,
  history,
  role,
  guard,
  onChaos,
  onResetGuard,
}: {
  service: ServiceRecord;
  snapshot: Snapshot | undefined;
  history: Snapshot[];
  role: "root" | "symptom" | null;
  guard: GuardStatus | undefined;
  onChaos: ChaosHandler;
  onResetGuard: () => void;
}) {
  const level = healthOf(snapshot);
  const meta = HEALTH_META[level];
  const reachable = snapshot?.reachable ?? false;
  // The service keeps reporting bad_config after the healer reverts its config, so only
  // call the fault active while the config is actually corrupt.
  const fault =
    snapshot?.activeFault === "bad_config" && snapshot.configMode !== "corrupt" ? null : snapshot?.activeFault ?? null;
  const errors = history.map((entry) => (entry.reachable ? entry.errorRate : 1));
  const latency = history.map((entry) => (entry.reachable ? entry.p95LatencyMs : 0));

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors",
        role === "root" && "border-rose-500/50 shadow-[0_0_0_1px_rgba(244,63,94,0.25),0_0_32px_-8px_rgba(244,63,94,0.45)]",
        role === "symptom" && "border-amber-400/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot className={meta.dot} pulse={level !== "healthy" && level !== "waiting"} />
            <h3 className="truncate font-semibold capitalize">{service.name}</h3>
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            :{service.port}
            {service.dependencies.length > 0 && ` → ${service.dependencies.join(", ")}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={meta.variant}>{level === "degraded" ? "Degraded · health OK" : meta.label}</Badge>
          {role === "root" && <Badge variant="destructive">Root cause</Badge>}
          {role === "symptom" && <Badge variant="warning">Symptom</Badge>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">Error rate</div>
          <Sparkline values={errors} color={meta.stroke} floor={0.1} />
        </div>
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">p95 latency</div>
          <Sparkline values={latency} color="#818cf8" floor={200} />
        </div>
      </div>

      <dl className="grid grid-cols-4 gap-2">
        <Metric label="Errors" icon={Bug} value={reachable ? percent(snapshot!.errorRate) : "—"} alert={reachable && snapshot!.errorRate >= 0.05} />
        <Metric label="Slow" icon={Timer} value={reachable ? percent(snapshot!.slowRate ?? 0) : "—"} alert={reachable && (snapshot!.slowRate ?? 0) >= 0.05} />
        <Metric label="p95" icon={Gauge} value={reachable ? `${Math.round(snapshot!.p95LatencyMs)}ms` : "—"} alert={reachable && snapshot!.p95LatencyMs >= 1000} />
        <Metric label="Mem" icon={Cpu} value={reachable ? `${snapshot!.memoryMb}MB` : "—"} alert={reachable && snapshot!.memoryMb >= 250} />
      </dl>

      {guard?.breaker === "open" && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-rose-300">
            <ShieldOff className="size-3.5" />
            Auto-healing paused · {msToSecs(guard.breakerRemainingMs)}
          </p>
          <p className="mt-1 text-rose-200/80">{guard.breakerReason}</p>
          <Button variant="ghost" size="xs" className="mt-1.5 -ml-2 text-rose-200" onClick={onResetGuard}>
            <RotateCcw />
            Reset breaker
          </Button>
        </div>
      )}
      {guard && guard.breaker !== "open" && guard.cooldownRemainingMs > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-sky-300">
          <Snowflake className="size-3.5" />
          Cooling down {msToSecs(guard.cooldownRemainingMs)} after {guard.recentActions} recent action(s)
        </p>
      )}
      {guard?.breaker === "half_open" && (
        <p className="text-xs text-amber-300">Breaker half-open: one more repeat pauses auto-healing</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
        {fault ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="warning" className="cursor-default">
                <Zap />
                {humanize(fault)} injected
              </Badge>
            </TooltipTrigger>
            <TooltipContent>A chaos fault is active on this service.</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">No fault injected</span>
        )}
        <ChaosMenu onChaos={onChaos} compact />
      </div>
    </div>
  );
}
