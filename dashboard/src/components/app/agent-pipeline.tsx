import { useEffect, useState } from "react";
import type { Incident, IncidentState } from "@nightshift/shared";
import {
  Bot,
  Check,
  FileText,
  FlaskConical,
  Hand,
  Loader2,
  Radar,
  Rocket,
  ShieldCheck,
  Stethoscope,
  X,
  type LucideIcon,
} from "lucide-react";
import GradientText from "@/components/reactbits/GradientText";
import ShinyText from "@/components/reactbits/ShinyText";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { StateBadge } from "./status";

type StepId = "detect" | "diagnose" | "verify" | "approve" | "heal" | "explain";

interface Step {
  id: StepId;
  title: string;
  icon: LucideIcon;
  idle: string;
  work: string[];
}

// Each line describes what the healer is really doing at that point; nothing here is decorative copy.
const STEPS: Step[] = [
  { id: "detect", title: "Detect", icon: Radar, idle: "Two bad samples in a row", work: ["Confirming the anomaly on a second sample"] },
  {
    id: "diagnose",
    title: "Diagnose",
    icon: Stethoscope,
    idle: "Root cause from the dependency graph",
    work: ["Walking the dependency graph", "Separating the cause from its symptoms", "Waiting for the diagnosis to hold steady"],
  },
  {
    id: "verify",
    title: "Shadow verify",
    icon: FlaskConical,
    idle: "Fix proven on a clone first",
    work: [
      "Spawning a shadow clone on an isolated port",
      "Applying the candidate fix to the clone",
      "Replaying captured production requests",
      "Comparing error rate and p95 against the baseline",
    ],
  },
  { id: "approve", title: "Approval", icon: Hand, idle: "Risky fixes wait for a human", work: ["Waiting for an operator to approve or reject"] },
  {
    id: "heal",
    title: "Heal",
    icon: Rocket,
    idle: "Apply, then watch production",
    work: ["Applying the verified fix to production", "Watching production for regressions", "Ready to roll back if errors return"],
  },
  { id: "explain", title: "Explain", icon: FileText, idle: "Plain-English Heal Receipt", work: ["Writing the Heal Receipt"] },
];

const ACTIVE_STEP: Record<IncidentState, StepId> = {
  detected: "detect",
  diagnosed: "diagnose",
  suppressed: "verify",
  verifying: "verify",
  awaiting_approval: "approve",
  rate_limited: "heal",
  promoting: "heal",
  watching: "heal",
  resolved: "explain",
  escalated: "explain",
};

const SPECIAL_WORK: Partial<Record<IncidentState, string[]>> = {
  suppressed: ["Guard is holding the next action: cooling down to avoid a restart storm"],
  rate_limited: ["Action cap reached: waiting for capacity instead of piling on"],
  promoting: ["Applying the verified fix to production"],
  watching: ["Watching production for regressions", "Ready to roll back if errors return"],
};

function useTicker(active: boolean, ms: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return tick;
}

function elapsed(fromIso: string, toIso: string | null, now: number): string {
  const total = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : now) - Date.parse(fromIso)) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function AgentPipeline({ incident, hasReceipt }: { incident: Incident; hasReceipt: boolean }) {
  const closed = incident.state === "resolved" || incident.state === "escalated";
  const writing = closed && !hasReceipt;
  const live = !closed || writing;
  const tick = useTicker(live, 1000);
  const messageTick = Math.floor(tick / 2);
  const now = Date.now();

  const neededApproval = incident.stateHistory.some((entry) => entry.state === "awaiting_approval");
  const steps = STEPS.filter((step) => step.id !== "approve" || neededApproval || incident.state === "awaiting_approval");
  const activeIndex = steps.findIndex((step) => step.id === ACTIVE_STEP[incident.state]);
  const failed = incident.state === "escalated";
  const reached = new Set(incident.stateHistory.map((entry) => ACTIVE_STEP[entry.state]));
  const lastReached = [...steps].reverse().find((step) => step.id !== "explain" && reached.has(step.id))?.id;

  const statusOf = (step: Step, index: number): "done" | "active" | "failed" | "skipped" | "pending" => {
    if (!closed) return index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
    if (step.id === "explain") return writing ? "active" : "done";
    if (failed && step.id === lastReached) return "failed";
    return reached.has(step.id) ? "done" : "skipped";
  };

  return (
    <Card className="relative gap-0 overflow-hidden py-0">
      {live && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
          <div className="h-px w-1/3 animate-scan bg-gradient-to-r from-transparent via-primary to-transparent" />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="relative grid size-9 place-items-center rounded-lg bg-primary/15 text-primary">
            <Bot className="size-5" />
            {live && <span className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-primary" />}
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              NightShift agent
              <span className="font-mono text-xs font-normal text-muted-foreground">#{incident.id.slice(0, 8)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {incident.rootCause ? (
                <>
                  Root cause <span className="font-medium capitalize text-rose-300">{incident.rootCause}</span>
                  {incident.symptoms.length > 0 && <> · symptoms {incident.symptoms.join(", ")}</>}
                </>
              ) : (
                "Locating the root cause"
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono tabular">
            T+{elapsed(incident.openedAt, incident.closedAt, now)}
          </Badge>
          <StateBadge state={incident.state} />
        </div>
      </div>

      <ol className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-none xl:grid-flow-col xl:auto-cols-fr">
        {steps.map((step, index) => {
          const status = statusOf(step, index);
          const done = status === "done";
          const active = status === "active";
          const isFailedStep = status === "failed";
          const work = (index === activeIndex && SPECIAL_WORK[incident.state]) || step.work;
          const message = work[messageTick % work.length];
          return (
            <li key={step.id} className={cn("relative flex flex-col gap-2 bg-card p-4", active && "bg-primary/[0.06]")}>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full border text-muted-foreground",
                    done && "border-success/40 bg-success/15 text-success",
                    active && "border-primary/50 bg-primary/15 text-primary",
                    isFailedStep && "border-rose-500/40 bg-rose-500/15 text-rose-400",
                  )}
                >
                  {isFailedStep ? (
                    <X className="size-3.5" />
                  ) : done ? (
                    <Check className="size-3.5" />
                  ) : active ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <step.icon className="size-3.5" />
                  )}
                </span>
                <span className={cn("text-sm font-medium", !done && !active && "text-muted-foreground")}>{step.title}</span>
              </div>
              <p className="min-h-8 text-xs leading-relaxed text-muted-foreground">
                {active ? (
                  <ShinyText key={message} text={message} color="#a1a1aa" shineColor="#ffffff" speed={1.8} className="text-xs" />
                ) : status === "skipped" ? (
                  "Not reached"
                ) : isFailedStep ? (
                  "Stopped here, handed to a human"
                ) : (
                  step.idle
                )}
              </p>
              {active && (
                <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/10">
                  <div className="h-full w-1/3 animate-scan bg-primary" />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {closed && (
        <div
          className={cn(
            "flex items-center gap-2 border-t px-5 py-3 text-sm",
            failed ? "bg-rose-500/[0.06] text-rose-200" : "bg-success/[0.06] text-emerald-200",
          )}
        >
          {failed ? <X className="size-4 shrink-0" /> : <ShieldCheck className="size-4 shrink-0" />}
          <span className="first-letter:uppercase">{incident.outcome}</span>
        </div>
      )}
    </Card>
  );
}

export function OnWatch({ services, healthy }: { services: number; healthy: number }) {
  const allGood = services > 0 && healthy === services;
  return (
    <Card className="relative overflow-hidden py-0">
      <div className="bg-grid absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_left,black,transparent_70%)]" />
      <div className="relative flex flex-wrap items-center gap-5 px-5 py-6">
        <div className="relative grid size-14 place-items-center">
          <span className="absolute inset-0 animate-ping-slow rounded-full bg-primary/20" />
          <span className="absolute inset-2 rounded-full border border-primary/30" />
          <span className="relative grid size-9 place-items-center rounded-full bg-primary/15 text-primary">
            <Radar className="size-5" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <GradientText colors={["#a5b4fc", "#c4b5fd", "#67e8f9", "#a5b4fc"]} animationSpeed={6} className="text-lg font-semibold">
            NightShift is on watch
          </GradientText>
          <p className="mt-1 text-sm text-muted-foreground">
            {allGood
              ? `All ${services} services operational. Sampling health, errors, latency and memory every 2 seconds.`
              : `${healthy} of ${services} services healthy. An incident opens after two bad samples in a row.`}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Bot className="size-4 text-primary" />
          Agent idle · no human paged
        </div>
      </div>
    </Card>
  );
}
