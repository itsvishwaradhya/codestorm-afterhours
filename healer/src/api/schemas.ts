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

export const workspaceFileSchema = z.object({
  path: z.string().min(1).max(300),
});

export const appFileSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string(),
});

export const appRenameSchema = z.object({
  from: z.string().min(1).max(300),
  to: z.string().min(1).max(300),
});

export const appExecSchema = z.object({
  command: z.string().trim().min(1).max(300),
});

export const approvalSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

export const appRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  path: z.string().startsWith("/").max(300),
  body: z.string().max(20_000).optional(),
});
