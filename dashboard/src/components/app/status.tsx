import type { Impact, IncidentState } from "@nightshift/shared";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Eye,
  FlaskConical,
  Hand,
  Hourglass,
  Radar,
  Rocket,
  ShieldAlert,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { humanize, IMPACT_VARIANT, STATE_VARIANT } from "@/lib/format";

export const STATE_ICON: Record<IncidentState, LucideIcon> = {
  detected: Radar,
  diagnosed: Stethoscope,
  verifying: FlaskConical,
  awaiting_approval: Hand,
  rate_limited: Hourglass,
  suppressed: ShieldAlert,
  promoting: Rocket,
  watching: Eye,
  resolved: CircleCheck,
  escalated: CircleX,
};

export function StateBadge({ state, className }: { state: IncidentState; className?: string }) {
  const Icon = STATE_ICON[state] ?? CircleDashed;
  return (
    <Badge variant={STATE_VARIANT[state] ?? "muted"} className={cn("capitalize", className)}>
      <Icon />
      {humanize(state)}
    </Badge>
  );
}

export function ImpactBadge({ impact }: { impact: Impact | null | undefined }) {
  if (!impact) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant={IMPACT_VARIANT[impact]} className="capitalize">
      {humanize(impact)}
    </Badge>
  );
}

export function StatusDot({ className, pulse = false }: { className?: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={cn("absolute inline-flex size-full animate-ping-slow rounded-full", className)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", className)} />
    </span>
  );
}
