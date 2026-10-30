import { z } from "zod";
import { FAULT_TYPES, GRAY_MODES, SERVICE_NAMES } from "@nightshift/shared";

export const serviceUpdateSchema = z.object({
  name: z.enum(SERVICE_NAMES),
  dependencies: z.array(z.enum(SERVICE_NAMES)).optional(),
  allowedFixTypes: z.array(z.string()).optional(),
});

export const captureSchema = z.object({
  service: z.enum(SERVICE_NAMES),
  at: z.string(),
  method: z.string(),
  path: z.string(),
  headers: z.record(z.string(), z.unknown()),
  body: z.unknown(),
});

export const chaosSchema = z.object({
  service: z.enum(SERVICE_NAMES),
  fault: z.enum(FAULT_TYPES).nullable(),
  rate: z.number().gt(0).max(1).optional(),
  mode: z.enum(GRAY_MODES).optional(),
});

export const guardResetSchema = z.object({
  service: z.enum(SERVICE_NAMES),
});

export const approvalSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});
