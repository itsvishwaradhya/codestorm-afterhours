import type { Attempt } from "@nightshift/shared";
import { Check, Hand, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { percent } from "@/lib/format";

export function ApprovalsBanner({
  attempts,
  onDecide,
}: {
  attempts: Attempt[];
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  if (attempts.length === 0) return null;
  return (
    <section className="relative overflow-hidden rounded-xl border border-amber-400/40 bg-amber-400/[0.06] p-4 shadow-[0_0_40px_-12px_rgba(251,191,36,0.35)]">
      <div className="flex items-start gap-3">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-amber-400/15 text-amber-300">
          <Hand className="size-4.5" />
          <span className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-amber-400" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-amber-100">Your approval is needed</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            These fixes passed the shadow test but are risky, so NightShift will not apply them without you.
          </p>
          <ul className="mt-3 space-y-2">
            {attempts.map((attempt) => (
              <li key={attempt.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/80 p-3">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {attempt.label}
                    <Badge variant="warning" className="capitalize">{attempt.risk} risk</Badge>
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    shadow {percent(attempt.candidateMetrics.errorRate)} err vs baseline {percent(attempt.baseline.errorRate)} · {attempt.sampleSize} requests
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="success" onClick={() => onDecide(attempt.id, "approve")}>
                    <Check />
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onDecide(attempt.id, "reject")}>
                    <X />
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
