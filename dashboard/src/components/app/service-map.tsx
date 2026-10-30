import type { ServiceName, ServiceRecord, Snapshot } from "@nightshift/shared";
import { Network } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HEALTH_META, healthOf, percent } from "@/lib/format";

const POSITIONS: Record<string, { x: number; y: number }> = {
  orders: { x: 300, y: 56 },
  payments: { x: 150, y: 196 },
  inventory: { x: 450, y: 196 },
};

const NODE_W = 150;
const NODE_H = 58;

// Live dependency topology. Edges animate in the direction requests flow; the root
// cause glows red and its symptoms are outlined amber, so cause and effect read at a glance.
export function ServiceMap({
  services,
  snapshots,
  roleFor,
}: {
  services: ServiceRecord[];
  snapshots: Snapshot[];
  roleFor: (service: ServiceName) => "root" | "symptom" | null;
}) {
  const byName = new Map(snapshots.map((snapshot) => [snapshot.service, snapshot]));
  const edges = services.flatMap((service) =>
    service.dependencies.map((dependency) => ({ from: service.name, to: dependency })),
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="size-4 text-primary" />
          Service map
        </CardTitle>
        <CardDescription>Requests flow top to bottom. NightShift blames the deepest failing node.</CardDescription>
        <CardAction className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-rose-500" />Root cause</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full border border-amber-400" />Symptom</span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="bg-grid relative rounded-lg border bg-background/40">
          <svg viewBox="0 0 600 260" className="h-auto w-full" role="img" aria-label="Service dependency map">
            <defs>
              <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {edges.map(({ from, to }) => {
              const a = POSITIONS[from];
              const b = POSITIONS[to];
              if (!a || !b) return null;
              const failing = healthOf(byName.get(to)) !== "healthy" && healthOf(byName.get(to)) !== "waiting";
              const path = `M ${a.x} ${a.y + NODE_H / 2} C ${a.x} ${a.y + 90}, ${b.x} ${b.y - 90}, ${b.x} ${b.y - NODE_H / 2}`;
              return (
                <g key={`${from}-${to}`}>
                  <path d={path} fill="none" stroke="oklch(1 0 0 / 10%)" strokeWidth="2" />
                  <path
                    d={path}
                    fill="none"
                    stroke={failing ? "#f43f5e" : "#818cf8"}
                    strokeWidth="2"
                    strokeDasharray="4 12"
                    strokeLinecap="round"
                    className="animate-flow"
                    opacity={failing ? 0.9 : 0.7}
                  />
                </g>
              );
            })}
            {services.map((service) => {
              const position = POSITIONS[service.name];
              if (!position) return null;
              const snapshot = byName.get(service.name);
              const level = healthOf(snapshot);
              const meta = HEALTH_META[level];
              const role = roleFor(service.name);
              const stroke = role === "root" ? "#f43f5e" : role === "symptom" ? "#fbbf24" : "oklch(1 0 0 / 14%)";
              const detail = !snapshot
                ? "waiting"
                : !snapshot.reachable
                  ? "unreachable"
                  : `${percent(snapshot.errorRate)} err · ${Math.round(snapshot.p95LatencyMs)}ms`;
              return (
                <g key={service.name} transform={`translate(${position.x - NODE_W / 2} ${position.y - NODE_H / 2})`}>
                  {role === "root" && (
                    <rect width={NODE_W} height={NODE_H} rx="12" fill="none" stroke="#f43f5e" strokeWidth="2" filter="url(#glow)" opacity="0.8" />
                  )}
                  <rect width={NODE_W} height={NODE_H} rx="12" fill="oklch(0.19 0.006 285)" stroke={stroke} strokeWidth={role ? 1.75 : 1} />
                  <circle cx="18" cy="21" r="4.5" fill={meta.stroke}>
                    {level !== "healthy" && level !== "waiting" && (
                      <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
                    )}
                  </circle>
                  <text x="30" y="25" fill="oklch(0.96 0.003 285)" fontSize="13" fontWeight="600" style={{ textTransform: "capitalize" }}>
                    {service.name}
                  </text>
                  <text x={NODE_W - 12} y="25" textAnchor="end" fill="oklch(0.66 0.012 285)" fontSize="10" fontFamily="JetBrains Mono, monospace">
                    :{service.port}
                  </text>
                  <text x="14" y="44" fill={level === "healthy" ? "oklch(0.66 0.012 285)" : meta.stroke} fontSize="10.5" fontFamily="JetBrains Mono, monospace">
                    {detail}
                  </text>
                  {role && (
                    <g transform={`translate(${NODE_W / 2 - 34} ${NODE_H + 6})`}>
                      <rect width="68" height="16" rx="8" fill={role === "root" ? "#f43f5e" : "#fbbf24"} opacity="0.18" />
                      <text x="34" y="11.5" textAnchor="middle" fontSize="9" fontWeight="600" fill={role === "root" ? "#fb7185" : "#fcd34d"}>
                        {role === "root" ? "ROOT CAUSE" : "SYMPTOM"}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
