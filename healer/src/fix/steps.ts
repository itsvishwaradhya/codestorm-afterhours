import type { FaultType, ServiceStatus } from "@nightshift/shared";
import type { FixStep } from "./catalog.js";

const HTTP_TIMEOUT_MS = 2000;

export interface ProductionState {
  activeFault: FaultType | null;
  configMode: "ok" | "corrupt";
}

export function serviceUrl(port: number): string {
  return `http://localhost:${port}`;
}

export async function putConfig(baseUrl: string, mode: "ok" | "corrupt"): Promise<void> {
  const response = await fetch(`${baseUrl}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`config update rejected: ${response.status}`);
}

export async function postFault(baseUrl: string, fault: FaultType | null): Promise<void> {
  const response = await fetch(`${baseUrl}/__chaos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`fault update rejected: ${response.status}`);
}

export async function runSteps(baseUrl: string, steps: FixStep[]): Promise<void> {
  for (const step of steps) {
    if (step === "config_ok") await putConfig(baseUrl, "ok");
    if (step === "config_stale") await putConfig(baseUrl, "corrupt");
    if (step === "clear_fault") await postFault(baseUrl, null);
  }
}

export async function readStatus(baseUrl: string): Promise<ServiceStatus | null> {
  try {
    const response = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return (await response.json()) as ServiceStatus;
  } catch {
    return null;
  }
}

export async function readTotals(
  baseUrl: string,
): Promise<{ requests: number; errors: number; healthy: boolean } | null> {
  const status = await readStatus(baseUrl);
  if (!status) return null;
  return { requests: status.totals.requests, errors: status.totals.errors, healthy: status.healthy };
}

export async function captureState(baseUrl: string): Promise<ProductionState | null> {
  const status = await readStatus(baseUrl);
  if (!status) return null;
  return {
    activeFault: status.activeFault,
    configMode: status.config.mode,
  };
}

export async function restoreState(baseUrl: string, state: ProductionState): Promise<void> {
  const current = await readStatus(baseUrl);
  if (current && current.config.mode !== state.configMode) {
    await putConfig(baseUrl, state.configMode);
  }
  if (current && current.activeFault !== state.activeFault && state.activeFault !== "crash") {
    await postFault(baseUrl, state.activeFault);
  }
}

export async function copyProductionState(cloneUrl: string, production: ServiceStatus): Promise<void> {
  if (production.activeFault && production.activeFault !== "crash") {
    await postFault(cloneUrl, production.activeFault);
  }
  if (production.config.mode === "corrupt") {
    await putConfig(cloneUrl, "corrupt");
  }
}

export async function waitForUrl(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(baseUrl);
    if (status) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}
