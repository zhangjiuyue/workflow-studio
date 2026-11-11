import { withLocalMediaAccess } from './security/local-media.js';
import { publicProviderCatalog } from './services/trusted-api-registry.js';
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Router, ok, reply } from "./router.js";
import { sendJson, httpError } from "./http.js";
import { enqueueRoleAssetImageGenerationJob, processRoleAssetImageGenerationJobById } from "./jobs/asset-role-image-queue.js";
import { enqueueScriptAssetVideoAnalysisJob, processScriptAssetVideoAnalysisJobById } from "./jobs/asset-video-analysis-queue.js";
import { enqueueWritingStyleAnalysisJob, processWritingStyleAnalysisJobById } from "./jobs/asset-writing-style-analysis-queue.js";
import { getUserConcurrency, runWithUserConcurrency } from "./jobs/queue.js";
import { enqueueWorkflowNodeJob, reconcileWorkflowImageRun } from "./jobs/workflow-node-queue.js";
import { enqueueWorkflowVideoSubmissionJob } from "./jobs/workflow-video-submit-queue.js";
import { getStoreStatus } from "./storage/store.js";
import { getObjectStorageStatus, serveStoredObject, uploadAssetFiles } from "./storage/object-storage.js";
import { deleteApiKey, listApiKeys, saveApiKey } from "./services/api-key-store.js";
import { deleteAsset, deleteAssetGroup, listAssets, saveAsset, saveAssetGroup } from "./services/asset-store.js";
import { cancelJob, createJob, getJob, listJobs, updateJob } from "./services/job-store.js";
import { createFileDownload, createFileZipPackage, createImageDownload, createImageWatermark, createImageZipPackage } from "./services/image-package.js";
import { createVideoGeneration, proxyAudioGeneration, proxyAudioTranscription, proxyImageGeneration, proxyLlmCompletion, queryVideoGeneration } from "./services/model-proxy.js";
import { listAdminAuditEvents, recordAdminAuditEvent } from "./services/admin-audit-store.js";
import { listBackendRequestLogs, summarizeBackendRequestLogs } from "./services/backend-request-log-store.js";
import { getDeploymentChecklist } from "./services/deployment-check-store.js";
import {
  createTeam,
  getUserTeamContext,
  joinTeam,
  leaveTeam,
  listAdminTeams,
  listTeamReviewAssets,
  removeTeamMember,
  reviewTeamAsset,
  updateAdminTeam,
} from "./services/team-store.js";
import { listUsageEvents, summarizeUsageEvents } from "./services/usage-store.js";
import { executeWorkflowAudioNode } from "./services/workflow-audio-runner.js";
import { executeWorkflowDraftNode } from "./services/workflow-draft-exporter.js";
import { executeWorkflowImageNode } from "./services/workflow-image-runner.js";
import { executeWorkflowLlmNode } from "./services/workflow-llm-runner.js";
import { executeWorkflowVideoAnalysisNode } from "./services/workflow-story-video-analysis-runner.js";
import { executeWorkflowVideoPromptNode } from "./services/workflow-video-prompt-runner.js";
import {
  confirmWorkflowTopics,
  createWorkflow,
  createWorkflowRun,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  getWorkflowTopicConfirmationStatus,
  listWorkflowTopicExecutionChildren,
  listWorkflowSummaries,
  listWorkflows,
  patchWorkflowRunBackendJob,
  updateWorkflow,
  updateWorkflowRun,
  workflowConfigForRunSnapshot,
} from "./services/workflow-store.js";
import {
  approveUser,
  assertAdmin,
  listUsers,
  loginUser,
  logoutUser,
  publicUser,
  registerUser,
  rejectUser,
  resolveRequestUser,
  setUserMembership,
} from "./services/user-store.js";

const imageZipJobs = new Map();
const IMAGE_ZIP_JOB_TTL_MS = 24 * 60 * 60 * 1000;

export function createApp(config) {
  const router = new Router();

  router.get("/health", ({ res }) => {
    reply(res, ok({
      service: "flowstudio-server",
      env: config.env,
      time: new Date().toISOString(),
    }));
  });

  router.get("/api/meta/roadmap", ({ res }) => {
    reply(res, ok({
      phase: "private-beta-prep",
      modules: ["auth", "admin", "memberships", "api-keys", "assets", "workflows", "jobs", "model-proxy"],
    }));
  });

  router.post("/api/auth/register", async ({ res, body, context }) => reply(res, ok(await registerUser(context.config, body))));
  router.post("/api/auth/login", async ({ res, body, context }) => reply(res, ok(await loginUser(context.config, body))));
  router.post("/api/auth/logout", async ({ req, res, context }) => {
    const auth = String(req.headers.authorization || "");
    await logoutUser(context.config, auth.startsWith("Bearer ") ? auth.slice(7).trim() : "");
    reply(res, ok());
  });
  router.get("/api/auth/me", async ({ res, context }) => {
    const concurrency = getUserConcurrency(context.currentUser.id);
    const teamContext = await getUserTeamContext(context.config, context.currentUser.id);
    reply(res, ok({
      user: {
        ...publicUser(context.currentUser),
        team: teamContext.team ? {
          id: teamContext.team.id,
          name: teamContext.team.name,
          role: teamContext.role,
          seatLimit: teamContext.team.seatLimit,
          seatUsed: teamContext.team.seatUsed,
        } : null,
      },
      team: teamContext,
      concurrency: {
        ...concurrency,
        limit: Number(context.currentUser.membership?.concurrentJobs || 1),
      },
      worker: {
        enabled: Boolean(context.config.worker?.enabled),
        pollMs: Number(context.config.worker?.pollMs || 1500),
        batchSize: Number(context.config.worker?.batchSize || 8),
      },
    }));
  });

  router.get("/api/admin/users", async ({ res, context }) => {
    assertAdmin(context.currentUser);
    reply(res, ok({ users: await listUsers(context.config) }));
  });
  router.get("/api/admin/system", ({ res, context }) => {
    assertAdmin(context.currentUser);
    const concurrency = getUserConcurrency(context.currentUser.id);
    reply(res, ok({
      server: {
        env: context.config.env,
        appOrigin: context.config.appOrigin,
      },
      storage: {
        ...getStoreStatus(context.config),
        objectStorage: getObjectStorageStatus(context.config),
      },
      concurrency: {
        ...concurrency,
        limit: Number(context.currentUser.membership?.concurrentJobs || 1),
      },
    }));
  });
  router.get("/api/admin/deployment-check", ({ res, context }) => {
    assertAdmin(context.currentUser);
    reply(res, ok(getDeploymentChecklist(context.config)));
  });
  router.post("/api/admin/users/:id/approve", async ({ res, params, body, context }) => {
    assertAdmin(context.currentUser);
    const user = await approveUser(context.config, params.id, body);
    await recordAdminAuditEvent(context.config, {
      actorUser: context.currentUser,
      action: "user.approve",
      targetUserId: user.id,
      targetEmail: user.email,
      details: { membership: user.membership },
    });
    reply(res, ok({ user }));
  });
  router.post("/api/admin/users/:id/reject", async ({ res, params, context }) => {
    assertAdmin(context.currentUser);
    const user = await rejectUser(context.config, params.id);
    await recordAdminAuditEvent(context.config, {
      actorUser: context.currentUser,
      action: "user.reject",
      targetUserId: user.id,
      targetEmail: user.email,
    });
    reply(res, ok({ user }));
  });
  router.post("/api/admin/users/:id/membership", async ({ res, params, body, context }) => {
    assertAdmin(context.currentUser);
    const user = await setUserMembership(context.config, params.id, body);
    await recordAdminAuditEvent(context.config, {
      actorUser: context.currentUser,
      action: "membership.update",
      targetUserId: user.id,
      targetEmail: user.email,
      details: { membership: user.membership },
    });
    reply(res, ok({ user }));
  });
  router.get("/api/admin/teams", async ({ res, context }) => {
    assertAdmin(context.currentUser);
    reply(res, ok(await listAdminTeams(context.config)));
  });
  router.post("/api/admin/teams/:id", async ({ res, params, body, context }) => {
    assertAdmin(context.currentUser);
    const result = await updateAdminTeam(context.config, params.id, body);
    await recordAdminAuditEvent(context.config, {
      actorUser: context.currentUser,
      action: "team.update",
      details: { teamId: params.id, patch: body },
    });
    reply(res, ok(result));
  });
  router.get("/api/admin/audit", async ({ res, url, context }) => {
    assertAdmin(context.currentUser);
    reply(res, ok({
      events: await listAdminAuditEvents(context.config, {
        targetUserId: url.searchParams.get("targetUserId") || "",
        action: url.searchParams.get("action") || "",
        limit: url.searchParams.get("limit") || 80,
      }),
    }));
  });

  router.get("/api/provider-catalog", ({ res }) => reply(res, ok({ providers: publicProviderCatalog() })));

  router.get("/api/api-keys", async ({ res, context }) => {
    reply(res, ok({ apiKeys: await listApiKeys(context.currentUser.id, context.config) }));
  });
  router.post("/api/api-keys", async ({ res, body, context }) => {
    reply(res, ok({ apiKey: await saveApiKey(context.currentUser, body, context.config) }));
  });
  router.delete("/api/api-keys/:id", async ({ res, params, context }) => {
    await deleteApiKey(context.currentUser, params.id, context.config);
    reply(res, ok({ id: params.id }));
  });

  router.get("/api/team", async ({ res, context }) => {
    const teamContext = await getUserTeamContext(context.config, context.currentUser.id);
    reply(res, ok({
      ...teamContext,
      membershipPlan: context.currentUser.membership?.plan || "",
      canCreateTeam: context.currentUser.membership?.plan === "team",
    }));
  });
  router.post("/api/team", async ({ res, body, context }) => {
    reply(res, ok(await createTeam(context.config, context.currentUser, body)));
  });
  router.post("/api/team/join", async ({ res, body, context }) => {
    reply(res, ok(await joinTeam(context.config, context.currentUser, body)));
  });
  router.post("/api/team/leave", async ({ res, context }) => {
    reply(res, ok(await leaveTeam(context.config, context.currentUser)));
  });
  router.delete("/api/team/members/:userId", async ({ res, params, context }) => {
    reply(res, ok(await removeTeamMember(context.config, context.currentUser, params.userId)));
  });
  router.get("/api/team/reviews", async ({ res, context }) => {
    reply(res, ok(await listTeamReviewAssets(context.config, context.currentUser)));
  });
  router.post("/api/team/reviews/:assetId/approve", async ({ res, params, context }) => {
    reply(res, ok(await reviewTeamAsset(context.config, context.currentUser, params.assetId, "approve")));
  });
  router.post("/api/team/reviews/:assetId/reject", async ({ res, params, context }) => {
    reply(res, ok(await reviewTeamAsset(context.config, context.currentUser, params.assetId, "reject")));
  });

  router.post("/api/assets/upload", async ({ req, res, body, context }) => {
    reply(res, ok(await uploadAssetFiles(req, body, context.currentUser, context.config)));
  });
  router.post("/api/assets/script/video-analysis-jobs", async ({ req, res, body, context }) => {
    const job = await enqueueScriptAssetVideoAnalysisJob(context.currentUser, {
      ...body,
      publicApiBaseUrl: context.config.publicApiBaseUrl || requestPublicBaseUrl(req),
    }, context.config);
    setTimeout(() => {
      processScriptAssetVideoAnalysisJobById(job.id, context.config).catch((error) => {
        console.error(`[asset-video-worker] job ${job.id} failed:`, error.message || error);
      });
    }, 0);
    reply(res, ok({ job }), 202);
  });
  router.post("/api/assets/writing-style/analysis-jobs", async ({ res, body, context }) => {
    const job = await enqueueWritingStyleAnalysisJob(context.currentUser, body, context.config);
    setTimeout(() => {
      processWritingStyleAnalysisJobById(job.id, context.config).catch((error) => {
        console.error(`[writing-style-worker] job ${job.id} failed:`, error.message || error);
      });
    }, 0);
    reply(res, ok({ job }), 202);
  });
  router.post("/api/assets/role/image-generation-jobs", async ({ res, body, context }) => {
    const job = await enqueueRoleAssetImageGenerationJob(context.currentUser, body, context.config);
    setTimeout(() => {
      processRoleAssetImageGenerationJobById(job.id, context.config).catch((error) => {
        console.error(`[role-image-worker] job ${job.id} failed:`, error.message || error);
      });
    }, 0);
    reply(res, ok({ job }), 202);
  });
  router.get("/api/assets/:type", async ({ res, params, context }) => {
    reply(res, ok(await listAssets(context.currentUser.id, params.type, context.config)));
  });
  router.post("/api/assets/:type", async ({ res, params, body, context }) => {
    reply(res, ok({ asset: await saveAsset(context.currentUser, params.type, body, context.config) }));
  });
  router.delete("/api/assets/:type/:id", async ({ res, params, context }) => {
    reply(res, ok(await deleteAsset(context.currentUser.id, params.type, params.id, context.config)));
  });
  router.post("/api/assets/:type/groups", async ({ res, params, body, context }) => {
    reply(res, ok({ group: await saveAssetGroup(context.currentUser, params.type, body, context.config) }));
  });
  router.delete("/api/assets/:type/groups/:id", async ({ res, params, context }) => {
    reply(res, ok(await deleteAssetGroup(context.currentUser.id, params.type, params.id, context.config)));
  });

  router.get("/api/workflows", async ({ res, context }) => {
    reply(res, ok({ workflows: await listWorkflows(context.currentUser.id, context.config) }));
  });
  router.get("/api/workflows/summary", async ({ res, context }) => {
    reply(res, ok({ workflows: await listWorkflowSummaries(context.currentUser.id, context.config) }));
  });
  router.get("/api/workflows/:id", async ({ res, params, context }) => {
    reply(res, ok({ workflow: await getWorkflow(context.currentUser.id, params.id, context.config) }));
  });
  router.post("/api/workflows", async ({ res, body, context }) => {
    reply(res, ok({ workflow: await createWorkflow(context.currentUser, body, context.config) }));
  });
  router.put("/api/workflows/:id", async ({ res, params, body, context }) => {
    reply(res, ok({ workflow: await updateWorkflow(context.currentUser.id, params.id, body, context.config) }));
  });
  router.delete("/api/workflows/:id", async ({ res, params, context }) => {
    reply(res, ok({ workflow: await deleteWorkflow(context.currentUser.id, params.id, context.config) }));
  });
  router.post("/api/workflows/:id/runs", async ({ res, params, body, context }) => {
    reply(res, ok({ run: await createWorkflowRun(context.currentUser.id, params.id, body, context.config) }));
  });
  router.post("/api/workflows/runs/:runId/topics/confirm", async ({ res, params, body, context }) => {
    const result = await confirmWorkflowTopics(context.currentUser.id, params.runId, body, context.config);
    const shouldQueueScripts = body?.autoQueueScript !== false && Array.isArray(result.children) && result.children.length > 0;
    reply(res, ok({
      ...publicTopicConfirmationResult(result),
      scriptQueueing: shouldQueueScripts,
    }));
    if (shouldQueueScripts) {
      setTimeout(() => {
        queueConfirmedTopicScripts(context.currentUser, result.children || [], context.config)
          .catch((error) => {
            console.warn("Unable to queue confirmed topic scripts:", error?.message || error);
          });
      }, 0);
    }
  });
  router.get("/api/workflows/runs/:runId/topics/status", async ({ res, params, context }) => {
    const run = await getWorkflowTopicConfirmationStatus(context.currentUser.id, params.runId, context.config);
    reply(res, ok(publicTopicConfirmationResult({ run, children: [] })));
  });
  router.post("/api/workflows/runs/:runId/topics/execute", async ({ res, params, body, context }) => {
    const children = await listWorkflowTopicExecutionChildren(
      context.currentUser.id,
      params.runId,
      body,
      context.config,
    );
    const queuedChildren = await queueConfirmedTopicScripts(context.currentUser, children, context.config);
    const run = await getWorkflowTopicConfirmationStatus(context.currentUser.id, params.runId, context.config);
    const responseChildren = topicExecutionResponseChildren(run.children, body, queuedChildren);
    reply(res, ok({
      ...publicTopicConfirmationResult({ run, children: responseChildren }),
      scriptQueueing: responseChildren.some((child) => ["queued", "running"].includes(child?.stages?.script)),
    }));
  });
  router.put("/api/workflows/runs/:runId", async ({ res, params, body, context }) => {
    reply(res, ok({ run: await updateWorkflowRun(context.currentUser.id, params.runId, body, context.config) }));
  });
  router.post("/api/workflows/runs/:runId/nodes/:nodeId/retry", async ({ res, params, body, context }) => {
    reply(res, ok({
      run: await updateWorkflowRun(context.currentUser.id, params.runId, {
        ...body,
        status: "queued",
        error: "",
        result: {
          ...(body.result || {}),
          retryNodeId: params.nodeId,
          retryRequestedAt: new Date().toISOString(),
        },
      }, context.config),
    }));
  });
  router.get("/api/workflows/runs/:runId", async ({ res, params, context }) => {
    const run = await reconcileWorkflowImageRun(context.currentUser.id, params.runId, context.config)
      || await getWorkflowRun(context.currentUser.id, params.runId, context.config);
    reply(res, ok({ run }));
  });
  router.post("/api/workflows/runs/:runId/videos/queue", async ({ res, params, body, context }) => {
    const queued = await enqueueWorkflowVideoSubmissionJob(context.currentUser, {
      ...body,
      runId: params.runId,
    }, context.config);
    reply(res, ok(queued), 202);
  });

  router.get("/api/jobs", async ({ res, url, context }) => {
    reply(res, ok({
      jobs: await listJobs(context.currentUser.id, context.config, {
        status: url.searchParams.get("status") || "",
        kind: url.searchParams.get("kind") || "",
        scope: url.searchParams.get("scope") || "",
        workflowId: url.searchParams.get("workflowId") || "",
        runId: url.searchParams.get("runId") || "",
      }),
    }));
  });
  router.post("/api/jobs", async ({ res, body, context }) => {
    reply(res, ok({ job: await createJob(context.currentUser, body, context.config) }));
  });
  router.get("/api/jobs/:id", async ({ res, params, context }) => {
    reply(res, ok({ job: await getJob(context.currentUser.id, params.id, context.config) }));
  });
  router.put("/api/jobs/:id", async ({ res, params, body, context }) => {
    reply(res, ok({ job: await updateJob(context.currentUser.id, params.id, body, context.config) }));
  });
  router.post("/api/jobs/:id/cancel", async ({ res, params, context }) => {
    reply(res, ok({ job: await cancelJob(context.currentUser.id, params.id, context.config) }));
  });
  router.get("/api/usage", async ({ res, url, context }) => {
    reply(res, ok({
      events: await listUsageEvents(context.config, context.currentUser.id, usageFiltersFromUrl(url)),
    }));
  });
  router.get("/api/usage/summary", async ({ res, url, context }) => {
    reply(res, ok({
      summary: await summarizeUsageEvents(context.config, context.currentUser.id, usageFiltersFromUrl(url)),
    }));
  });
  router.get("/api/admin/usage", async ({ res, url, context }) => {
    assertAdmin(context.currentUser);
    const userId = url.searchParams.get("userId") || context.currentUser.id;
    reply(res, ok({
      events: await listUsageEvents(context.config, userId, usageFiltersFromUrl(url)),
      summary: await summarizeUsageEvents(context.config, userId, usageFiltersFromUrl(url)),
    }));
  });
  router.get("/api/admin/run-logs", async ({ res, url, context }) => {
    assertAdmin(context.currentUser);
    const filters = requestLogFiltersFromUrl(url, context.currentUser.id);
    reply(res, ok({
      events: await listBackendRequestLogs(context.config, filters),
      summary: await summarizeBackendRequestLogs(context.config, filters),
    }));
  });
  router.post("/api/workflows/runs/:runId/nodes/:nodeId/jobs", async ({ res, params, body, context }) => {
    const run = await getWorkflowRun(context.currentUser.id, params.runId, context.config);
    const jobInput = {
      ...body,
      kind: "workflow-node",
      runId: params.runId,
      nodeId: params.nodeId,
      workflowId: body.workflowId || run.workflowId,
      payload: body.payload || body || {},
    };
    const job = params.nodeId === "image"
      ? await enqueueWorkflowNodeJob(context.currentUser, jobInput, context.config)
      : await createJob(context.currentUser, jobInput, context.config);
    await patchWorkflowRunBackendJob(context.currentUser.id, params.runId, {
      nodeId: params.nodeId,
      job,
    }, context.config);
    reply(res, ok({ job }));
  });
  router.post("/api/workflows/runs/:runId/nodes/:nodeId/queue", async ({ req, res, params, body, context }) => {
    const run = await getWorkflowRun(context.currentUser.id, params.runId, context.config);
    const requestPayload = body.payload || body || {};
    const payload = params.nodeId === "source"
      ? {
          ...requestPayload,
          publicApiBaseUrl: context.config.publicApiBaseUrl || requestPublicBaseUrl(req),
        }
      : requestPayload;
    const job = await enqueueWorkflowNodeJob(context.currentUser, {
      ...body,
      runId: params.runId,
      nodeId: params.nodeId,
      workflowId: body.workflowId || run.workflowId,
      payload,
    }, context.config);
    const latestRun = await getWorkflowRun(context.currentUser.id, params.runId, context.config).catch(() => run);
    const result = latestRun.result && typeof latestRun.result === "object" ? latestRun.result : {};
    const backendJobs = result.backendJobs && typeof result.backendJobs === "object" ? result.backendJobs : {};
    const shouldPrepareAutoImages = params.nodeId === "shot" && payload.autoImages;
    const shouldMarkNodeRunning = ["source", "audio", "image", "videoPrompt", "draft"].includes(params.nodeId) || shouldPrepareAutoImages;
    const shouldResetDraftResult = params.nodeId === "draft";
    const shouldResetVideoPromptError = params.nodeId === "videoPrompt";
    const stages = latestRun.stages && typeof latestRun.stages === "object" ? latestRun.stages : {};
    const nextStages = {
      ...stages,
      ...(shouldMarkNodeRunning ? { [params.nodeId]: "running" } : {}),
      ...(shouldPrepareAutoImages ? { image: "pending" } : {}),
    };
    const updatedRun = params.nodeId === "image"
      ? await patchWorkflowRunBackendJob(context.currentUser.id, params.runId, {
        nodeId: params.nodeId,
        job,
        stages: { image: "running" },
        runPatch: { status: "running", completedAt: "" },
      }, context.config)
      : await updateWorkflowRun(context.currentUser.id, params.runId, {
      ...(shouldMarkNodeRunning ? {
        status: "running",
        completedAt: "",
        stages: nextStages,
        ...(shouldResetVideoPromptError ? { error: "" } : {}),
      } : {}),
      result: {
        ...result,
        ...(shouldResetVideoPromptError ? { videoPromptError: "" } : {}),
        ...(shouldResetDraftResult ? {
          draft: {},
          draftStatus: "running",
          draftUrl: "",
          draftId: "",
          draftError: "",
        } : {}),
        backendJobs: {
          ...backendJobs,
          [params.nodeId]: job,
        },
      },
    }, context.config);
    reply(res, ok({ job, run: updatedRun }));
  });
  router.post("/api/workflows/runs/:runId/nodes/:nodeId/execute", async ({ req, res, params, body, context }) => {
    const scope = workflowNodeExecutionScope(params.nodeId);
    const executor = workflowNodeExecutor(params.nodeId);
    const executionConfig = {
      ...context.config,
      publicApiBaseUrl: context.config.publicApiBaseUrl || requestPublicBaseUrl(req),
    };
    const result = await runWithUserConcurrency(context.currentUser, scope, () =>
      executor(context.currentUser, {
        ...body,
        runId: params.runId,
        nodeId: params.nodeId,
      }, executionConfig));
    reply(res, ok(result));
  });

  router.post("/api/tools/images", async ({ res, body, context }) => {
    const result = await runWithUserConcurrency(context.currentUser, "image", () =>
      proxyImageGeneration(body, context.config, context.currentUser));
    reply(res, ok(result));
  });
  router.post("/api/tools/image-zip", async ({ req, res, body, context }) => {
    const packagePayload = await resolveImageZipPayload(req, body, context);
    const packageResult = await createImageZipPackage(packagePayload);
    await sendImageZipPackage(req, res, packageResult);
  });
  router.post("/api/tools/image-download", async ({ res, body }) => {
    const download = await createImageDownload(body);
    await sendImageDownload(res, download);
  });
  router.post("/api/tools/image-watermark", async ({ req, res, body, context }) => {
    const image = await createImageWatermark({
      ...body,
      url: normalizePackageImageUrl(req, body?.url),
    }, context.currentUser, context.config);
    reply(res, ok({ image }));
  });
  router.get("/api/tools/image-download", async ({ res, url }) => {
    const download = await createImageDownload({
      url: url.searchParams.get("url") || "",
      fileName: url.searchParams.get("fileName") || "",
    });
    await sendImageDownload(res, download);
  });
  router.post("/api/tools/file-download", async ({ res, body }) => {
    const download = await createFileDownload(body);
    await sendFileDownload(res, download);
  });
  router.post("/api/tools/file-zip", async ({ req, res, body }) => {
    const packageResult = await createFileZipPackage(body);
    await sendImageZipPackage(req, res, packageResult);
  });
  router.post("/api/tools/file-zip/jobs", async ({ res, body, context }) => {
    cleanupImageZipJobs();
    const job = createFileZipJob(context.currentUser.id, body);
    reply(res, ok({ job: publicZipJob(job) }), 202);
  });
  router.get("/api/tools/file-zip/jobs/:id", async ({ res, params, context }) => {
    cleanupImageZipJobs();
    const job = getZipJob(params.id, context.currentUser.id);
    if (job.kind !== "file") throw httpError(404, "压缩包任务不存在。");
    reply(res, ok({ job: publicZipJob(job, "file") }));
  });
  router.delete("/api/tools/file-zip/jobs/:id", async ({ res, params, context }) => {
    cleanupImageZipJobs();
    deleteZipJob(params.id, context.currentUser.id, "file");
    reply(res, ok());
  });
  router.get("/api/tools/file-zip/jobs/:id/download", async ({ req, res, params, context }) => {
    cleanupImageZipJobs();
    const job = getZipJob(params.id, context.currentUser.id);
    if (job.kind !== "file" || job.status !== "done" || !job.packageResult) throw httpError(404, "压缩包尚未创建完成。");
    job.downloadedAt = Date.now();
    job.updatedAt = Date.now();
    await sendImageZipPackage(req, res, job.packageResult, { preserveFile: true });
  });
  router.post("/api/tools/image-zip/jobs", async ({ req, res, body, context }) => {
    cleanupImageZipJobs();
    const packagePayload = await resolveImageZipPayload(req, body, context);
    const job = createImageZipJob(context.currentUser.id, packagePayload);
    reply(res, ok({ job: publicZipJob(job) }), 202);
  });
  router.get("/api/tools/image-zip/jobs/:id", async ({ res, params, context }) => {
    cleanupImageZipJobs();
    const job = getZipJob(params.id, context.currentUser.id);
    if (job.kind === "file") throw httpError(404, "压缩包任务不存在。");
    reply(res, ok({ job: publicZipJob(job) }));
  });
  router.delete("/api/tools/image-zip/jobs/:id", async ({ res, params, context }) => {
    cleanupImageZipJobs();
    deleteZipJob(params.id, context.currentUser.id, "image");
    reply(res, ok());
  });
  router.get("/api/tools/image-zip/jobs/:id/download", async ({ req, res, params, context }) => {
    cleanupImageZipJobs();
    const job = getZipJob(params.id, context.currentUser.id);
    if (job.kind === "file" || job.status !== "done" || !job.packageResult) throw httpError(404, "压缩包尚未创建完成。");
    job.downloadedAt = Date.now();
    job.updatedAt = Date.now();
    await sendImageZipPackage(req, res, job.packageResult, { preserveFile: true });
  });
  router.post("/api/tools/llm", async ({ res, body, context }) => {
    const result = await runWithUserConcurrency(context.currentUser, "llm", () =>
      proxyLlmCompletion(body, context.config, context.currentUser));
    reply(res, ok(result));
  });
  router.post("/api/tools/videos", async ({ res, body, context }) => {
    const result = await runWithUserConcurrency(context.currentUser, "video", () =>
      createVideoGeneration(body, context.config, context.currentUser));
    reply(res, ok(result));
  });
  router.post("/api/tools/audio", async ({ res, body, context }) => {
    const result = await runWithUserConcurrency(context.currentUser, "audio", () =>
      proxyAudioGeneration(body, context.config, context.currentUser));
    reply(res, ok(result));
  });
  router.post("/api/tools/audio/transcribe", async ({ res, body, context }) => {
    const result = await runWithUserConcurrency(context.currentUser, "audio", () =>
      proxyAudioTranscription(body, context.config, context.currentUser));
    reply(res, ok(result));
  });
  router.get("/api/tools/tasks/:id", async ({ res, params, url, context }) => {
    const result = await queryVideoGeneration({
      taskId: params.id,
      apiKeyId: url.searchParams.get("apiKeyId") || "",
    }, context.config, context.currentUser);
    reply(res, ok(result));
  });

  return async function app(req, res) {
    const corsHeaders = buildCorsHeaders(req, config);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    try {
      const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
      if (pathname.startsWith("/files/") && await serveStoredObject(req, res, config)) return;
      const publicPaths = ["/health", "/api/meta/roadmap", "/api/auth/login", "/api/auth/register"];
      const currentUser = publicPaths.includes(pathname)
        ? null
        : await resolveRequestUser(req, config);
      await withLocalMediaAccess(currentUser, config, () => router.handle(req, res, { config, currentUser }));
    } catch (error) {
      sendJson(res, error.status || 500, {
        ok: false,
        message: error.message || "服务器错误。",
        detail: error.detail || {},
      }, corsHeaders);
    }
  };
}

export function publicTopicConfirmationResult(result = {}) {
  const run = result?.run && typeof result.run === "object" ? result.run : null;
  const children = Array.isArray(result?.children) ? result.children : [];
  return {
    run: run ? {
      ...publicTopicConfirmationRun(run),
      children: Array.isArray(run.children) ? run.children.map(publicTopicConfirmationRun) : [],
    } : null,
    children: children.map(publicTopicConfirmationRun),
  };
}

function publicTopicConfirmationRun(run = {}) {
  return {
    id: run.id || "",
    workflowId: run.workflowId || "",
    parentRunId: run.parentRunId || "",
    kind: run.kind || "",
    serial: run.serial || "",
    topic: run.topic || "",
    status: run.status || "",
    stages: run.stages && typeof run.stages === "object" ? run.stages : {},
    generatedTopics: Array.isArray(run.generatedTopics) ? run.generatedTopics : [],
    confirmedTopics: Array.isArray(run.confirmedTopics) ? run.confirmedTopics : [],
    confirmedTopicIndexes: Array.isArray(run.confirmedTopicIndexes) ? run.confirmedTopicIndexes : [],
    selectedTopics: Array.isArray(run.selectedTopics) ? run.selectedTopics : [],
    topicGenerationStatus: run.topicGenerationStatus || "",
    topicGenerationError: run.topicGenerationError || "",
    error: run.error || "",
    createdAt: run.createdAt || "",
    startedAt: run.startedAt || "",
    completedAt: run.completedAt || "",
    updatedAt: run.updatedAt || "",
  };
}

function workflowNodeExecutionScope(nodeId) {
  if (nodeId === "image") return "image";
  if (nodeId === "audio") return "audio";
  if (nodeId === "draft") return "video";
  return "llm";
}

function workflowNodeExecutor(nodeId) {
  if (nodeId === "source") return executeWorkflowVideoAnalysisNode;
  if (nodeId === "image") return executeWorkflowImageNode;
  if (nodeId === "audio") return executeWorkflowAudioNode;
  if (nodeId === "videoPrompt") return executeWorkflowVideoPromptNode;
  if (nodeId === "draft") return executeWorkflowDraftNode;
  return executeWorkflowLlmNode;
}

export async function queueConfirmedTopicScripts(user, children, config) {
  const queuedChildren = [];
  for (let index = 0; index < children.length; index += 3) {
    const batch = await Promise.all(children.slice(index, index + 3).map(async (child) => {
      const workflowConfig = workflowConfigForRunSnapshot({}, child);
      const inputScriptMode = workflowConfig?.topicMode === "script";
      const stages = child.stages && typeof child.stages === "object" ? child.stages : {};
      const result = child.result && typeof child.result === "object" ? child.result : {};
      const backendJobs = result.backendJobs && typeof result.backendJobs === "object" ? result.backendJobs : {};
      const existingScriptJob = backendJobs.script;
      if (["running", "done"].includes(stages.script)) return child;
      if (existingScriptJob && !["error", "canceled"].includes(existingScriptJob.status)) return child;
      const job = await enqueueWorkflowNodeJob(user, {
        workflowId: child.workflowId,
        runId: child.id,
        nodeId: "script",
        title: inputScriptMode ? "完整剧本格式转换" : "文案生成",
        payload: {
          autoQueuedFrom: inputScriptMode ? "script-input" : "topic-confirm",
          topic: child.topic || "",
          executionStep: workflowExecutionStep(workflowConfig),
        },
      }, config);
      return updateWorkflowRun(user.id, child.id, {
        status: "running",
        completedAt: "",
        stages: {
          ...stages,
          topic: "skipped",
          outline: "skipped",
          script: "running",
        },
        result: {
          ...result,
          scriptOutput: "",
          scriptError: "",
          backendJobs: {
            ...backendJobs,
            script: job,
          },
        },
      }, config);
    }));
    queuedChildren.push(...batch);
  }
  return queuedChildren;
}

function topicExecutionResponseChildren(children = [], input = {}, queuedChildren = []) {
  const childIds = new Set((Array.isArray(input?.childIds) ? input.childIds : []).map((value) => String(value || "").trim()).filter(Boolean));
  const topics = new Set((Array.isArray(input?.topics) ? input.topics : []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  const queuedIds = new Set(queuedChildren.map((child) => child?.id).filter(Boolean));
  return (Array.isArray(children) ? children : []).filter((child) => (
    queuedIds.has(child?.id) ||
    (childIds.size && childIds.has(child?.id)) ||
    (topics.size && topics.has(String(child?.topic || "").trim().toLowerCase()))
  ));
}

function workflowExecutionStep(workflow = {}) {
  return ["story", "shot", "all"].includes(workflow.executionStep) ? workflow.executionStep : "story";
}

async function sendImageZipPackage(req, res, packageResult, options = {}) {
  const encodedName = encodeURIComponent(packageResult.fileName);
  const plainName = asciiDownloadFileName(packageResult.fileName);
  const range = parseDownloadRange(req.headers.range, packageResult.size);
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${plainName}"; filename*=UTF-8''${encodedName}`,
  };
  try {
    if (range?.invalid) {
      res.writeHead(416, {
        ...headers,
        "Content-Length": 0,
        "Content-Range": `bytes */${packageResult.size}`,
      });
      res.end();
      return;
    }
    const streamOptions = range ? { start: range.start, end: range.end } : undefined;
    res.writeHead(range ? 206 : 200, {
      ...headers,
      "Content-Length": range ? range.end - range.start + 1 : packageResult.size,
      ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${packageResult.size}` } : {}),
    });
    await pipeline(createReadStream(packageResult.filePath, streamOptions), res);
  } catch (error) {
    if (!res.headersSent) throw error;
    console.error("Image zip download stream failed:", error);
  } finally {
    if (!options.preserveFile) await packageResult.cleanup?.();
  }
}

function parseDownloadRange(rangeHeader, size) {
  const value = String(rangeHeader || "").trim();
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return { invalid: true };
  }
  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

async function sendImageDownload(res, download) {
  const encodedName = encodeURIComponent(download.fileName);
  const plainName = asciiDownloadFileName(download.fileName);
  res.writeHead(200, {
    "Content-Type": download.mimeType || "image/png",
    "Content-Length": download.buffer.length,
    "Content-Disposition": `attachment; filename="${plainName}"; filename*=UTF-8''${encodedName}`,
  });
  res.end(download.buffer);
}

async function sendFileDownload(res, download) {
  const encodedName = encodeURIComponent(download.fileName);
  const plainName = asciiDownloadFileName(download.fileName);
  res.writeHead(200, {
    "Content-Type": download.mimeType || "application/octet-stream",
    "Content-Length": download.buffer.length,
    "Content-Disposition": `attachment; filename="${plainName}"; filename*=UTF-8''${encodedName}`,
  });
  res.end(download.buffer);
}

function asciiDownloadFileName(fileName) {
  return String(fileName || "workflow-images.zip")
    .replace(/[^\x20-\x7e]+/g, "-")
    .replace(/[\\/:*?"<>|;]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "workflow-images.zip";
}

function createImageZipJob(userId, packagePayload) {
  const now = Date.now();
  const total = Array.isArray(packagePayload.files) ? packagePayload.files.length : 0;
  const job = {
    id: randomUUID(),
    kind: "image",
    userId,
    status: "running",
    done: 0,
    total,
    progress: total ? 8 : 0,
    detail: total ? `准备打包 ${total} 张图片` : "准备创建压缩包",
    fileName: "",
    error: "",
    packageResult: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + IMAGE_ZIP_JOB_TTL_MS,
    downloadedAt: 0,
  };
  imageZipJobs.set(job.id, job);
  runImageZipJob(job, packagePayload);
  return job;
}

function createFileZipJob(userId, packagePayload) {
  const now = Date.now();
  const total = Array.isArray(packagePayload.files) ? packagePayload.files.length : 0;
  const job = {
    id: randomUUID(),
    kind: "file",
    userId,
    status: "running",
    done: 0,
    total,
    progress: total ? 8 : 0,
    detail: total ? `准备打包 ${total} 个文件` : "准备创建压缩包",
    fileName: "",
    error: "",
    packageResult: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + IMAGE_ZIP_JOB_TTL_MS,
    downloadedAt: 0,
  };
  imageZipJobs.set(job.id, job);
  runFileZipJob(job, packagePayload);
  return job;
}

async function runImageZipJob(job, packagePayload) {
  try {
    const packageResult = await createImageZipPackage({
      ...packagePayload,
      onProgress: (done, total) => {
        job.done = done;
        job.total = total;
        job.progress = total ? Math.max(8, Math.min(94, Math.round((done / total) * 94))) : 50;
        job.detail = `已处理 ${done}/${total} 张图片`;
        job.updatedAt = Date.now();
      },
    });
    job.status = "done";
    job.done = job.total;
    job.progress = 100;
    job.detail = `已完成 ${job.total || 0} 张图片打包`;
    job.fileName = packageResult.fileName;
    job.packageResult = packageResult;
    job.updatedAt = Date.now();
    job.expiresAt = job.updatedAt + IMAGE_ZIP_JOB_TTL_MS;
  } catch (error) {
    job.status = "error";
    job.progress = 100;
    job.error = error.message || "压缩包创建失败。";
    job.detail = job.error;
    job.updatedAt = Date.now();
    job.expiresAt = job.updatedAt + IMAGE_ZIP_JOB_TTL_MS;
  }
}

async function runFileZipJob(job, packagePayload) {
  try {
    const packageResult = await createFileZipPackage({
      ...packagePayload,
      onProgress: (done, total) => {
        job.done = done;
        job.total = total;
        job.progress = total ? Math.max(8, Math.min(94, Math.round((done / total) * 94))) : 50;
        job.detail = `已处理 ${done}/${total} 个文件`;
        job.updatedAt = Date.now();
      },
    });
    job.status = "done";
    job.done = job.total;
    job.progress = 100;
    job.detail = `已完成 ${job.total || 0} 个文件打包`;
    job.fileName = packageResult.fileName;
    job.packageResult = packageResult;
    job.updatedAt = Date.now();
    job.expiresAt = job.updatedAt + IMAGE_ZIP_JOB_TTL_MS;
  } catch (error) {
    job.status = "error";
    job.progress = 100;
    job.error = error.message || "压缩包创建失败。";
    job.detail = job.error;
    job.updatedAt = Date.now();
    job.expiresAt = job.updatedAt + IMAGE_ZIP_JOB_TTL_MS;
  }
}

function getZipJob(id, userId) {
  const job = imageZipJobs.get(id);
  if (!job || job.userId !== userId) throw httpError(404, "压缩包任务不存在。");
  return job;
}

function deleteZipJob(id, userId, kind = "") {
  const job = getZipJob(id, userId);
  if (kind === "file" && job.kind !== "file") throw httpError(404, "压缩包任务不存在。");
  if (kind === "image" && job.kind === "file") throw httpError(404, "压缩包任务不存在。");
  job.packageResult?.cleanup?.();
  imageZipJobs.delete(id);
}

function publicZipJob(job, routeKind = job.kind || "image") {
  return {
    id: job.id,
    kind: job.kind || routeKind,
    status: job.status,
    done: job.done,
    total: job.total,
    progress: job.progress,
    detail: job.detail,
    error: job.error,
    fileName: job.fileName,
    downloadPath: job.status === "done" ? `/api/tools/${routeKind === "file" ? "file" : "image"}-zip/jobs/${encodeURIComponent(job.id)}/download` : "",
    expiresAt: job.expiresAt || job.createdAt + IMAGE_ZIP_JOB_TTL_MS,
  };
}

function cleanupImageZipJobs() {
  const now = Date.now();
  for (const [id, job] of imageZipJobs.entries()) {
    if ((job.expiresAt || job.updatedAt + IMAGE_ZIP_JOB_TTL_MS) > now) continue;
    job.packageResult?.cleanup?.();
    imageZipJobs.delete(id);
  }
}

async function resolveImageZipPayload(req, body, context) {
  if (!body?.runId) return body;
  if (Array.isArray(body.files) && body.files.length) {
    const files = body.files.map((file) => ({
      ...file,
      url: normalizePackageImageUrl(req, file?.url),
    }));
    const hasSheetRows = Array.isArray(body.sheet?.rows) && body.sheet.rows.length;
    return {
      ...body,
      files,
      sheet: hasSheetRows ? body.sheet : {
        ...(body.sheet || {}),
        headers: body.sheet?.headers || ["镜头序号", "图片文件", "对应文案", "图片提示词"],
        rows: files.map((file, index) => [
          file.label || `镜头 ${String(index + 1).padStart(2, "0")}`,
          file.name || `images/scene_${String(index + 1).padStart(2, "0")}`,
          file.script || "",
          file.prompt || "",
        ]),
      },
    };
  }
  const run = await getWorkflowRun(context.currentUser.id, body.runId, context.config);
  const shots = Array.isArray(run.shots) ? run.shots : Array.isArray(run.result?.shots) ? run.result.shots : [];
  const selectedIds = new Set((Array.isArray(body.shotIds) ? body.shotIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean));
  const selectedShots = shots
    .filter((shot) => shot?.imageUrl)
    .filter((shot) => !selectedIds.size || selectedIds.has(String(shot.id || "")));
  if (!selectedShots.length) return {
    ...body,
    files: [],
  };
  const parsedScriptByNumber = parseWorkflowShotScripts(run.shotOutput);
  const files = selectedShots.map((shot, index) => {
    const indexText = String(shot.index || index + 1).padStart(2, "0");
    return {
      url: normalizePackageImageUrl(req, shot.imageUrl),
      name: `images/scene_${indexText}.${imageExtensionFromSource(shot.imageUrl)}`,
      label: `镜头 ${indexText}`,
      script: workflowShotScriptText(shot) || parsedScriptByNumber.get(indexText) || "",
      prompt: shot.prompt || shot.imagePrompt || shot.description || "",
    };
  });
  return {
    folder: safePackageName(body.folder || run.topic || `task-${run.serial || "images"}`),
    fileName: body.fileName || `${safePackageName(run.topic || `task-${run.serial || "workflow"}`)}-分镜图片.zip`,
    files,
    sheet: {
      name: "shot-image-list",
      headers: ["镜头序号", "图片文件", "对应文案", "图片提示词"],
      rows: files.map((file) => [file.label, file.name, file.script, file.prompt]),
    },
  };
}

function workflowShotScriptText(shot) {
  return String(shot?.script || shot?.copy || shot?.voiceover || shot?.narration || shot?.correspondingScript || shot?.content || shot?.text || "");
}

function parseWorkflowShotScripts(output = "") {
  const scripts = new Map();
  const text = String(output || "").replace(/\r\n/g, "\n");
  const pattern = /【镜头\s*(\d+)】([\s\S]*?)(?=【镜头\s*\d+】|$)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const indexText = String(Number(match[1]) || scripts.size + 1).padStart(2, "0");
    const script = (match[2] || "").match(/对应文案[:：]\s*([\s\S]*?)(?=画面提示词[:：]|$)/)?.[1]?.trim() || "";
    if (script) scripts.set(indexText, script);
  }
  return scripts;
}

function normalizePackageImageUrl(req, imageUrl) {
  const value = String(imageUrl || "").trim();
  if (!value || value.startsWith("data:image/") || /^https?:\/\//i.test(value)) return value;
  if (!value.startsWith("/")) return value;
  const publicBaseUrl = requestPublicBaseUrl(req);
  return publicBaseUrl ? `${publicBaseUrl}${value}` : value;
}

function requestPublicBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

function imageExtensionFromSource(src = "") {
  const match = String(src).split("?")[0].split("#")[0].match(/\.([a-zA-Z0-9]+)$/);
  const extension = match?.[1]?.toLowerCase() || "";
  if (!["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) return "png";
  return extension === "jpeg" ? "jpg" : extension;
}

function safePackageName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").replace(/\.zip$/i, "").slice(0, 80) || "file";
}

function usageFiltersFromUrl(url) {
  return {
    taskType: url.searchParams.get("taskType") || "",
    provider: url.searchParams.get("provider") || "",
    model: url.searchParams.get("model") || "",
    from: url.searchParams.get("from") || "",
    to: url.searchParams.get("to") || "",
    limit: url.searchParams.get("limit") || "",
  };
}

function requestLogFiltersFromUrl(url, fallbackUserId = "") {
  return {
    userId: url.searchParams.get("userId") || fallbackUserId,
    taskType: url.searchParams.get("taskType") || "",
    provider: url.searchParams.get("provider") || "",
    model: url.searchParams.get("model") || "",
    status: url.searchParams.get("status") || "",
    days: url.searchParams.get("days") || "",
    from: url.searchParams.get("from") || "",
    to: url.searchParams.get("to") || "",
    limit: url.searchParams.get("limit") || "",
  };
}

function buildCorsHeaders(req, config) {
  const requestOrigin = String(req.headers.origin || "").trim();
  const allowedOrigin = resolveAllowedOrigin(requestOrigin, config);
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-FlowStudio-User-Id, X-FlowStudio-User-Email",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Disposition, Content-Length, Content-Range",
    "Vary": "Origin",
  };
  if (allowedOrigin) headers["Access-Control-Allow-Origin"] = allowedOrigin;
  return headers;
}

function resolveAllowedOrigin(requestOrigin, config) {
  const rules = Array.isArray(config.appOrigins) && config.appOrigins.length
    ? config.appOrigins
    : parseAllowedOrigins(config.appOrigin);
  if (!rules.length || rules.includes("*")) return "*";
  if (!requestOrigin) return rules.find((rule) => !rule.includes("*")) || "";
  return rules.some((rule) => originMatchesRule(requestOrigin, rule)) ? requestOrigin : "";
}

function parseAllowedOrigins(value) {
  return String(value || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function originMatchesRule(origin, rule) {
  if (rule === "*" || origin === rule) return true;
  if (!rule.includes("*")) return false;
  try {
    const originUrl = new URL(origin);
    const ruleUrl = new URL(rule);
    if (originUrl.protocol !== ruleUrl.protocol) return false;
    if (originUrl.port !== ruleUrl.port) return false;
    if (!ruleUrl.hostname.startsWith("*.")) return false;
    const suffix = ruleUrl.hostname.slice(1);
    return originUrl.hostname.endsWith(suffix) && originUrl.hostname !== suffix.slice(1);
  } catch {
    return false;
  }
}
