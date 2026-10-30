import type { AuditEntry } from "@nightshift/shared";
import {
  Bot,
  CircleCheck,
  CircleX,
  FlaskConical,
  Hand,
  RotateCcw,
  ShieldAlert,
  Undo2,
  User,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { clock } from "@/lib/format";
import { cn } from "@/lib/utils";

function iconFor(entry: AuditEntry): { icon: LucideIcon; tone: string } {
  const action = entry.action;
  if (action.startsWith("chaos")) return { icon: Zap, tone: "text-amber-300 bg-amber-400/10" };
  if (action === "incident.resolved") return { icon: CircleCheck, tone: "text-success bg-success/10" };
  if (action === "incident.escalated") return { icon: CircleX, tone: "text-rose-400 bg-rose-500/10" };
  if (action === "shadow.verdict") return { icon: FlaskConical, tone: "text-primary bg-primary/10" };
  if (action === "action.applied") return { icon: Wrench, tone: "text-violet-300 bg-violet-500/10" };
  if (action === "action.rolled_back") return { icon: Undo2, tone: "text-rose-400 bg-rose-500/10" };
  if (action === "action.suppressed") return { icon: ShieldAlert, tone: "text-amber-300 bg-amber-400/10" };
  if (action.startsWith("approval")) return { icon: Hand, tone: "text-amber-300 bg-amber-400/10" };
  if (action.endsWith("reset")) return { icon: RotateCcw, tone: "text-sky-300 bg-sky-400/10" };
  return { icon: entry.actor === "healer" ? Bot : User, tone: "text-muted-foreground bg-muted" };
}

export function AuditFeed({ entries, loaded, className, height = "h-[420px]" }: { entries: AuditEntry[]; loaded: boolean; className?: string; height?: string }) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle>Audit trail</CardTitle>
        <CardDescription>Every automatic action, and who or what triggered it.</CardDescription>
      </CardHeader>
      <CardContent className="px-2">
        {!loaded ? (
          <div className="space-y-3 px-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="flex gap-3">
                <Skeleton className="size-7 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ScrollArea className={height}>
            <ol className="space-y-0.5 px-1">
              {entries.map((entry) => {
                const { icon: Icon, tone } = iconFor(entry);
                return (
                  <li key={entry.id} className="flex gap-3 rounded-lg px-2.5 py-2 hover:bg-accent/40">
                    <span className={cn("grid size-7 shrink-0 place-items-center rounded-md", tone)}>
                      <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs text-foreground/90">{entry.action}</span>
                        <span className="tabular shrink-0 font-mono text-[11px] text-muted-foreground">{clock(entry.at)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entry.trigger}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground/70">by {entry.actor}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
