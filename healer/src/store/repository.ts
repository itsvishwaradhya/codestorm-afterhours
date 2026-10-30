import type { Db } from "mongodb";
import type {
  Attempt,
  AuditEntry,
  Incident,
  Receipt,
  ServiceName,
  ServiceRecord,
  Snapshot,
} from "@nightshift/shared";

const hideMongoId = { projection: { _id: 0 } };

export interface CaptureRecord {
  service: ServiceName;
  at: string;
  method: string;
  path: string;
  headers: Record<string, unknown>;
  body: unknown;
}

export async function seedServices(db: Db, seeds: ServiceRecord[]): Promise<void> {
  const services = db.collection("services");
  for (const seed of seeds) {
    await services.updateOne({ name: seed.name }, { $setOnInsert: seed }, { upsert: true });
  }
}

export async function listServices(db: Db): Promise<ServiceRecord[]> {
  const docs = await db.collection("services").find({}, hideMongoId).sort({ name: 1 }).toArray();
  return docs as unknown as ServiceRecord[];
}

export async function updateServiceConfig(
  db: Db,
  name: ServiceName,
  patch: { dependencies?: ServiceName[]; allowedFixTypes?: string[] },
): Promise<void> {
  const $set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  if (Object.keys($set).length === 0) return;
  await db.collection("services").updateOne({ name }, { $set });
}

export async function insertSnapshot(db: Db, snapshot: Snapshot): Promise<void> {
  await db.collection("snapshots").insertOne({ ...snapshot, at: new Date(snapshot.at) });
}

export async function insertCapture(db: Db, record: CaptureRecord): Promise<void> {
  await db.collection("capturedRequests").insertOne({ ...record, at: new Date(record.at) });
}

export async function listCaptures(db: Db, service: ServiceName, limit: number): Promise<CaptureRecord[]> {
  const docs = await db
    .collection("capturedRequests")
    .find({ service }, hideMongoId)
    .sort({ $natural: -1 })
    .limit(limit)
    .toArray();
  return docs as unknown as CaptureRecord[];
}

export async function listCapturesSince(
  db: Db,
  service: ServiceName,
  sinceIso: string,
  limit: number,
): Promise<CaptureRecord[]> {
  const docs = await db
    .collection("capturedRequests")
    .find({ service, at: { $gte: new Date(sinceIso) } }, hideMongoId)
    .sort({ at: 1 })
    .limit(limit)
    .toArray();
  return docs as unknown as CaptureRecord[];
}

export async function insertAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.collection("auditLog").insertOne(entry);
}

export async function listAudit(db: Db, limit: number): Promise<AuditEntry[]> {
  const docs = await db.collection("auditLog").find({}, hideMongoId).sort({ at: -1 }).limit(limit).toArray();
  return docs as unknown as AuditEntry[];
}

export async function listAuditByAction(db: Db, action: string, limit: number): Promise<AuditEntry[]> {
  const docs = await db.collection("auditLog").find({ action }, hideMongoId).sort({ at: -1 }).limit(limit).toArray();
  return docs as unknown as AuditEntry[];
}

export async function saveIncident(db: Db, incident: Incident): Promise<void> {
  await db.collection("incidents").updateOne({ id: incident.id }, { $set: incident }, { upsert: true });
}

export async function listIncidents(db: Db, limit: number): Promise<Incident[]> {
  const docs = await db.collection("incidents").find({}, hideMongoId).sort({ openedAt: -1 }).limit(limit).toArray();
  return docs as unknown as Incident[];
}

export async function getIncident(db: Db, id: string): Promise<Incident | null> {
  const doc = await db.collection("incidents").findOne({ id }, hideMongoId);
  return (doc as unknown as Incident | null) ?? null;
}

export async function saveReceipt(db: Db, receipt: Receipt): Promise<void> {
  await db.collection("receipts").updateOne({ incidentId: receipt.incidentId }, { $set: receipt }, { upsert: true });
}

export async function getReceipt(db: Db, incidentId: string): Promise<Receipt | null> {
  const doc = await db.collection("receipts").findOne({ incidentId }, hideMongoId);
  return (doc as unknown as Receipt | null) ?? null;
}

export async function clearDemoData(db: Db): Promise<void> {
  await Promise.all([
    db.collection("incidents").deleteMany({}),
    db.collection("attempts").deleteMany({}),
    db.collection("receipts").deleteMany({}),
    db.collection("capturedRequests").deleteMany({}),
    db.collection("snapshots").deleteMany({}),
    db.collection("auditLog").deleteMany({}),
  ]);
}

export async function saveAttempt(db: Db, attempt: Attempt): Promise<void> {
  await db.collection("attempts").updateOne({ id: attempt.id }, { $set: attempt }, { upsert: true });
}

export async function reviseAttemptImpact(
  db: Db,
  id: string,
  impact: NonNullable<Attempt["impact"]>,
  reasons: string[],
): Promise<Attempt | null> {
  const doc = await db
    .collection<Attempt>("attempts")
    .findOneAndUpdate(
      { id },
      { $set: { impact }, $push: { impactReasons: { $each: reasons } } },
      { returnDocument: "after", ...hideMongoId },
    );
  return (doc as unknown as Attempt | null) ?? null;
}

export async function listActedAttempts(db: Db, limit: number): Promise<Attempt[]> {
  const docs = await db
    .collection("attempts")
    .find({ impact: { $type: "string" } }, hideMongoId)
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray();
  return docs as unknown as Attempt[];
}

export async function listRecentAttempts(db: Db, limit: number): Promise<Attempt[]> {
  const docs = await db.collection("attempts").find({}, hideMongoId).sort({ startedAt: -1 }).limit(limit).toArray();
  return docs as unknown as Attempt[];
}

export async function listAttempts(db: Db, incidentId: string): Promise<Attempt[]> {
  const docs = await db
    .collection("attempts")
    .find({ incidentId }, hideMongoId)
    .sort({ startedAt: 1 })
    .toArray();
  return docs as unknown as Attempt[];
}
