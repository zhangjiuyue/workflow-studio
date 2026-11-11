// Synthetic protocol for regression tests only. No commercial provider implementation.
export async function execute({operation, input, endpoint, model, signal}) {
  const call = async (suffix, method = 'POST', body = input) => {
    const response = await fetch(endpoint + suffix, { method, signal, redirect: 'error',
      ...(method === 'POST' ? { body: JSON.stringify({...body, model}) } : {}) });
    if (!response.ok) {
      const error = new Error('Synthetic service error');
      error.status = response.status;
      if (response.status === 400) error.code = 'CONTENT_REJECTED';
      throw error;
    }
    return response.json();
  };
  if (operation === 'image') {
    let data;
    let taskId = input.providerTaskId;
    if (!taskId) {
      data = await call('/images/generations');
      taskId = data.task_id;
      if (taskId) await input.onTaskCreated?.({taskId, channel: 'Synthetic Async', status: 'queued'});
    }
    if (taskId) data = await call('/tasks/' + taskId, 'GET');
    return { images: data.data.map(image => ({url: image.url})), taskId };
  }
  if (operation === 'audio') return call('/audio');
  if (operation === 'transcribe') return call('/transcribe');
  if (operation === 'draft') return call('/draft');
  if (operation === 'video-create') return call('/video');
  if (operation === 'video-query') return call('/video/' + input.taskId, 'GET');
  throw new Error('Unsupported test operation');
}
