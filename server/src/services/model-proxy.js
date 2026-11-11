import { executeConfiguredProvider } from './configured-provider-runner.js';

export function extractVideoTaskId(data) {
  return [
    data?.id,
    data?.task,
    data?.task_id,
    data?.taskId,
    data?.job_id,
    data?.jobId,
    data?.request_id,
    data?.requestId,
    data?.generation_id,
    data?.generationId,
    data?.task?.id,
    data?.task?.task_id,
    data?.task?.taskId,
    data?.data?.id,
    data?.data?.task,
    data?.data?.task_id,
    data?.data?.taskId,
    data?.data?.job_id,
    data?.data?.jobId,
    data?.data?.request_id,
    data?.data?.requestId,
    data?.data?.generation_id,
    data?.data?.generationId,
    data?.data?.task?.id,
    data?.data?.task?.task_id,
    data?.data?.task?.taskId,
    data?.result?.id,
    data?.result?.task,
    data?.result?.task_id,
    data?.result?.taskId,
    data?.result?.job_id,
    data?.result?.jobId,
    data?.result?.request_id,
    data?.result?.requestId,
    data?.result?.generation_id,
    data?.result?.generationId,
    data?.result?.task?.id,
    data?.result?.task?.task_id,
    data?.result?.task?.taskId,
    data?.data?.[0]?.id,
    data?.data?.[0]?.task_id,
    data?.data?.[0]?.taskId,
  ].map((value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "").find(Boolean) || "";
}


export function proxyLlmCompletion(input, config, user) {
  return executeConfiguredProvider("llm", "llm", input, config, user);
}

export function proxyImageGeneration(input, config, user) {
  return executeConfiguredProvider("image", "image", input, config, user);
}

export function createVideoGeneration(input, config, user) {
  return executeConfiguredProvider("video-create", "video", input, config, user);
}

export function queryVideoGeneration(input, config, user) {
  return executeConfiguredProvider("video-query", "video", input, config, user);
}

export function proxyAudioGeneration(input, config, user) {
  return executeConfiguredProvider("audio", "audio", input, config, user);
}

export function proxyAudioTranscription(input, config, user) {
  return executeConfiguredProvider("transcribe", "audio", input, config, user);
}
