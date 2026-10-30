import type { ReactNode } from "react";
import { BookOpen, Code2, LayoutDashboard, Moon, ScrollText, Siren, Wifi, WifiOff, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status";

export type View = "overview" | "workspace" | "incidents" | "audit";

const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "workspace", label: "Workspace", icon: Code2 },
  { id: "incidents", label: "Incidents", icon: Siren },
  { id: "audit", label: "Audit log", icon: ScrollText },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-[0_0_20px_-4px_rgba(99,102,241,0.7)]">
        <Moon className="size-4 fill-white text-white" />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold tracking-tight">NightShift</p>
        <p className="text-[11px] text-muted-foreground">Autonomous on-call</p>
      </div>
    </div>
  );
}

export function Sidebar({
  view,
  onView,
  openIncident,
  connected,
}: {
  view: View;
  onView: (view: View) => void;
  openIncident: boolean;
  connected: boolean;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4 lg:flex">
      <div className="px-2">
        <Logo />
      </div>
      <div className="mt-6 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Workspace</div>
      <nav className="mt-2 space-y-0.5">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => onView(item.id)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
              view === item.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
            {item.id === "incidents" && openIncident && (
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-rose-300">
                <StatusDot className="bg-rose-500" pulse />
                1 open
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-auto space-y-3">
        <div className="rounded-lg border bg-card/60 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium">
            <BookOpen className="size-3.5 text-primary" />
            How NightShift decides
          </p>
          <p className="mt-1.5 leading-relaxed text-muted-foreground">
            Every fix is replayed on a shadow clone first. Low-risk fixes apply automatically; risky ones wait for you.
          </p>
        </div>
        <div className="flex items-center justify-between rounded-lg px-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            {connected ? <Wifi className="size-3.5 text-success" /> : <WifiOff className="size-3.5 text-amber-400" />}
            {connected ? "Realtime connected" : "Polling every 5s"}
          </span>
          <span className="font-mono">v0.1</span>
        </div>
      </div>
    </aside>
  );
}

export function Topbar({
  view,
  onView,
  connected,
  actions,
}: {
  view: View;
  onView: (view: View) => void;
  connected: boolean;
  actions?: ReactNode;
}) {
  const title = NAV.find((item) => item.id === view)?.label ?? "";
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-xl">
      <div className="flex h-14 items-center justify-between gap-3 px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="lg:hidden">
            <Logo />
          </div>
          <nav className="hidden items-center gap-1.5 text-sm lg:flex" aria-label="Breadcrumb">
            <span className="text-muted-foreground">Codestorm</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="text-muted-foreground">checkout-demo</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="font-medium">{title}</span>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="hidden font-mono sm:inline-flex">local · demo</Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={connected ? "success" : "warning"} className="cursor-default">
                <StatusDot className={connected ? "bg-success" : "bg-amber-400"} pulse={connected} />
                {connected ? "Live" : "Polling"}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {connected ? "Receiving updates over Socket.IO" : "Socket is down, refreshing every 5 seconds"}
            </TooltipContent>
          </Tooltip>
          {actions}
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => onView(item.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs",
              view === item.id ? "bg-accent font-medium" : "text-muted-foreground",
            )}
          >
            <item.icon className="size-3.5" />
            {item.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
