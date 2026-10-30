import type { Incident } from "@nightshift/shared";
import { Inbox, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ago, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { STATE_ICON, StateBadge } from "./status";

const TONE: Record<string, string> = {
  resolved: "text-success bg-success/10",
  escalated: "text-rose-400 bg-rose-500/10",
};

export function IncidentList({
  incidents,
  selectedId,
  onSelect,
  loaded,
  className,
}: {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loaded: boolean;
  className?: string;
}) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle>Incidents</CardTitle>
        <CardDescription>{incidents.length > 0 ? `${incidents.length} recorded` : "Nothing recorded yet"}</CardDescription>
      </CardHeader>
      <CardContent className="px-2">
        {!loaded ? (
          <div className="space-y-2 px-3">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 py-1.5">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ) : incidents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
            <Inbox className="size-6 opacity-60" />
            No incidents. Quiet night.
          </div>
        ) : (
          <ScrollArea className="h-[min(520px,60vh)]">
            <ul className="space-y-0.5 px-1">
              {incidents.slice(0, 50).map((incident) => {
                const Icon = STATE_ICON[incident.state];
                const selected = incident.id === selectedId;
                return (
                  <li key={incident.id}>
                    <button
                      onClick={() => onSelect(incident.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                        selected ? "bg-accent" : "hover:bg-accent/50",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-8 shrink-0 place-items-center rounded-lg",
                          TONE[incident.state] ?? "bg-primary/10 text-primary",
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium capitalize">
                          {incident.rootCause ?? "unknown"}
                          {incident.failure && (
                            <span className="truncate font-normal text-muted-foreground">· {humanize(incident.failure)}</span>
                          )}
                          {incident.recurrenceOf && <RefreshCw className="size-3 text-amber-400" />}
                        </span>
                        <span className="block text-xs text-muted-foreground">{ago(incident.openedAt)}</span>
                      </span>
                      <StateBadge state={incident.state} className="hidden sm:inline-flex" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
