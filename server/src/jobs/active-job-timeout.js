export async function runActiveJobWithTimeout(task, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
  if (!timeoutMs) return await task();

  const message = options.message || "后台任务执行超时。";
  let timedOut = false;
  let timer = null;

  const taskPromise = Promise.resolve()
    .then(task)
    .catch((error) => {
      if (timedOut) {
        if (options.onLateError) options.onLateError(error);
        return null;
      }
      throw error;
    });

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve()
        .then(() => options.onTimeout?.())
        .catch((error) => {
          console.warn("[job-timeout] timeout handler failed:", error?.message || error);
        })
        .finally(() => reject(new Error(message)));
    }, timeoutMs);
  });

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
