import type { Anomaly, FailureType, Risk } from "@nightshift/shared";

export type FixId = "restart" | "revert_config" | "reset_defaults" | "apply_stale_snapshot";
export type FixStep = "config_ok" | "config_stale" | "clear_fault";

export interface FixCandidate {
  id: FixId;
  label: string;
  risk: Risk;
  startsFresh: boolean;
  steps: FixStep[];
  productionAllowed: boolean;
}

export const RESTART: FixCandidate = {
  id: "restart",
  label: "Restart process",
  risk: "low",
  startsFresh: true,
  steps: [],
  productionAllowed: true,
};

export const REVERT_CONFIG: FixCandidate = {
  id: "revert_config",
  label: "Revert config to last known good",
  risk: "low",
  startsFresh: false,
  steps: ["config_ok"],
  productionAllowed: true,
};

export const APPLY_STALE_SNAPSHOT: FixCandidate = {
  id: "apply_stale_snapshot",
  label: "Apply stale configuration snapshot (demo decoy)",
  risk: "low",
  startsFresh: false,
  steps: ["config_stale"],
  productionAllowed: false,
};

export const RESET_DEFAULTS: FixCandidate = {
  id: "reset_defaults",
  label: "Reset to factory defaults",
  risk: "medium",
  startsFresh: false,
  steps: ["clear_fault", "config_ok"],
  productionAllowed: true,
};

const CATALOG: Record<FailureType, FixCandidate[]> = {
  crash: [RESTART],
  memory_leak: [RESTART],
  slow: [RESTART],
  bad_config: [REVERT_CONFIG, APPLY_STALE_SNAPSHOT, RESET_DEFAULTS],
};

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function classifyFailure(
  rootAnomalies: Anomaly[],
  configMode: "ok" | "corrupt" | "unknown",
): FailureType | null {
  const kinds = new Set(rootAnomalies.map((anomaly) => anomaly.kind));
  if (kinds.has("unreachable")) return "crash";
  if (configMode === "corrupt") return "bad_config";
  if (kinds.has("memory")) return "memory_leak";
  if (kinds.has("latency")) return "slow";
  return null;
}

export function candidatesFor(failure: FailureType, allowedFixTypes: string[]): FixCandidate[] {
  return CATALOG[failure]
    .filter((candidate) => allowedFixTypes.includes(candidate.id))
    .sort((a, b) => RISK_RANK[a.risk] - RISK_RANK[b.risk]);
}
