import { expireStaleWorkflowNodeJobs, listQueuedWorkflowNodeJobs, processWorkflowNodeJobById, reconcileStaleWorkflowAudioRuns, reconcileStaleWorkflowImageRuns } from "./workflow-node-queue.js";
import { requeueInterruptedJobs } from "../services/job-store.js";
import { touchWorkflowWorkerHeartbeat } from "../services/worker-heartbeat-store.js";

export function startWorkflowNodeWorker(config, options = {}) {
  const pollMs = Math.max(500, Number(options.pollMs || config.worker?.pollMs || 1500));
  const batchSize = Math.max(1, Number(options.batchSize || config.worker?.batchSize || 8));
  const activeJobIds = new Set();
  let stopped = false;
  let timer = null;
  let nextAudioWatchdogAt = 0;
  let nextImageWatchdogAt = 0;

  const recovery = touchWorkflowWorkerHeartbeat(config, { batchSize, activeCount: 0 })
    .then(() => recoverInterruptedWorkflowNodeJobs(config))
    .catch((error) => {
      console.error("[workflow-worker] recovery failed:", error.message || error);
      return { expired: [], requeued: [] };
    });

  async function tick() {
    if (stopped) return;
    try {
      await recovery;
      await touchWorkflowWorkerHeartbeat(config, { batchSize, activeCount: activeJobIds.size });
      if (Date.now() >= nextImageWatchdogAt) {
        await reconcileStaleWorkflowImageRuns(config);
        nextImageWatchdogAt = Date.now() + Math.max(1000, Number(config.worker?.imageWatchdogPollMs || 60 * 1000));
      }
      if (Date.now() >= nextAudioWatchdogAt) {
        await reconcileStaleWorkflowAudioRuns(config);
        nextAudioWatchdogAt = Date.now() + Math.max(1000, Number(config.worker?.audioWatchdogPollMs || 60 * 1000));
      }
      await expireStaleWorkflowNodeJobs(config, { excludeIds: [...activeJobIds] });
      const available = Math.max(0, batchSize - activeJobIds.size);
      if (available > 0) {
        const jobs = await listQueuedWorkflowNodeJobs(config, available);
        jobs.forEach((job) => {
          if (activeJobIds.has(job.id)) return;
          activeJobIds.add(job.id);
          processWorkflowNodeJobById(job.id, config)
            .catch((error) => {
              console.error(`[workflow-worker] job ${job.id} failed:`, error.message || error);
            })
            .finally(() => {
              activeJobIds.delete(job.id);
            });
        });
      }
    } catch (error) {
      console.error("[workflow-worker] polling failed:", error.message || error);
    } finally {
      if (!stopped) timer = setTimeout(tick, pollMs);
    }
  }

  timer = setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    activeCount() {
      return activeJobIds.size;
    },
  };
}

export async function recoverInterruptedWorkflowNodeJobs(config) {
  await reconcileStaleWorkflowImageRuns(config);
  const audioReconciled = await reconcileStaleWorkflowAudioRuns(config);
  const expired = await expireStaleWorkflowNodeJobs(config);
  const requeued = await requeueInterruptedJobs(config, {
    kind: "workflow-node",
    excludeNodeIds: ["image"],
  });
  return { audioReconciled, expired, requeued, exhausted: [] };
}
