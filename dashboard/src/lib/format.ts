import type { Impact, IncidentState, Snapshot } from "@nightshift/shared";
import type { BadgeVariant } from "@/components/ui/badge";

export const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export const secs = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)}s`;

export const msToSecs = (ms: number) => `${Math.ceil(ms / 1000)}s`;

export function clock(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

export function ago(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export const humanize = (value: string) => value.replace(/_/g, " ");

export const STATE_VARIANT: Record<IncidentState, BadgeVariant> = {
  detected: "muted",
  diagnosed: "muted",
  verifying: "default",
  awaiting_approval: "warning",
  rate_limited: "warning",
  suppressed: "warning",
  promoting: "default",
  watching: "info",
  resolved: "success",
  escalated: "destructive",
};

export const IMPACT_VARIANT: Record<Impact, BadgeVariant> = {
  helped: "success",
  temporary: "warning",
  no_effect: "muted",
  hurt: "destructive",
};

export type HealthLevel = "waiting" | "down" | "unhealthy" | "degraded" | "healthy";

// Matches the healer's gray thresholds: health passes, but users are not being served well.
export function healthOf(snapshot: Snapshot | undefined): HealthLevel {
  if (!snapshot) return "waiting";
  if (!snapshot.reachable) return "down";
  if (!snapshot.healthy) return "unhealthy";
  if (snapshot.errorRate >= 0.05 || (snapshot.slowRate ?? 0) >= 0.05) return "degraded";
  return "healthy";
}

export const HEALTH_META: Record<HealthLevel, { label: string; variant: BadgeVariant; dot: string; stroke: string }> = {
  waiting: { label: "Waiting", variant: "muted", dot: "bg-zinc-500", stroke: "#71717a" },
  down: { label: "Unreachable", variant: "destructive", dot: "bg-rose-500", stroke: "#f43f5e" },
  unhealthy: { label: "Unhealthy", variant: "destructive", dot: "bg-rose-500", stroke: "#f43f5e" },
  degraded: { label: "Degraded", variant: "warning", dot: "bg-amber-400", stroke: "#fbbf24" },
  healthy: { label: "Operational", variant: "success", dot: "bg-emerald-400", stroke: "#34d399" },
};
