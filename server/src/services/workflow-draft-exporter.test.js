import { mediaHttp } from '../security/public-http.js';
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { enqueueWorkflowNodeJob, processWorkflowNodeJobById } from "../jobs/workflow-node-queue.js";
import { getJob } from "./job-store.js";
import { saveApiKey } from "./api-key-store.js";
import { executeWorkflowDraftNode } from "./workflow-draft-exporter.js";
import { ensureUser } from "./user-store.js";
import { createWorkflow, createWorkflowRun, getWorkflowRun } from "./workflow-store.js";

test("draft export validates unique media URLs with bounded concurrency", async () => {
  const fixture = await createDraftFixture();
  const mock = mockDraftAdapterFetch({
    mediaProbeDelayMs: 10,
    mediaProbeContentType: "application/octet-stream",
    durations: {
      "https://media.example.com/audio-1.mp3": 4.925,
      "https://media.example.com/audio-2.mp3": 5.075,
    },
  });
  try {
    await executeWorkflowDraftNode(fixture.user, {
      runId: fixture.run.id,
      draftKeyId: "draft-key",
      audioTrackId: "voice-track",
      materialSource: "image",
    }, fixture.config);

    assert.equal(mock.mediaProbeCalls.length, 6);
    assert.ok(mock.maxActiveMediaProbeRequests > 1);
    assert.equal(new Set(mock.mediaProbeCalls.map((call) => call.url)).size, mock.mediaProbeCalls.length);
    assert.ok(mock.mediaProbeCalls.every((call) => call.method === "GET"));
    assert.ok(mock.mediaProbeCalls.every((call) => call.range === "bytes=0-0"));
    assert.equal(mock.mediaProbeCancelCount, mock.mediaProbeCalls.length);
  } finally {
    mock.restore();
    await fixture.cleanup();
  }
});


test("draft export retries transient ranged GET failures without falling back to HEAD", async () => {
  const fixture = await createDraftFixture();
  const mock = mockDraftAdapterFetch({
    mediaProbeNetworkErrorOnce: true,
    mediaProbeStatus: 206,
    durations: {
      "https://media.example.com/audio-1.mp3": 4.925,
      "https://media.example.com/audio-2.mp3": 5.075,
    },
  });
  try {
    const result = await executeWorkflowDraftNode(fixture.user, {
      runId: fixture.run.id,
      draftKeyId: "draft-key",
      audioTrackId: "voice-track",
      materialSource: "image",
    }, fixture.config);

    assert.equal(result.run.result.draftStatus, "done");
    assert.equal(mock.mediaProbeCalls.length, 12);
    assert.equal(mock.mediaProbeCancelCount, 6);
    assert.ok(mock.mediaProbeCalls.every((call) => call.method === "GET"));
  } finally {
    mock.restore();
    await fixture.cleanup();
  }
});


test("draft export does not report success when Synthetic Draft omits the draft link", async () => {
  const fixture = await createDraftFixture();
  const mock = mockDraftAdapterFetch({
    omitDraftUrl: true,
    durations: {
      "https://media.example.com/audio-1.mp3": 4.925,
      "https://media.example.com/audio-2.mp3": 5.075,
    },
  });
  try {
    await assert.rejects(() => executeWorkflowDraftNode(fixture.user, {
      runId: fixture.run.id,
      draftKeyId: "draft-key",
      audioTrackId: "voice-track",
      materialSource: "image",
    }, fixture.config), error => error.status === 502);
  } finally {
    mock.restore();
    await fixture.cleanup();
  }
});


test("draft export rejects an enabled watermark without manually entered text", async () => {
  const fixture = await createDraftFixture();
  try {
    await assert.rejects(() => executeWorkflowDraftNode(fixture.user, {
      runId: fixture.run.id,
      draftKeyId: "draft-key",
      audioTrackId: "voice-track",
      materialSource: "image",
      watermarkEnabled: true,
      watermarkText: "   ",
    }, fixture.config), /请手动填写水印内容/);
  } finally {
    await fixture.cleanup();
  }
});


test("queued draft export reports progress and preserves the generated draft link", async () => {
  const fixture = await createDraftFixture();
  const mock = mockDraftAdapterFetch({
    durations: {
      "https://media.example.com/audio-1.mp3": 4.925,
      "https://media.example.com/audio-2.mp3": 5.075,
    },
  });
  try {
    const job = await enqueueWorkflowNodeJob(fixture.user, {
      workflowId: fixture.workflow.id,
      runId: fixture.run.id,
      nodeId: "draft",
      title: "剪辑草稿生成",
      payload: {
        draftKeyId: "draft-key",
        audioTrackId: "voice-track",
        materialSource: "image",
      },
    }, fixture.config);

    await processWorkflowNodeJobById(job.id, fixture.config);

    const storedJob = await getJob(fixture.user.id, job.id, fixture.config);
    assert.equal(storedJob.status, "done");
    assert.equal(storedJob.progress, 100);
    assert.equal(storedJob.result.detail, "剪辑草稿已生成");
    assert.equal(storedJob.result.draftUrl, "https://draft.example.com/draft-test");

    const updatedRun = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    assert.equal(updatedRun.status, "waiting");
    assert.equal(updatedRun.stages.draft, "done");
    assert.equal(updatedRun.result.draftUrl, "https://draft.example.com/draft-test");
    assert.equal(updatedRun.result.backendJobs.draft.status, "done");
    assert.equal(updatedRun.result.backendJobs.draft.progress, 100);
  } finally {
    mock.restore();
    await fixture.cleanup();
  }
});


test("timed out draft export stays failed and can be retried", async () => {
  const fixture = await createDraftFixture({ draftNodeTimeoutMs: 5 });
  const mock = mockDraftAdapterFetch({
    delayPath: "/draft",
    delayMs: 30,
    durations: {
      "https://media.example.com/audio-1.mp3": 4.925,
      "https://media.example.com/audio-2.mp3": 5.075,
    },
  });
  try {
    const job = await enqueueWorkflowNodeJob(fixture.user, {
      workflowId: fixture.workflow.id,
      runId: fixture.run.id,
      nodeId: "draft",
      title: "剪辑草稿生成",
      payload: {
        draftKeyId: "draft-key",
        audioTrackId: "voice-track",
        materialSource: "image",
      },
    }, fixture.config);

    await assert.rejects(
      () => processWorkflowNodeJobById(job.id, fixture.config),
      /剪辑草稿生成超时/,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const storedJob = await getJob(fixture.user.id, job.id, fixture.config);
    const updatedRun = await getWorkflowRun(fixture.user.id, fixture.run.id, fixture.config);
    assert.equal(storedJob.status, "error");
    assert.equal(updatedRun.status, "waiting");
    assert.equal(updatedRun.stages.draft, "error");
    assert.equal(updatedRun.result.draftStatus, "error");
    assert.match(updatedRun.result.draftError, /剪辑草稿生成超时/);
    assert.equal(Boolean(updatedRun.result.draftUrl), false);
    assert.equal(updatedRun.result.backendJobs.draft.status, "error");
  } finally {
    mock.restore();
    await fixture.cleanup();
  }
});

async function createDraftFixture(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-draft-export-"));
  const filename=path.join(dataDir,'providers.json');
  await writeFile(filename,JSON.stringify([{channel:'Synthetic Draft',services:{draft:{endpoint:'https://draft.example.com',adapter:'module',module:new URL('./test-support/media-adapter.mjs',import.meta.url).pathname,models:['draft']}}}]));
  const previous=process.env.WORKFLOW_PROVIDER_CONFIG;
  process.env.WORKFLOW_PROVIDER_CONFIG=filename;
  const config = {
    env: "test",
    dataDir,
    apiKeyEncryptionKey: Buffer.from("flowstudio-local-dev-key-0000010").toString("base64"),
    store: { driver: "json" },
    storage: { provider: "local" },
    worker: { draftNodeTimeoutMs: Number(options.draftNodeTimeoutMs || 0) },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });
  await saveApiKey(user, {
    id: "draft-key",
    serviceType: "draft",
    channel: "Synthetic Draft",
    apiKey: "test-draft-key",
    endpoint: "https://draft.example.com",
  }, config);
  const workflow = await createWorkflow(user, {
    id: "workflow-draft",
    name: "剪辑草稿测试",
    type: "explain",
    config: { type: "explain", language: "en" },
  }, config);
  const segments = [
    { index: 1, text: "First line.", start: 0, end: 2.5 },
    { index: 2, text: "Second line.", start: 2.5, end: 5 },
    { index: 3, text: "Third line.", start: 5, end: 7.5 },
    { index: 4, text: "Fourth line.", start: 7.5, end: 10 },
  ];
  const shots = segments.map((segment) => ({
    id: `shot-${segment.index}`,
    index: segment.index,
    script: segment.text,
    imageUrl: `https://media.example.com/image-${segment.index}.jpg`,
  }));
  const audioParts = options.audioParts || [
    { index: 1, audio_url: "https://media.example.com/audio-1.mp3", duration: 4.8 },
    { index: 2, audio_url: "https://media.example.com/audio-2.mp3", duration: 5.1 },
  ];
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: `run-draft-${Date.now()}-${Math.random()}`,
    kind: "topic-child",
    topic: "Draft test",
    status: "waiting",
    stages: { audio: "done", shot: "done", image: "done", video: "done", draft: "pending" },
    result: {
      shots,
      audioTracks: [{
        id: "voice-track",
        variant: "en",
        audio_url: audioParts[0].audio_url,
        duration: 10,
        parts: audioParts,
        segments,
        subtitle_srt: "",
      }],
      audioUrl: audioParts[0].audio_url,
      audioDuration: 10,
      audioSegments: segments,
      videoTimeline: options.videoTimeline || [],
      videoResults: options.videoResults || [],
    },
  }, config);
  return {
    config,
    user,
    workflow,
    run,
    cleanup: async () => {
      if(previous === undefined) delete process.env.WORKFLOW_PROVIDER_CONFIG;
      else process.env.WORKFLOW_PROVIDER_CONFIG=previous;
      await rm(dataDir, {recursive:true,force:true});
    },
  };
}

function mockDraftAdapterFetch(options = {}) {
  const originalFetch = globalThis.fetch;
  const originalMediaFetch = mediaHttp.fetch;
  const postCalls = [];
  const mediaProbeCalls = [];
  const mediaProbeAttempts = new Map();
  let delayed = false;
  let imageRetryAttempt = 0;
  let videoRetryAttempt = 0;
  let activeMediaProbeRequests = 0;
  let maxActiveMediaProbeRequests = 0;
  let mediaProbeCancelCount = 0;
  globalThis.fetch = async (url, request = {}) => {
    const parsed = new URL(String(url));
    if (request.method === "GET") {
      const mediaUrl = String(url);
      mediaProbeCalls.push({
        url: mediaUrl,
        method: request.method,
        range: new Headers(request.headers).get("Range"),
      });
      activeMediaProbeRequests += 1;
      maxActiveMediaProbeRequests = Math.max(maxActiveMediaProbeRequests, activeMediaProbeRequests);
      if (Number(options.mediaProbeDelayMs || 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, Number(options.mediaProbeDelayMs)));
      }
      activeMediaProbeRequests -= 1;
      const attempt = Number(mediaProbeAttempts.get(mediaUrl) || 0) + 1;
      mediaProbeAttempts.set(mediaUrl, attempt);
      if (options.mediaProbeNetworkErrorOnce && attempt === 1) {
        throw new TypeError("fetch failed: connection reset");
      }
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0]));
        },
        cancel() {
          mediaProbeCancelCount += 1;
        },
      });
      return new Response(body, {
        status: Number(options.mediaProbeStatus || 200),
        headers: { "Content-Type": options.mediaProbeContentType || "image/png" },
      });
    }
    const body = request.body ? JSON.parse(request.body) : {};
    postCalls.push({ pathname: parsed.pathname, body });
    if (!delayed && parsed.pathname === options.delayPath && Number(options.delayMs || 0) > 0) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, Number(options.delayMs)));
    }
    if (parsed.pathname !== '/draft') throw Error('Unexpected synthetic endpoint');
    return jsonResponse(options.omitDraftUrl ? {} : {draftUrl:'https://draft.example.com/draft-test'});
  };
  mediaHttp.fetch=globalThis.fetch;
  return { postCalls, mediaProbeCalls,
    get maxActiveMediaProbeRequests() {return maxActiveMediaProbeRequests;},
    get mediaProbeCancelCount() {return mediaProbeCancelCount;},
    restore() {globalThis.fetch=originalFetch;mediaHttp.fetch=originalMediaFetch;}
  };
}
function jsonResponse(value,status=200) {return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});}

for (const mode of ['fixed','corners','motion']) {
  test(`draft adapter receives ${mode} watermark settings and the complete subtitle timeline`, async()=>{
    const fixture=await createDraftFixture();
    const mock=mockDraftAdapterFetch();
    try {
      const result=await executeWorkflowDraftNode(fixture.user,{
        runId:fixture.run.id,draftKeyId:'draft-key',audioTrackId:'voice-track',materialSource:'image',
        watermarkEnabled:true,watermarkText:'Synthetic watermark',watermarkMode:mode,
        watermarkColor:'#22ddcc',watermarkOpacity:65,
      },fixture.config);
      assert.equal(mock.postCalls.length,1);
      const timeline=mock.postCalls[0].body.timeline;
      assert.equal(timeline.watermark.enabled,true);
      assert.equal(timeline.watermark.text,'Synthetic watermark');
      assert.equal(timeline.watermark.mode,mode);
      assert.equal(timeline.segments.length,4);
      assert.equal(timeline.audio.parts.length,2);
      assert.match(timeline.subtitle_srt,/First line\./);
      assert.equal(result.run.result.draftConfig.watermark.mode,mode);
    } finally {mock.restore();await fixture.cleanup();}
  });
}

test('music-library audio preserves the selected subtitle timeline',async()=>{
  const fixture=await createDraftFixture();const mock=mockDraftAdapterFetch();
  try{
    const result=await executeWorkflowDraftNode(fixture.user,{runId:fixture.run.id,draftKeyId:'draft-key',audioTrackId:'voice-track',audioSource:'music',audioSourceId:'music:example',audioUrl:'https://media.example.com/music.mp3',materialSource:'image'},fixture.config);
    assert.equal(result.timeline.audio.url,'https://media.example.com/music.mp3');
    assert.deepEqual(result.timeline.audio.parts,[]);
    assert.match(result.timeline.subtitle_srt,/First line\./);
  }finally{mock.restore();await fixture.cleanup();}
});
