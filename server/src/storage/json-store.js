import fs from "node:fs";
import path from "node:path";

const cache = new Map();

export function readJsonStore(config) {
  const file = storeFile(config);
  if (cache.has(file)) return cache.get(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const initial = createInitialStore();
    writeJsonStore(config, initial);
    return initial;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const store = {
    ...createInitialStore(),
    ...parsed,
  };
  cache.set(file, store);
  return store;
}

export function writeJsonStore(config, store) {
  const file = storeFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  cache.set(file, store);
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
}

function createInitialStore() {
  return {
    users: [],
    sessions: [],
    apiKeys: [],
    workflows: [],
    workflowRuns: [],
    workflowVideoTasks: [],
    jobs: [],
    assets: [],
    assetGroups: [],
    usageEvents: [],
    backendRequestLogs: [],
    adminAuditEvents: [],
    workerHeartbeats: {},
  };
}

function storeFile(config) {
  return path.resolve(process.cwd(), config.dataDir || "./data", "flowstudio-store.json");
}
