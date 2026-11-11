import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { membershipPlanDefaults } from "../lib/membership-plans.mjs";
import { saveAsset } from "./asset-store.js";
import { createWorkflow } from "./workflow-store.js";

for (const plan of ["pro", "team"]) {
  test(`${plan} memberships allow 30 workflows and 30 assets per type`, async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), `flowstudio-${plan}-quota-`));
    const config = {
      env: "test",
      dataDir,
      store: {
        driver: "json",
      },
    };
    const user = {
      id: `user-${plan}`,
      role: "user",
      membership: {
        status: "active",
        plan,
        ...membershipPlanDefaults(plan),
      },
    };

    try {
      for (let index = 1; index <= 30; index += 1) {
        await createWorkflow(user, {
          id: `${plan}-workflow-${index}`,
          name: `${plan} workflow ${index}`,
          type: "explain",
          config: {},
        }, config);
        await saveAsset(user, "script", {
          id: `${plan}-script-${index}`,
          name: `${plan} script ${index}`,
          payload: {},
        }, config);
      }

      await assert.rejects(
        createWorkflow(user, {
          id: `${plan}-workflow-31`,
          name: `${plan} workflow 31`,
          type: "explain",
          config: {},
        }, config),
        (error) => error?.status === 403 && error?.detail?.code === "WORKFLOW_LIMIT_REACHED" && error?.detail?.limit === 30,
      );
      await assert.rejects(
        saveAsset(user, "script", {
          id: `${plan}-script-31`,
          name: `${plan} script 31`,
          payload: {},
        }, config),
        (error) => error?.status === 403
          && error?.detail?.code === "ASSET_LIMIT_REACHED"
          && error?.detail?.limit === 30
          && error?.detail?.type === "script",
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
