import { mediaHttp } from '../security/public-http.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { executeConfiguredProvider } from './configured-provider-runner.js';
import { httpError } from "../http.js";
import { getDecryptedApiKey } from "./api-key-store.js";
import { getWorkflowRun, listWorkflows, updateWorkflowRun, workflowConfigForRunSnapshot } from "./workflow-store.js";

const DRAFT_MEDIA_PROBE_MAX_ATTEMPTS = 2;
const DRAFT_MEDIA_PROBE_TIMEOUT_MS = 15000;

export async function executeWorkflowDraftNode(user, input, config) {
  const runId = normalizeId(input.runId);
  if (!runId) throw httpError(400, "缺少工作流任务 ID。");
  const { workflow, run } = await loadWorkflowContext(user.id, runId, config);
  const timeline = normalizeTimeline(run, input, config, workflow);
  if (!timeline.audio.url) throw httpError(400, "请先完成音频节点，或手动保存口播音频 URL。");
  if (!timeline.segments.length) throw httpError(400, "音频节点缺少句子级时间戳，无法生成剪辑草稿。");
  const visualCount = draftTimelineVisuals(timeline).filter((segment) => segment.video_url || segment.image_url).length;
  if (!visualCount) throw httpError(400, "剪辑草稿缺少可用的分镜图片或视频素材，请先生成分镜图片/视频结果。");
  await validateDraftTimelineMedia(timeline);
  await reportDraftProgress(input.onProgress, 3, "validate", "音频时间轴和画面素材检查完成");

  await updateWorkflowRun(user.id, run.id, {
    status: "running",
    completedAt: "",
    stages: {
      ...(run.stages || {}),
      draft: "running",
    },
    result: {
      ...(run.result || {}),
      timeline,
      draft: {},
      draftStatus: "running",
      draftUrl: "",
      draftId: "",
      draftError: "",
      draftConfig: draftConfigFromTimeline(timeline),
    },
    error: "",
  }, config);

  try {
    const workflowConfig = workflow.config && typeof workflow.config === "object" ? workflow.config : {};
    const apiKeyId = input.draftKeyId || workflowConfig.draftKeyId;
    const draft = await executeConfiguredProvider("draft", "draft", {
      apiKeyId, model: input.model || workflowConfig.draftModelId,
      timeline, projectName: input.projectName || run.topic || workflow.name || "workflow-draft",
    }, config, user);
    if (![draft.draft_url, draft.draftUrl, draft.url].some(value => typeof value === "string" && /^https?:\/\//i.test(value))) {
      throw httpError(502, "草稿适配器没有返回有效的草稿下载地址。");
    }
    if (typeof input.shouldContinue === "function" && !(await input.shouldContinue())) {
      throw httpError(409, "剪辑草稿生成超时，已自动标记失败。");
    }
    await reportDraftProgress(input.onProgress, 99, "save", "正在保存草稿链接");
    const updated = await updateWorkflowRun(user.id, run.id, {
      status: "waiting",
      completedAt: "",
      stages: {
        ...(run.stages || {}),
        draft: "done",
      },
      result: {
        ...(run.result || {}),
        timeline,
        draft,
        draftStatus: "done",
        draftUrl: draft.draft_url || draft.draftUrl || draft.url || "",
        draftError: "",
        draftConfig: draftConfigFromTimeline(timeline),
      },
      error: "",
    }, config);
    await reportDraftProgress(input.onProgress, 100, "done", "剪辑草稿已生成");
    return { run: updated, draft, timeline };
  } catch (error) {
    const message = error.message || "剪辑草稿生成失败。";
    const updated = await updateWorkflowRun(user.id, run.id, {
      status: "error",
      stages: {
        ...(run.stages || {}),
        draft: "error",
      },
      result: {
        ...(run.result || {}),
        timeline,
        draftStatus: "error",
        draftError: message,
        draftConfig: draftConfigFromTimeline(timeline),
      },
      error: message,
    }, config).catch(() => null);
    if (updated) error.run = updated;
    throw error;
  }
}

export function normalizeTimeline(run, input = {}, config = {}, workflow = {}) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const selectedAudio = selectTimelineAudio(result, input);
  const audio = selectedAudio.audio;
  const segments = selectedAudio.segments;
  const baseTimeline = result.timeline && typeof result.timeline === "object" ? result.timeline : {};
  const usesExternalAudio = normalizeId(input.audioSource).toLowerCase() === "music" && normalizeId(input.audioUrl);
  const audioParts = usesExternalAudio ? [] : normalizeTimelineAudioParts(audio, config);
  const audioDuration = Number(input.audioDuration || input.duration || audio.duration || baseTimeline.audio?.duration || result.audioDuration || 0)
    || audioParts.reduce((sum, part) => sum + Number(part.duration || 0), 0);
  const materialSource = input.materialSource === "video" ? "video" : "image";
  const aspectRatio = normalizeDraftAspectRatio(input.aspectRatio || input.draftRatio || baseTimeline.aspect_ratio || baseTimeline.aspectRatio || "16:9");
  const imageMotion = normalizeDraftImageMotion(input.imageMotion || input.image_motion || baseTimeline.image_motion || baseTimeline.imageMotion || "none");
  const imageMotionScale = normalizeDraftImageMotionScale(input.imageMotionScale || input.image_motion_scale || baseTimeline.image_motion_scale || baseTimeline.imageMotionScale || 1.06);
  const watermark = normalizeDraftWatermark(input, baseTimeline.watermark);
  const shots = Array.isArray(result.shots) ? result.shots : [];
  const videoTimeline = Array.isArray(result.videoTimeline) ? result.videoTimeline : [];
  const videoResults = Array.isArray(result.videoResults) ? result.videoResults : [];
  const shotByIndex = new Map(shots.map((shot, index) => [Number(shot.index || index + 1), shot]));
  const visualSegments = buildDraftVisualSegments({
    audio,
    segments,
    shots,
    workflow,
    audioDuration,
  });
  const timelineSegments = normalizeDraftSubtitleSegments(buildContinuousVisualSegments(visualSegments, audioDuration).map((segment, index) => {
    const shotIndex = Number(segment.shot_index || segment.shotIndex || segment.index || index + 1);
    const shot = shotByIndex.get(shotIndex) || shots[index] || {};
    const imageUrl = segment.image_url || segment.imageUrl || shot.imageUrl || shot.fileUrl || shot.url || "";
    return {
      index: shotIndex,
      text: String(segment.text || "").trim(),
      start: Number(segment.start || 0),
      end: Number(segment.end || segment.start || 0),
      visual_start: Number(segment.visual_start ?? segment.start ?? 0),
      visual_end: Number(segment.visual_end ?? segment.end ?? segment.start ?? 0),
      image_url: materialSource === "image" ? normalizeDraftMediaUrl(imageUrl, config, "图片") : "",
      video_url: "",
    };
  }).filter((segment) => segment.text), audioDuration);
  const visuals = materialSource === "video"
    ? buildDraftVideoVisualSegments({
        segments: timelineSegments,
        videoTimeline,
        videoResults,
        config,
      })
    : timelineSegments.map((segment) => ({ ...segment, video_url: "" }));
  return {
    ...baseTimeline,
    audio_track_id: selectedAudio.id,
    audio_source_id: normalizeId(input.audioSourceId || selectedAudio.id),
    audio_source: normalizeId(input.audioSource || audio.source || "generated"),
    audio_label: normalizeId(input.audioLabel || audio.label || ""),
    material_source: materialSource,
    aspect_ratio: aspectRatio,
    image_motion: imageMotion,
    image_motion_scale: imageMotionScale,
    watermark,
    audio: {
      ...(baseTimeline.audio || {}),
      url: normalizeDraftMediaUrl(input.audioUrl || audio.audio_url || audio.audioUrl || audio.url || baseTimeline.audio?.url || result.audioUrl || "", config, "音频"),
      duration: audioDuration,
      parts: audioParts,
    },
    segments: timelineSegments,
    visuals,
    subtitle_srt: segmentsToSrt(timelineSegments),
  };
}

function draftConfigFromTimeline(timeline = {}) {
  return {
    audioTrackId: timeline.audio_track_id || "",
    audioSourceId: timeline.audio_source_id || timeline.audio_track_id || "",
    audioSource: timeline.audio_source || "generated",
    audioLabel: timeline.audio_label || "",
    materialSource: timeline.material_source || "image",
    aspectRatio: timeline.aspect_ratio || "16:9",
    imageMotion: timeline.image_motion || "none",
    imageMotionScale: timeline.image_motion_scale || 1.06,
    watermark: timeline.watermark && typeof timeline.watermark === "object" ? timeline.watermark : normalizeDraftWatermark(),
  };
}

function buildDraftVideoVisualSegments({ segments = [], videoTimeline = [], videoResults = [], config = {} } = {}) {
  const timelineItems = Array.isArray(videoTimeline) && videoTimeline.length
    ? videoTimeline
    : (Array.isArray(videoResults) ? videoResults.map((video, index) => ({
        index: Number(video?.index || video?.startIndex || index + 1),
        startIndex: Number(video?.startIndex || video?.index || index + 1),
        endIndex: Number(video?.endIndex || video?.startIndex || video?.index || index + 1),
        id: video?.timelineItemId || "",
      })) : []);
  if (!timelineItems.length) {
    throw httpError(400, "当前没有可用于剪辑草稿的视频时间线，请先在视频节点生成视频素材。");
  }
  const missing = [];
  const visuals = timelineItems.map((item, index) => {
    const video = findDraftVideoResult(videoResults, item, index);
    const videoUrl = workflowDraftVideoUrl(video);
    if (!videoUrl) {
      missing.push(index + 1);
      return null;
    }
    const covered = draftSegmentsForVideoTimelineItem(segments, item, index);
    if (!covered.length) {
      missing.push(index + 1);
      return null;
    }
    const first = covered[0];
    const last = covered.at(-1);
    const savedDuration = normalizeDraftVideoResultDuration(video);
    return {
      index: Number(item.index || first.index || index + 1),
      text: covered.map((segment) => segment.text).filter(Boolean).join(" "),
      start: Number(first.start || 0),
      end: Number(last.end || first.end || first.start || 0),
      visual_start: Number(first.visual_start ?? first.start ?? 0),
      visual_end: Number(last.visual_end ?? last.end ?? first.end ?? first.start ?? 0),
      image_url: "",
      video_url: normalizeDraftMediaUrl(videoUrl, config, `视频素材 ${index + 1}`),
      timeline_item_id: normalizeId(item.id || item.segmentId || video?.timelineItemId),
      ...(savedDuration > 0 ? { media_duration: savedDuration } : {}),
    };
  }).filter(Boolean);
  if (missing.length) {
    throw httpError(400, `视频画面素材尚未齐全：第 ${missing.join("、")} 个视频片段缺少可用结果。请先完成全部视频生成，或改选分镜图片。`, {
      missingVideoIndexes: missing,
      expectedVideoCount: timelineItems.length,
      readyVideoCount: visuals.length,
    });
  }
  return visuals;
}

function findDraftVideoResult(videoResults = [], timelineItem = {}, fallbackIndex = 0) {
  const results = Array.isArray(videoResults) ? videoResults : [];
  const timelineItemId = normalizeId(timelineItem.id || timelineItem.segmentId);
  if (timelineItemId) {
    const matchedById = results.find((video) => normalizeId(video?.timelineItemId) === timelineItemId);
    if (matchedById) return matchedById;
  }
  const startIndex = Number(timelineItem.startIndex || 0);
  const endIndex = Number(timelineItem.endIndex || startIndex || 0);
  if (startIndex > 0) {
    const matchedByRange = results.find((video) => (
      Number(video?.startIndex || 0) === startIndex
      && Number(video?.endIndex || video?.startIndex || 0) === endIndex
    ));
    if (matchedByRange) return matchedByRange;
  }
  return results[fallbackIndex] || null;
}

function normalizeDraftVideoResultDuration(video = {}) {
  const candidates = [
    video?.duration,
    video?.videoDuration,
    video?.video_duration,
    video?.mediaDuration,
    video?.media_duration,
    video?.data?.duration,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return roundDraftSeconds(candidate);
    }
    const match = String(candidate ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(?:s|秒)?$/i);
    const duration = Number(match?.[1] || 0);
    if (Number.isFinite(duration) && duration > 0) return roundDraftSeconds(duration);
  }
  return 0;
}

function draftSegmentsForVideoTimelineItem(segments = [], item = {}, fallbackIndex = 0) {
  const list = Array.isArray(segments) ? segments : [];
  const explicitIndexes = new Set((Array.isArray(item.shotIds) ? item.shotIds : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0));
  const startIndex = Number(item.startIndex || 0);
  const endIndex = Number(item.endIndex || startIndex || 0);
  const matched = list.filter((segment) => {
    const index = Number(segment.index || 0);
    if (explicitIndexes.has(index)) return true;
    return startIndex > 0 && endIndex > 0 && index >= Math.min(startIndex, endIndex) && index <= Math.max(startIndex, endIndex);
  });
  if (matched.length) return matched;
  return list[fallbackIndex] ? [list[fallbackIndex]] : [];
}

function draftTimelineVisuals(timeline = {}) {
  return Array.isArray(timeline.visuals) && timeline.visuals.length ? timeline.visuals : (Array.isArray(timeline.segments) ? timeline.segments : []);
}

function normalizeTimelineAudioParts(audio = {}, config = {}) {
  const parts = Array.isArray(audio.parts) ? audio.parts : [];
  return parts
    .map((part, index) => ({
      index: Number(part.index || index + 1),
      name: normalizeId(part.name || `第 ${index + 1} 段`),
      url: normalizeDraftMediaUrl(part.audio_url || part.audioUrl || part.url || part.fileUrl || "", config, `音频片段 ${index + 1}`),
      duration: Number(part.duration || part.audioDuration || (Array.isArray(part.segments) ? part.segments.at(-1)?.end : 0) || 0),
    }))
    .filter((part) => part.url);
}

function buildDraftVisualSegments({ audio = {}, segments = [], shots = [], workflow = {}, audioDuration = 0 } = {}) {
  const shotSegments = buildShotAlignedVisualSegments({ audio, segments, shots, workflow, audioDuration });
  return shotSegments.length ? shotSegments : segments;
}

function buildShotAlignedVisualSegments({ audio = {}, segments = [], shots = [], workflow = {}, audioDuration = 0 } = {}) {
  if (!Array.isArray(shots) || !shots.length || !Array.isArray(segments) || !segments.length) return [];
  const language = draftAudioLanguage(audio, workflow);
  const shotTexts = shots.map((shot) => workflowShotScriptTextForLanguage(shot, language)).map(normalizeId);
  if (!shotTexts.some(Boolean)) return [];
  const normalizedAudio = normalizeAudioTextTimeline(segments);
  const combinedAudioText = normalizedAudio.map((item) => item.norm).join("");
  if (!combinedAudioText) return [];
  let cursor = 0;
  let matchedChars = 0;
  const visualSegments = shots.map((shot, index) => {
    const shotText = shotTexts[index] || workflowShotScriptText(shot);
    const norm = normalizeDraftMatchText(shotText);
    if (!norm) return null;
    const searchFrom = Math.max(0, cursor - 24);
    const matchedStart = combinedAudioText.indexOf(norm, searchFrom);
    const fallbackStart = Math.round(combinedAudioText.length * (index / Math.max(1, shots.length)));
    const fallbackEnd = Math.round(combinedAudioText.length * ((index + 1) / Math.max(1, shots.length)));
    const startOffset = matchedStart >= 0 ? matchedStart : fallbackStart;
    const endOffset = matchedStart >= 0 ? matchedStart + norm.length : fallbackEnd;
    if (matchedStart >= 0) matchedChars += norm.length;
    cursor = Math.max(cursor, endOffset);
    const timing = draftTimingForTextOffsets(normalizedAudio, startOffset, endOffset, audioDuration);
    return {
      index: Number(shot.index || index + 1),
      shot_index: Number(shot.index || index + 1),
      text: shotText,
      start: timing.start,
      end: timing.end,
    };
  }).filter(Boolean);
  const totalChars = shotTexts.reduce((sum, text) => sum + normalizeDraftMatchText(text).length, 0);
  if (!visualSegments.length || (totalChars > 0 && matchedChars / totalChars < 0.25)) return [];
  return visualSegments;
}

function draftAudioLanguage(audio = {}, workflow = {}) {
  const variant = normalizeId(audio.variant).toLowerCase();
  if (["zh", "en", "de", "fr", "ja", "ko", "id", "pt", "es"].includes(variant)) return variant;
  if (variant === "cn") return "zh";
  const language = normalizeId(workflow?.config?.language || workflow?.language).toLowerCase();
  return ["zh", "en", "de", "fr", "ja", "ko", "id", "pt", "es"].includes(language) ? language : "zh";
}

function workflowShotScriptTextForLanguage(shot = {}, language = "zh") {
  const localized = shot.localizedScripts && typeof shot.localizedScripts === "object" ? shot.localizedScripts : {};
  if (language === "en") {
    return normalizeId(shot.scriptEn || shot.englishScript || shot.script_en || localized.en || localized.english);
  }
  if (language === "zh") {
    return normalizeId(shot.scriptZh || shot.chineseScript || shot.script_zh || localized.zh || localized.cn || localized.chinese);
  }
  return normalizeId(localized[language]);
}

function workflowShotScriptText(shot = {}) {
  return normalizeId(shot.script || shot.copy || shot.voiceover || shot.narration || shot.correspondingScript || shot.content || shot.text);
}

function normalizeAudioTextTimeline(segments = []) {
  let cursor = 0;
  return segments
    .map((segment, index) => {
      const text = normalizeId(segment.text || segment.script || segment.content);
      const norm = normalizeDraftMatchText(text);
      if (!norm) return null;
      const normStart = cursor;
      const normEnd = normStart + norm.length;
      cursor = normEnd;
      return {
        index: Number(segment.index || index + 1),
        text,
        norm,
        normStart,
        normEnd,
        start: Number(segment.start || 0),
        end: Math.max(Number(segment.start || 0), Number(segment.end || segment.start || 0)),
      };
    })
    .filter(Boolean);
}

function draftTimingForTextOffsets(items = [], startOffset = 0, endOffset = 0, audioDuration = 0) {
  const selected = items.filter((item) => item.normEnd > startOffset && item.normStart < endOffset);
  if (selected.length) {
    return {
      start: selected[0].start,
      end: selected[selected.length - 1].end,
    };
  }
  const totalChars = Math.max(1, items.at(-1)?.normEnd || 0);
  const duration = Number(audioDuration || items.at(-1)?.end || 0);
  return {
    start: duration * Math.max(0, startOffset) / totalChars,
    end: duration * Math.max(startOffset + 1, endOffset) / totalChars,
  };
}

function normalizeDraftMatchText(text = "") {
  return normalizeId(text).replace(/[\s。！？!?；;，,：:、.'"“”‘’\-—–_(){}\[\]<>《》【】]/g, "").toLowerCase();
}

function buildContinuousVisualSegments(segments = [], audioDuration = 0) {
  const normalized = (Array.isArray(segments) ? segments : [])
    .map((segment, index) => ({
      ...segment,
      index: Number(segment.index || index + 1),
      start: Number(segment.start || 0),
      end: Math.max(Number(segment.start || 0), Number(segment.end || segment.start || 0)),
    }))
    .filter((segment) => segment.text);
  let cursor = 0;
  return normalized.map((segment, index) => {
    const next = normalized[index + 1];
    const naturalEnd = next
      ? visualBoundary(segment.end, next.start)
      : Math.max(segment.end, Number(audioDuration || 0));
    const visualStart = roundDraftTime(cursor);
    const visualEnd = roundDraftTime(Math.max(visualStart + 0.1, naturalEnd));
    cursor = visualEnd;
    return {
      ...segment,
      visual_start: Math.max(0, visualStart),
      visual_end: visualEnd,
    };
  });
}

function normalizeDraftSubtitleSegments(segments = [], audioDuration = 0) {
  const minDuration = 0.05;
  const normalized = (Array.isArray(segments) ? segments : [])
    .map((segment, index) => {
      const start = Math.max(0, Number(segment.start || 0));
      const end = Math.max(start + minDuration, Number(segment.end || segment.start || 0));
      return {
        ...segment,
        index: Number(segment.index || index + 1),
        start: roundDraftTime(start),
        end: roundDraftTime(end),
      };
    })
    .filter((segment) => segment.text);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.start >= previous.end) continue;
    if (current.start > previous.start + minDuration) {
      previous.end = roundDraftTime(current.start);
      continue;
    }
    current.start = roundDraftTime(previous.end);
    current.end = roundDraftTime(Math.max(current.start + minDuration, current.end));
  }
  if (audioDuration > 0 && normalized.length) {
    const last = normalized[normalized.length - 1];
    last.end = roundDraftTime(Math.max(last.end, Math.min(Number(audioDuration), Math.max(last.start + minDuration, last.end))));
  }
  return normalized;
}

function segmentsToSrt(segments = []) {
  return segments.map((segment, index) => (
    `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${segment.text}\n`
  )).join("\n");
}

function srtTime(seconds = 0) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function visualBoundary(leftEnd = 0, rightStart = 0) {
  const left = Number(leftEnd || 0);
  const right = Number(rightStart || 0);
  if (right <= left) return right;
  return midpoint(left, right);
}

function midpoint(left = 0, right = 0) {
  return (Number(left || 0) + Number(right || 0)) / 2;
}

function roundDraftTime(value = 0) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function roundDraftSeconds(value = 0) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function selectTimelineAudio(result = {}, input = {}) {
  const tracks = Array.isArray(result.audioTracks) ? result.audioTracks : [];
  const requestedTrackId = normalizeId(input.audioTrackId);
  const selectedTrack = requestedTrackId
    ? tracks.find((track) => normalizeId(track.id) === requestedTrackId)
    : tracks.at(-1);
  const fallbackAudio = result.audio && typeof result.audio === "object" ? result.audio : {};
  const audio = selectedTrack || fallbackAudio;
  const segments = Array.isArray(audio.segments) && audio.segments.length
    ? audio.segments
    : Array.isArray(result.audioSegments) && result.audioSegments.length
      ? result.audioSegments
      : [];
  return {
    id: normalizeId(audio.id || requestedTrackId || ""),
    audio,
    segments,
    subtitleSrt: audio.subtitle_srt || audio.subtitleSrt || result.subtitleSrt || "",
  };
}

function workflowDraftVideoUrl(video = {}) {
  if (typeof video === "string") return normalizeId(video);
  if (!video || typeof video !== "object") return "";
  const candidates = [
    video.videoUrl,
    video.video_url,
    video.url,
    video.fileUrl,
    video.outputUrl,
    video.output_url,
    video.resultUrl,
    video.result_url,
    video.data?.videoUrl,
    video.data?.url,
  ];
  return normalizeId(candidates.find((value) => normalizeId(value)) || "");
}

async function reportDraftProgress(onProgress, progress, stage, detail) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress({
      progress: Math.max(0, Math.min(100, Math.round(Number(progress || 0)))),
      stage: normalizeId(stage),
      detail: normalizeId(detail),
    });
  } catch (error) {
    console.warn("Unable to save draft export progress:", error?.message || error);
  }
}

async function validateDraftTimelineMedia(timeline) {
  const seenUrls = new Set();
  const checks = [
    { label: "音频", url: timeline.audio.url },
    ...(Array.isArray(timeline.audio.parts) ? timeline.audio.parts.map((part, index) => ({ label: `音频片段 ${index + 1}`, url: part.url })) : []),
    ...draftTimelineVisuals(timeline).flatMap((segment) => {
      const items = [];
      if (segment.video_url) items.push({ label: `视频素材 ${segment.index}`, url: segment.video_url });
      else if (segment.image_url) items.push({ label: `图片素材 ${segment.index}`, url: segment.image_url });
      return items;
    }),
  ].filter((item) => {
    const url = normalizeId(item.url);
    if (!url || seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });
  const concurrency = 8;
  for (let offset = 0; offset < checks.length; offset += concurrency) {
    await Promise.all(checks.slice(offset, offset + concurrency).map((item) => (
      assertDraftMediaReachable(item.url, item.label)
    )));
  }
}

async function assertDraftMediaReachable(url, label) {
  if (!/^https?:\/\//i.test(url)) return;
  let lastNetworkError = null;
  for (let attempt = 1; attempt <= DRAFT_MEDIA_PROBE_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await mediaHttp.fetch(url, {
        headersOnly: true, timeoutMs: DRAFT_MEDIA_PROBE_TIMEOUT_MS,
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal: AbortSignal.timeout(DRAFT_MEDIA_PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      lastNetworkError = error;
      if (attempt < DRAFT_MEDIA_PROBE_MAX_ATTEMPTS) {
        await sleep(200 * attempt);
        continue;
      }
      break;
    }

    const status = response.status;
    await cancelDraftMediaProbeBody(response);
    if (response.ok) return;
    if (attempt < DRAFT_MEDIA_PROBE_MAX_ATTEMPTS && isRetryableMediaProbeStatus(status)) {
      await sleep(200 * attempt);
      continue;
    }
    throw mediaReachabilityError(label, url, status);
  }

  throw httpError(400, `${label}无法通过公网 GET 读取：${url}。请确认素材链接未过期，且允许 草稿导出服务下载。`, {
    mediaUrl: url,
    cause: lastNetworkError?.message || String(lastNetworkError || "fetch failed"),
  });
}

async function cancelDraftMediaProbeBody(response) {
  if (!response?.body) return;
  await response.body.cancel().catch(() => {});
}

function isRetryableMediaProbeStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function mediaReachabilityError(label, url, status) {
  return httpError(400, `${label}地址无法通过公网 GET 读取（HTTP ${status}）：${url}。请确认签名链接未过期，或配置 STORAGE_PUBLIC_BASE_URL 为公开 R2/CDN 域名，并确保 API_PUBLIC_BASE_URL 的 /files 路由能读取同一份素材。`, {
    mediaUrl: url,
    status,
  });
}

async function loadWorkflowContext(userId, runId, config) {
  const run = await getWorkflowRun(userId, runId, config);
  const workflows = await listWorkflows(userId, config);
  const workflow = workflows.find((item) => item.id === run.workflowId && item.userId === userId);
  if (!workflow) throw httpError(404, "工作流不存在。");
  return { workflow: workflowConfigForRunSnapshot(workflow, run), run };
}

function normalizeDraftAspectRatio(value = "") {
  const ratio = normalizeId(value);
  if (ratio.includes("1:1")) return "1:1";
  if (ratio.includes("9:16")) return "9:16";
  return "16:9";
}

function normalizeDraftImageMotion(value = "") {
  const motion = normalizeId(value).toLowerCase();
  if (["zoom_in", "zoom-in", "slow_zoom", "slow-zoom", "ken_burns"].includes(motion)) return "zoom_in";
  return "none";
}

function normalizeDraftImageMotionScale(value = 1.06) {
  const scale = Number(value);
  if ([1.03, 1.06, 1.1].some((item) => Math.abs(item - scale) < 0.001)) return scale;
  return 1.06;
}

function normalizeDraftWatermark(input = {}, existing = {}) {
  const stored = existing && typeof existing === "object" ? existing : {};
  const enabled = Boolean(input.watermarkEnabled ?? input.watermark_enabled ?? stored.enabled ?? false);
  const text = normalizeId(input.watermarkText ?? input.watermark_text ?? stored.text ?? "").slice(0, 80);
  if (enabled && !text) throw httpError(400, "请手动填写水印内容。");
  const requestedMode = normalizeId(input.watermarkMode ?? input.watermark_mode ?? stored.mode).toLowerCase();
  const requestedSize = normalizeId(input.watermarkSize ?? input.watermark_size ?? stored.size).toLowerCase();
  return {
    enabled,
    text,
    mode: ["fixed", "motion"].includes(requestedMode) ? requestedMode : "corners",
    position: normalizeDraftWatermarkPosition(input.watermarkPosition ?? input.watermark_position ?? stored.position),
    size: ["small", "medium", "large"].includes(requestedSize) ? requestedSize : "medium",
    color: normalizeDraftWatermarkColor(input.watermarkColor ?? input.watermark_color ?? stored.color),
    opacity: normalizeDraftWatermarkOpacity(input.watermarkOpacity ?? input.watermark_opacity ?? stored.opacity),
  };
}

function normalizeDraftWatermarkPosition(value = "") {
  const position = normalizeId(value).toLowerCase();
  return ["top-left", "top-right", "bottom-right", "bottom-left"].includes(position) ? position : "bottom-right";
}

function normalizeDraftWatermarkColor(value = "") {
  const color = normalizeId(value);
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : "#FFFFFF";
}

function normalizeDraftWatermarkOpacity(value = 70) {
  const numeric = Number(value);
  const percentage = Number.isFinite(numeric) && numeric <= 1 ? numeric * 100 : numeric;
  return Math.round(Math.min(100, Math.max(30, Number.isFinite(percentage) ? percentage : 70)));
}

function draftSize(ratio = "") {
  const normalized = normalizeDraftAspectRatio(ratio);
  if (normalized === "9:16") return { width: 1080, height: 1920 };
  if (normalized === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function normalizeDraftMediaUrl(value, config = {}, label = "素材") {
  const url = normalizeId(value);
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const publicBaseUrl = normalizeId(config.storage?.publicBaseUrl).replace(/\/+$/, "");
  if (url.startsWith("/files/")) {
    const apiBaseUrl = normalizeId(config.publicApiBaseUrl).replace(/\/+$/, "");
    if (publicBaseUrl) return `${publicBaseUrl}/${url.slice("/files/".length)}`;
    if (apiBaseUrl) return `${apiBaseUrl}${url}`;
    throw httpError(400, `${label}地址是本地相对路径，草稿导出服务云端无法读取。请在后端配置 API_PUBLIC_BASE_URL 为公开可访问的后端域名，或配置 STORAGE_PUBLIC_BASE_URL 为公开可访问的 R2/CDN 域名。`);
  }
  if (url.startsWith("/")) {
    const apiBaseUrl = normalizeId(config.publicApiBaseUrl).replace(/\/+$/, "");
    if (apiBaseUrl) {
      return `${apiBaseUrl}${url}`;
    }
    throw httpError(400, `${label}地址不是公网 URL，草稿导出服务云端无法读取：${url}`);
  }
  return url;
}

function normalizeId(value) {
  return String(value || "").trim();
}
