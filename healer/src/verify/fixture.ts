import type { ServiceName } from "@nightshift/shared";
import type { ReplayRecord } from "./replay.js";

const SAMPLES = 60;

const TEMPLATES: Record<ServiceName, ReplayRecord> = {
  orders: {
    method: "POST",
    path: "/checkout",
    body: { item: "keyboard", quantity: 1, cardNumber: "masked" },
  },
  payments: {
    method: "POST",
    path: "/charge",
    body: { amount: 129, cardNumber: "masked" },
  },
  inventory: {
    method: "POST",
    path: "/reserve",
    body: { item: "keyboard", quantity: 1 },
  },
};

export function fixtureFor(service: ServiceName): ReplayRecord[] {
  const template = TEMPLATES[service];
  return Array.from({ length: SAMPLES }, () => ({
    method: template.method,
    path: template.path,
    body: structuredClone(template.body),
  }));
}
