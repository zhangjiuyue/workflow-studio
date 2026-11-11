import crypto from "node:crypto";

const memoryQueue = [];
const activeJobsByUser = new Map();
const waitingJobsByUser = new Map();

export function enqueueJob(job) {
  const item = {
    id: crypto.randomUUID(),
    status: "queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
    ...job,
  };
  memoryQueue.push(item);
  return item;
}

export function listJobs() {
  return [...memoryQueue];
}

export async function runWithUserConcurrency(user, scope, task) {
  const userId = user?.id || "anonymous";
  const limit = userConcurrencyLimit(user);
  await waitForUserSlot(userId, limit, scope);
  try {
    return await task();
  } finally {
    const nextActive = (activeJobsByUser.get(userId) || 1) - 1;
    if (nextActive > 0) {
      activeJobsByUser.set(userId, nextActive);
    } else {
      activeJobsByUser.delete(userId);
    }
    releaseNextUserJob(userId);
  }
}

export function getUserConcurrency(userId) {
  return {
    active: activeJobsByUser.get(userId) || 0,
    queued: waitingJobsByUser.get(userId)?.length || 0,
  };
}

function userConcurrencyLimit(user) {
  if (!user) return 1;
  return Math.max(1, Number(user.membership?.concurrentJobs || 1));
}

async function waitForUserSlot(userId, limit, scope) {
  const active = activeJobsByUser.get(userId) || 0;
  if (active < limit) {
    activeJobsByUser.set(userId, active + 1);
    return;
  }
  await new Promise((resolve) => {
    const queue = waitingJobsByUser.get(userId) || [];
    queue.push({
      scope,
      resolve,
      queuedAt: new Date().toISOString(),
    });
    waitingJobsByUser.set(userId, queue);
  });
}

function releaseNextUserJob(userId) {
  const queue = waitingJobsByUser.get(userId) || [];
  const next = queue.shift();
  if (!queue.length) {
    waitingJobsByUser.delete(userId);
  } else {
    waitingJobsByUser.set(userId, queue);
  }
  if (next) {
    const active = activeJobsByUser.get(userId) || 0;
    activeJobsByUser.set(userId, active + 1);
    next.resolve();
  }
}
