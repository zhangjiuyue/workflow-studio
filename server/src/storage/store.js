import { readJsonStore, writeJsonStore } from "./json-store.js";
import { assertPostgresStoreAvailable, postgresStoreStatus } from "./postgres-store.js";

export function readStore(config) {
  const driver = getStoreDriver(config);
  if (driver === "json") return readJsonStore(config);
  if (driver === "postgres") return assertPostgresStoreAvailable("readStore");
  throw new Error(`未知的数据存储驱动：${driver}`);
}

export function writeStore(config, store) {
  const driver = getStoreDriver(config);
  if (driver === "json") return writeJsonStore(config, store);
  if (driver === "postgres") return assertPostgresStoreAvailable("writeStore");
  throw new Error(`未知的数据存储驱动：${driver}`);
}

export function getStoreDriver(config) {
  return String(config.store?.driver || "json").trim() || "json";
}

export function getStoreStatus(config) {
  const driver = getStoreDriver(config);
  return {
    driver,
    mode: driver === "json" ? "json-local" : "postgres",
    databaseConfigured: Boolean(config.databaseUrl),
    dataDir: config.dataDir,
    postgres: {
      ...postgresStoreStatus,
      ready: driver === "postgres" && postgresStoreStatus.implemented,
    },
  };
}
