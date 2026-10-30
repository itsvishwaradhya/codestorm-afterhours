import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { config } from "../config.js";

export interface Store {
  db: Db;
  close: () => Promise<void>;
}

export async function connectStore(): Promise<Store> {
  let uri = process.env.MONGODB_URI;
  let memory: MongoMemoryServer | undefined;
  if (!uri) {
    console.log("[store] no MONGODB_URI set, starting embedded MongoDB (first run downloads the binary)");
    memory = await MongoMemoryServer.create();
    uri = memory.getUri();
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("nightshift");
  await ensureSchema(db);

  return {
    db,
    close: async () => {
      await client.close();
      await memory?.stop();
    },
  };
}

async function ensureSchema(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name),
  );
  if (!existing.has("capturedRequests")) {
    await db.createCollection("capturedRequests", {
      capped: true,
      size: config.captureCapBytes,
      max: config.captureCapDocs,
    });
  }
  await db.collection("snapshots").createIndex({ at: 1 }, { expireAfterSeconds: config.snapshotTtlSeconds });
  await db.collection("services").createIndex({ name: 1 }, { unique: true });
  await db.collection("incidents").createIndex({ id: 1 }, { unique: true });
  await db.collection("incidents").createIndex({ openedAt: -1 });
  await db.collection("attempts").createIndex({ incidentId: 1 });
  await db.collection("auditLog").createIndex({ at: -1 });
}
