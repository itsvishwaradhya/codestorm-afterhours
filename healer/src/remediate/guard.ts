import type { FailureType, ServiceName } from "@nightshift/shared";

export interface GuardOptions {
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  backoffResetMs: number;
  recurrenceWindowMs: number;
  maxRepeats: number;
  breakerResetMs: number;
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; kind: "cooldown"; waitMs: number; reason: string }
  | { allowed: false; kind: "breaker"; reason: string };

export interface Resolution {
  incidentId: string;
  attemptId: string;
  failure: FailureType;
  at: number;
  count: number;
}

export interface GuardServiceStatus {
  service: ServiceName;
  cooldownRemainingMs: number;
  breaker: "closed" | "open" | "half_open";
  breakerRemainingMs: number;
  breakerReason: string | null;
  recentActions: number;
}

interface Action {
  failure: FailureType;
  at: number;
}

interface ServiceHistory {
  actions: Action[];
  cooldownUntil: number;
  breakerUntil: number;
  breakerReason: string | null;
  halfOpenUntil: number;
  resolutions: Resolution[];
}

// Per-service brakes so the healer cannot become the outage: an exponential cooldown
// between actions, and a circuit breaker once the same fix keeps not sticking.
export class RemediationGuard {
  private services = new Map<ServiceName, ServiceHistory>();

  constructor(
    private readonly options: GuardOptions,
    private readonly now: () => number = Date.now,
  ) {}

  private history(service: ServiceName): ServiceHistory {
    let entry = this.services.get(service);
    if (!entry) {
      entry = { actions: [], cooldownUntil: 0, breakerUntil: 0, breakerReason: null, halfOpenUntil: 0, resolutions: [] };
      this.services.set(service, entry);
    }
    return entry;
  }

  private prune(entry: ServiceHistory): void {
    const now = this.now();
    const keepFrom = now - Math.max(this.options.backoffResetMs, this.options.recurrenceWindowMs);
    entry.actions = entry.actions.filter((action) => action.at > keepFrom);
    entry.resolutions = entry.resolutions.filter((resolution) => resolution.at > now - this.options.recurrenceWindowMs);
    if (entry.breakerUntil > 0 && entry.breakerUntil <= now) {
      // Half-open: allow one more try, but a single repeat re-opens the breaker.
      entry.halfOpenUntil = entry.breakerUntil + this.options.backoffResetMs;
      entry.breakerUntil = 0;
      entry.breakerReason = null;
      entry.actions = [];
    }
  }

  private halfOpen(entry: ServiceHistory): boolean {
    return entry.halfOpenUntil > this.now();
  }

  check(service: ServiceName, failure: FailureType): GuardDecision {
    const entry = this.history(service);
    this.prune(entry);
    const now = this.now();

    if (entry.breakerUntil > now) {
      return { allowed: false, kind: "breaker", reason: entry.breakerReason ?? "circuit breaker open" };
    }

    const repeats = entry.actions.filter(
      (action) => action.failure === failure && action.at > now - this.options.recurrenceWindowMs,
    ).length;
    const limit = this.halfOpen(entry) ? 1 : this.options.maxRepeats;
    if (repeats >= limit) {
      const minutes = Math.round(this.options.recurrenceWindowMs / 60_000);
      entry.breakerUntil = now + this.options.breakerResetMs;
      entry.breakerReason = `${failure.replace(/_/g, " ")} fix applied ${repeats}x on ${service} in ${minutes} min and the fault came back each time; repeating it is not fixing anything`;
      entry.halfOpenUntil = 0;
      return { allowed: false, kind: "breaker", reason: entry.breakerReason };
    }

    if (entry.cooldownUntil > now) {
      const waitMs = entry.cooldownUntil - now;
      return {
        allowed: false,
        kind: "cooldown",
        waitMs,
        reason: `${service} was acted on recently; cooling down for ${Math.ceil(waitMs / 1000)} s before touching it again`,
      };
    }
    return { allowed: true };
  }

  recordAction(service: ServiceName, failure: FailureType): void {
    const entry = this.history(service);
    this.prune(entry);
    const now = this.now();
    entry.actions.push({ failure, at: now });
    const recent = entry.actions.filter((action) => action.at > now - this.options.backoffResetMs).length;
    const cooldown = Math.min(this.options.cooldownBaseMs * 2 ** (recent - 1), this.options.cooldownMaxMs);
    entry.cooldownUntil = now + cooldown;
  }

  recordResolution(service: ServiceName, resolution: Omit<Resolution, "at" | "count">): void {
    const entry = this.history(service);
    this.prune(entry);
    const previous = this.lastResolution(service, resolution.failure);
    entry.resolutions.push({ ...resolution, at: this.now(), count: (previous?.count ?? 0) + 1 });
  }

  // The most recent "fixed" resolution of the same failure on this service inside the
  // recurrence window: if the fault is back, that earlier fix only masked it.
  lastResolution(service: ServiceName, failure: FailureType): Resolution | null {
    const entry = this.history(service);
    this.prune(entry);
    const matching = entry.resolutions.filter((resolution) => resolution.failure === failure);
    return matching[matching.length - 1] ?? null;
  }

  reset(service?: ServiceName): void {
    if (service) {
      this.services.delete(service);
    } else {
      this.services.clear();
    }
  }

  status(): GuardServiceStatus[] {
    const now = this.now();
    return [...this.services.entries()].map(([service, entry]) => {
      this.prune(entry);
      const open = entry.breakerUntil > now;
      return {
        service,
        cooldownRemainingMs: Math.max(0, entry.cooldownUntil - now),
        breaker: open ? "open" : this.halfOpen(entry) ? "half_open" : "closed",
        breakerRemainingMs: open ? entry.breakerUntil - now : 0,
        breakerReason: open ? entry.breakerReason : null,
        recentActions: entry.actions.filter((action) => action.at > now - this.options.recurrenceWindowMs).length,
      };
    });
  }
}
