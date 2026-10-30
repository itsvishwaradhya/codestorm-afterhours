import { useState } from "react";
import { Boxes, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppWorkspace } from "./app-workspace";
import { DemoWorkspace, type WorkspaceProps } from "./workspace";

type Mode = "app" | "demo";

export function Workspace(props: WorkspaceProps) {
  const [mode, setMode] = useState<Mode>("app");
  const tabs: { id: Mode; label: string; icon: typeof Upload }[] = [
    { id: "app", label: "My app", icon: Upload },
    { id: "demo", label: "Demo system", icon: Boxes },
  ];
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-lg border bg-card p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setMode(tab.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
              mode === tab.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <tab.icon className="size-3.5" />
            {tab.label}
          </button>
        ))}
      </div>
      {mode === "app" ? <AppWorkspace /> : <DemoWorkspace {...props} />}
    </div>
  );
}
