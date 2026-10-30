import type { Db } from "mongodb";
import {
  SERVICE_DEPENDENCIES,
  SERVICE_NAMES,
  SERVICE_PORTS,
  type ServiceName,
  type ServiceRecord,
} from "@nightshift/shared";
import * as repo from "./store/repository.js";

export const DEFAULT_FIX_TYPES = ["restart", "revert_config", "reset_defaults", "apply_stale_snapshot"];

export class ServiceRegistry {
  private constructor(
    private readonly db: Db,
    private records: ServiceRecord[],
  ) {}

  static async load(db: Db): Promise<ServiceRegistry> {
    await repo.seedServices(
      db,
      SERVICE_NAMES.map((name) => ({
        name,
        port: SERVICE_PORTS[name],
        dependencies: [...SERVICE_DEPENDENCIES[name]],
        allowedFixTypes: [...DEFAULT_FIX_TYPES],
      })),
    );
    return new ServiceRegistry(db, await repo.listServices(db));
  }

  list(): ServiceRecord[] {
    return this.records;
  }

  get(name: ServiceName): ServiceRecord {
    const record = this.records.find((candidate) => candidate.name === name);
    if (!record) {
      throw new Error(`unknown service: ${name}`);
    }
    return record;
  }

  dependencyMap(): Record<ServiceName, ServiceName[]> {
    return Object.fromEntries(this.records.map((record) => [record.name, record.dependencies])) as Record<
      ServiceName,
      ServiceName[]
    >;
  }

  async update(
    name: ServiceName,
    patch: { dependencies?: ServiceName[]; allowedFixTypes?: string[] },
  ): Promise<ServiceRecord> {
    await repo.updateServiceConfig(this.db, name, patch);
    this.records = await repo.listServices(this.db);
    return this.get(name);
  }
}
