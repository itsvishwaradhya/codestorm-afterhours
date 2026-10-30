import { z } from "zod";
import { FAULT_TYPES, SERVICE_NAMES } from "@nightshift/shared";

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
});
