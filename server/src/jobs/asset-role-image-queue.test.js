import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { saveAsset, listAssets } from "../services/asset-store.js";
import { createJob, getJob } from "../services/job-store.js";
import { ensureUser } from "../services/user-store.js";
import { expireStaleRoleAssetImageGenerationJobs } from "./asset-role-image-queue.js";

test("stale role image job marks running role images as failed", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-role-image-"));
  const config = {
    env: "test",
    dataDir,
    store: {
      driver: "json",
    },
    worker: {
      imageNodeTimeoutMs: 1,
      llmNodeTimeoutMs: 1,
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });

  try {
    const asset = await saveAsset(user, "role", {
      id: "role-asset",
      name: "小周",
      payload: {
        type: "role",
        name: "小周",
        analysisStatus: "done",
        imageGenerationStatus: "running",
        imageGenerationJobId: "role-image-job",
        roleCharacters: [
          {
            name: "小周",
            roleImages: [
              {
                id: "role-image-1",
                source: "generated",
                prompt: "角色全身照",
                status: "running",
                imageUrl: "",
                imageError: "",
              },
            ],
          },
        ],
      },
    }, config);

    const job = await createJob(user, {
      id: "role-image-job",
      kind: "tool",
      scope: "asset",
      nodeId: "role-image-generation",
      title: "角色库图片生成",
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      payload: {
        assetId: asset.id,
      },
    }, config);

    const expired = await expireStaleRoleAssetImageGenerationJobs(config);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, job.id);

    const storedJob = await getJob(user.id, job.id, config);
    assert.equal(storedJob.status, "error");
    assert.match(storedJob.error, /角色图片生成超时/);

    const { assets } = await listAssets(user.id, "role", config);
    const updatedAsset = assets.find((item) => item.id === asset.id);
    assert.equal(updatedAsset.payload.imageGenerationStatus, "error");
    assert.match(updatedAsset.payload.imageGenerationError, /角色图片生成超时/);
    assert.equal(updatedAsset.payload.roleCharacters[0].roleImages[0].status, "error");
    assert.match(updatedAsset.payload.roleCharacters[0].roleImages[0].imageError, /角色图片生成超时/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
