import type { FaultType, ServiceRecord } from "@nightshift/shared";

export async function injectFault(service: ServiceRecord, fault: FaultType | null): Promise<void> {
  const response = await fetch(`http://localhost:${service.port}/__chaos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault }),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    throw new Error(`${service.name} rejected fault: ${response.status}`);
  }
}
