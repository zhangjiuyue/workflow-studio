import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { saveApiKey } from "./api-key-store.js";
import { executeWorkflowAudioNode } from "./workflow-audio-runner.js";
import { ensureUser } from "./user-store.js";
import { createWorkflow, createWorkflowRun, getWorkflowRun } from "./workflow-store.js";

test("talking-video audio stores raw ASR timing and defers final SRT until storyboard", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-talking-audio-"));
  const providerConfig = path.join(dataDir, 'providers.json');
  await writeFile(providerConfig, JSON.stringify([{channel:'Synthetic Audio', services:{audio:{
    endpoint:'https://audio.example.com', adapter:'module',
    module:new URL('./test-support/media-adapter.mjs', import.meta.url).pathname, models:['test-audio']
  }}}]));
  const previousProviderConfig = process.env.WORKFLOW_PROVIDER_CONFIG;
  process.env.WORKFLOW_PROVIDER_CONFIG = providerConfig;
  const config = {
    env: "test",
    dataDir,
    apiKeyEncryptionKey: Buffer.from("flowstudio-local-dev-key-0000010").toString("base64"),
    store: { driver: "json" },
    storage: { provider: "local" },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });
  await saveApiKey(user, {
    id: "audio-key",
    serviceType: "audio",
    channel: "Synthetic Audio",
    apiKey: "test-audio-key",
    endpoint: "https://audio.example.com",
    model: "test-audio",
  }, config);
  const workflow = await createWorkflow(user, {
    id: "workflow-talking-audio",
    name: "口播视频音频测试",
    type: "explain",
    config: {
      type: "explain",
      language: "en",
      audioKeyId: "audio-key",
      audioModelId: "test-audio",
    },
  }, config);
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: "run-talking-audio",
    kind: "topic-child",
    topic: "Test topic",
    status: "waiting",
    stages: {
      script: "done",
      audio: "pending",
      shot: "pending",
    },
    result: {
      scriptOutput: "Hello world, this is a test.",
      scriptTranslation: "你好，世界，这是一段测试。",
      scriptTranslationLanguage: "zh",
    },
  }, config);
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).endsWith("/audio")) {
      return new Response(JSON.stringify({audioUrl:'https://assets.example.com/audio.mp3', duration:4.8}));
    }
    if (String(url).endsWith("/transcribe")) {
      return new Response(JSON.stringify({
        text: "Hello world, this is a test.",
        duration: 4.8,
        segments: [
          { text: "Hello", start: 0, end: 0.8 },
          { text: "world,", start: 0.8, end: 1.6 },
          { text: "this is a test.", start: 1.6, end: 4.8 },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await executeWorkflowAudioNode(user, {
      runId: run.id,
      nodeId: "audio",
      audioKeyId: "audio-key",
      audioModelId: "test-audio",
    }, config);

    assert.deepEqual(fetchCalls.map((call) => new URL(call.url).pathname), ["/audio", "/transcribe"]);
    assert.equal(JSON.parse(fetchCalls[0].options.body).text, "Hello world, this is a test.");
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.audio.subtitle_status, "pending");
    assert.equal(updatedRun.result.audioRawSegments.length, 3);
    assert.deepEqual(updatedRun.result.audioSegments, []);
    assert.equal(updatedRun.result.subtitleSrt, "");
    assert.equal(updatedRun.result.timeline.raw_segments.length, 3);
    assert.deepEqual(updatedRun.result.timeline.segments, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProviderConfig === undefined) delete process.env.WORKFLOW_PROVIDER_CONFIG;
    else process.env.WORKFLOW_PROVIDER_CONFIG = previousProviderConfig;
    await rm(dataDir, { recursive: true, force: true });
  }
});
