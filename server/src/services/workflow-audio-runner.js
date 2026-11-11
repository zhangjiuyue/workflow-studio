import { httpError } from "../http.js";
import { getDecryptedApiKey } from "./api-key-store.js";
import { assertTrustedApiModel } from "./trusted-api-registry.js";
import { updateJob } from "./job-store.js";
import { proxyAudioGeneration, proxyAudioTranscription } from "./model-proxy.js";
import { getWorkflowRun, listWorkflows, updateWorkflowRun, workflowConfigForRunSnapshot } from "./workflow-store.js";
import { saveGeneratedObject } from "../storage/object-storage.js";

const DEFAULT_CHARS_PER_SECOND_ZH = 4.2;
const DEFAULT_WORDS_PER_SECOND_EN = 2.45;

export async function executeWorkflowAudioNode(user, input, config) {
  const runId = normalizeId(input.runId);
  if (!runId) throw httpError(400, "缺少工作流任务 ID。");
  const { workflow, run } = await loadWorkflowContext(user.id, runId, config);
  const workflowConfig = workflow.config && typeof workflow.config === "object" ? workflow.config : {};
  const talkingVideo = normalizeId(workflowConfig.type || workflowConfig.workflowType) === "explain";
  const jobId = normalizeId(input.jobId);
  const script = finalWorkflowScript(run, input, { talkingVideo });
  const referenceSegments = workflowAudioReferenceSegmentsForScript(run, script);
  const optimizeStage = talkingVideo ? "skipped" : workflowOptimizeStage(run);
  if (!script) {
    const error = httpError(400, "请先完成最终口播文案。");
    await markWorkflowAudioError(user, run, jobId, error.message, config, { talkingVideo });
    throw error;
  }

  if (jobId) await updateJob(user.id, jobId, { status: "running" }, config);

  await updateWorkflowRun(user.id, run.id, {
    status: "running",
    completedAt: "",
    stages: {
      ...(run.stages || {}),
      optimize: optimizeStage,
      audio: "running",
    },
    result: {
      ...(run.result || {}),
      audioStatus: "running",
      audioError: "",
    },
    error: "",
  }, config);

  try {
    const audioResult = input.audioUrl
      ? buildExternalAudioResult(input.audioUrl, script, { ...input, referenceSegments })
      : await generateWorkflowAudio(user, config, {
          script,
          referenceSegments,
          apiKeyId: input.audioKeyId || workflowConfig.audioKeyId || input.apiKeyId,
          model: input.audioModelId || workflowConfig.audioModelId || input.modelId,
          voice: input.voice || workflowConfig.audioVoice || "alloy",
          format: input.format || workflowConfig.audioFormat || "mp3",
          emotion: input.emotion || workflowConfig.audioEmotion || "natural",
          bitrate: input.bitrate || workflowConfig.audioBitrate || 128,
          speed: input.speed || workflowConfig.audioSpeed || 1,
          voicePresetId: input.voicePresetId || workflowConfig.audioVoicePresetId || "default",
          referenceId: input.referenceId || workflowConfig.audioReferenceId || "",
          references: input.references || workflowConfig.audioReferences || [],
          returnAudioData: talkingVideo,
          projectName: input.projectName || run.topic || workflow.name || "workflow-audio",
        });
    const finalAudioResult = talkingVideo
      ? await buildTalkingWorkflowRawAudioResult(user, config, audioResult, {
          apiKeyId: input.audioKeyId || workflowConfig.audioKeyId || input.apiKeyId,
          language: workflowConfig.language || "",
        })
      : audioResult;
    const timeline = buildWorkflowTimeline(run, finalAudioResult);
    const completedJob = jobId
      ? await updateJob(user.id, jobId, {
          status: "done",
          progress: 100,
          result: {
            audioUrl: finalAudioResult.audio_url,
            duration: finalAudioResult.duration,
            segments: finalAudioResult.raw_segments?.length || finalAudioResult.segments.length,
          },
        }, config)
      : null;
    const backendJobs = run.result?.backendJobs && typeof run.result.backendJobs === "object" ? run.result.backendJobs : {};
    const updated = await updateWorkflowRun(user.id, run.id, {
      status: "waiting",
      completedAt: "",
      stages: {
        ...(run.stages || {}),
        optimize: optimizeStage,
        audio: "done",
        shot: run.stages?.shot || "pending",
        image: run.stages?.image || "pending",
        videoPrompt: run.stages?.videoPrompt || "pending",
        video: run.stages?.video || "pending",
        draft: run.stages?.draft || "pending",
      },
      result: {
        ...(run.result || {}),
        audio: finalAudioResult,
        audioUrl: finalAudioResult.audio_url,
        audioDuration: finalAudioResult.duration,
        ...(talkingVideo ? { audioRawSegments: finalAudioResult.raw_segments || [] } : {}),
        audioSegments: talkingVideo ? [] : finalAudioResult.segments,
        subtitleSrt: talkingVideo ? "" : finalAudioResult.subtitle_srt,
        timeline,
        ...(talkingVideo ? {
          talkingShotSourceAudioSegments: [],
          talkingShotSourceSubtitleSrt: "",
          talkingShotSegmentationMode: "",
          talkingShotSegmentationPlan: [],
        } : {}),
        audioStatus: "done",
        audioError: "",
        backendJobs: completedJob ? {
          ...backendJobs,
          audio: completedJob,
        } : backendJobs,
      },
      error: "",
    }, config);
    return {
      run: updated,
      audio: finalAudioResult,
      timeline,
    };
  } catch (error) {
    const message = error.message || "音频节点执行失败。";
    const erroredJob = jobId
      ? await updateJob(user.id, jobId, {
          status: "error",
          error: message,
        }, config).catch(() => null)
      : null;
    const backendJobs = run.result?.backendJobs && typeof run.result.backendJobs === "object" ? run.result.backendJobs : {};
    const updated = await updateWorkflowRun(user.id, run.id, {
      status: "error",
      stages: {
        ...(run.stages || {}),
        optimize: optimizeStage,
        audio: "error",
      },
      result: {
        ...(run.result || {}),
        audioStatus: "error",
        audioError: message,
        backendJobs: erroredJob ? {
          ...backendJobs,
          audio: erroredJob,
        } : backendJobs,
      },
      error: message,
    }, config).catch(() => null);
    if (updated) error.run = updated;
    throw error;
  }
}

async function markWorkflowAudioError(user, run, jobId, message, config, options = {}) {
  const erroredJob = jobId
    ? await updateJob(user.id, jobId, {
        status: "error",
        error: message,
      }, config).catch(() => null)
    : null;
  const backendJobs = run.result?.backendJobs && typeof run.result.backendJobs === "object" ? run.result.backendJobs : {};
  await updateWorkflowRun(user.id, run.id, {
    status: "error",
    stages: {
      ...(run.stages || {}),
      optimize: options.talkingVideo ? "skipped" : workflowOptimizeStage(run),
      audio: "error",
    },
    result: {
      ...(run.result || {}),
      audioStatus: "error",
      audioError: message,
      backendJobs: erroredJob ? {
        ...backendJobs,
        audio: erroredJob,
      } : backendJobs,
    },
    error: message,
  }, config).catch(() => null);
}

async function generateWorkflowAudio(user, config, input) {
  const result = await proxyAudioGeneration({
    ...input, text: input.script, prompt: input.script,
    referenceId: input.voicePresetId === "saved" ? input.referenceId : "",
    references: input.voicePresetId === "clone" ? normalizeReferences(input.references) : [],
    returnAudioData: input.returnAudioData === true,
    taskType: "workflow-audio",
  }, config, user);
  return {
    ...normalizeAudioResult({
      audio_url: result.audioUrl || result.url,
      duration: result.duration || 0, segments: result.segments || [],
      subtitle_srt: result.subtitleSrt || "", source: "generated",
      provider: result.provider || "configured-adapter", model: result.model || input.model,
      rawFields: Object.keys(result),
    }, input.script, input.referenceSegments),
    audio_data_url: result.audioDataUrl || "",
  };
}

async function buildTalkingWorkflowRawAudioResult(user, config, audioResult = {}, input = {}) {
  if (!normalizeId(audioResult.audio_url)) throw httpError(502, "音频已经生成，但没有可用于 ASR 的音频地址。");
  const transcription = await proxyAudioTranscription({
    apiKeyId: input.apiKeyId,
    audioDataUrl: audioResult.audio_data_url || "",
    audioUrl: audioResult.audio_url,
    fileName: `workflow-talking-audio-${Date.now()}.mp3`,
    language: input.language || "",
    taskType: "workflow-audio-asr",
  }, config, user);
  const rawSegments = normalizeSegments(
    Array.isArray(transcription.tokens) && transcription.tokens.length ? transcription.tokens : transcription.segments,
    Number(transcription.duration || audioResult.duration || 0),
  );
  if (!rawSegments.length) throw httpError(502, "音频已经生成，但 ASR 没有返回可用的原始时间戳。");
  const { audio_data_url: _audioDataUrl, ...persistableAudioResult } = audioResult;
  return {
    ...persistableAudioResult,
    duration: Number(transcription.duration || audioResult.duration || rawSegments.at(-1)?.end || 0),
    raw_segments: rawSegments,
    segments: [],
    subtitle_srt: "",
    subtitle_status: "pending",
    asr_text: normalizeId(transcription.text),
    asr_provider: transcription.provider || "configured-adapter",
    asr_model: transcription.model || "configured-transcription",
  };
}

function normalizeReferences(references) {
  if (!Array.isArray(references)) return [];
  return references
    .map((reference) => ({
      ...reference,
      dataUrl: reference?.dataUrl || reference?.audio || reference?.data || "",
      text: reference?.text || reference?.transcript || "",
    }))
    .filter((reference) => reference.dataUrl)
    .slice(0, 5);
}


function buildExternalAudioResult(audioUrl, script, input = {}) {
  return normalizeAudioResult({
    audio_url: audioUrl,
    duration: input.duration,
    segments: input.segments,
    subtitle_srt: input.subtitleSrt || input.subtitle_srt,
    source: "external",
  }, script, input.referenceSegments);
}

function normalizeAudioResult(result, script, referenceSegments = []) {
  const references = normalizeReferenceSegments(referenceSegments);
  const resultDuration = Number(result.duration || 0);
  const baseSegments = references.length
    ? estimateReferenceSegments(references, resultDuration)
    : Array.isArray(result.segments) && result.segments.length
    ? normalizeSegments(result.segments)
    : estimateSegments(script, resultDuration);
  const duration = resultDuration > 0
    ? resultDuration
    : Number(baseSegments.at(-1)?.end || 0);
  const segments = normalizeSegments(baseSegments, duration);
  return {
    audio_url: normalizeId(result.audio_url || result.audioUrl || result.url),
    duration,
    segments,
    subtitle_srt: references.length ? segmentsToSrt(segments) : String(result.subtitle_srt || result.subtitleSrt || segmentsToSrt(segments)),
    source: result.source || "",
    provider: result.provider || "",
    model: result.model || "",
    rawFields: Array.isArray(result.rawFields) ? result.rawFields : [],
  };
}

function normalizeReferenceSegments(referenceSegments = []) {
  if (!Array.isArray(referenceSegments)) return [];
  return referenceSegments
    .map((segment, index) => ({
      index: Number(segment?.index || index + 1),
      text: normalizeId(segment?.text || segment?.script || segment?.content || segment).trim(),
    }))
    .filter((segment) => segment.text);
}

function estimateReferenceSegments(referenceSegments = [], requestedDuration = 0) {
  const refs = normalizeReferenceSegments(referenceSegments);
  const durations = refs.map((segment) => estimateSentenceDuration(segment.text));
  const rawDuration = durations.reduce((sum, value) => sum + value, 0);
  const scale = requestedDuration > 0 && rawDuration > 0 ? requestedDuration / rawDuration : 1;
  let cursor = 0;
  return refs.map((segment, index) => {
    const start = roundTime(cursor);
    const end = roundTime(cursor + durations[index] * scale);
    cursor = end;
    return {
      index: index + 1,
      text: segment.text,
      start,
      end,
    };
  });
}

function buildWorkflowTimeline(run, audio) {
  const shots = Array.isArray(run.result?.shots) ? run.result.shots : [];
  const shotsByIndex = new Map(shots.map((shot, index) => [Number(shot.index || index + 1), shot]));
  return {
    audio: {
      url: audio.audio_url,
      duration: audio.duration,
    },
    ...(Array.isArray(audio.raw_segments) && audio.raw_segments.length ? {
      raw_segments: audio.raw_segments.map((segment, index) => ({
        index: Number(segment.index || index + 1),
        text: segment.text,
        start: segment.start,
        end: segment.end,
      })),
    } : {}),
    segments: audio.segments.map((segment) => {
      const shot = shotsByIndex.get(Number(segment.index)) || shots[Number(segment.index) - 1] || {};
      return {
        index: segment.index,
        text: segment.text,
        start: segment.start,
        end: segment.end,
        image_url: shot.imageUrl || shot.fileUrl || shot.url || "",
        video_url: shot.videoUrl || "",
      };
    }),
    subtitle_srt: audio.subtitle_srt,
  };
}

function workflowAudioReferenceSegmentsForScript(run = {}, script = "") {
  const chunks = workflowAudioShotTextsForScript(run, script);
  return chunks.map((chunk, index) => ({
    index: index + 1,
    text: chunk.text,
  }));
}

function workflowAudioShotTextsForScript(run = {}, script = "") {
  const finalText = normalizeId(script);
  const shots = workflowAudioShotsForRun(run);
  if (!finalText || !shots.length) return [];
  const target = normalizeAudioMatchText(finalText);
  const candidates = ["display", "zh", "en"]
    .map((language) => workflowAudioShotTextCandidate(shots, language, target))
    .filter((candidate) => candidate.chunks.length);
  if (!candidates.length) return [];
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].score > 0 ? candidates[0].chunks : [];
}

function workflowAudioShotsForRun(run = {}) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const storedShots = Array.isArray(result.shots) ? result.shots : [];
  const parsedShots = parseAudioWorkflowShots(result.shotOutput);
  if (!storedShots.length) return parsedShots;
  if (!parsedShots.length) return storedShots;
  const parsedByIndex = new Map(parsedShots.map((shot, index) => [Number(shot.index || index + 1), shot]));
  return storedShots.map((shot, index) => {
    if (workflowShotScriptText(shot)) return shot;
    const parsed = parsedByIndex.get(Number(shot.index || index + 1)) || parsedShots[index] || {};
    const parsedScript = workflowShotScriptText(parsed);
    return parsedScript ? { ...shot, script: parsedScript } : shot;
  });
}

function parseAudioWorkflowShots(content = "") {
  const text = normalizeId(content);
  if (!text) return [];
  const body = text.match(/\[START_OUTPUT\]([\s\S]*?)\[END_OUTPUT\]/)?.[1] || text;
  const shots = [];
  const pattern = /(?:^|\n)\s*(?:【镜头\s*(\d+)】|\[\s*Shot\s*(\d+)\s*\]|Shot\s*(\d+)\s*[:：-]?)([\s\S]*?)(?=\n\s*(?:【镜头\s*\d+】|\[\s*Shot\s*\d+\s*\]|Shot\s*\d+\s*[:：-]?)|$)/gi;
  let match;
  while ((match = pattern.exec(body))) {
    const block = normalizeId(match[4]);
    const script = extractAudioShotField(block, audioShotScriptLabels(), audioShotImagePromptLabels());
    if (script) {
      shots.push({
        index: Number(match[1] || match[2] || match[3]) || shots.length + 1,
        script,
      });
    }
  }
  return shots;
}

function audioShotScriptLabels() {
  return ["对应文案", "Corresponding script", "Corresponding copy", "Script", "Voiceover", "Narration"];
}

function audioShotImagePromptLabels() {
  return ["画面提示词", "图片提示词", "Image prompt", "Visual prompt", "Picture prompt", "Prompt"];
}

function extractAudioShotField(block = "", labels = [], stopLabels = []) {
  const labelPattern = labels.map(escapeAudioRegExp).join("|");
  const stopPattern = [...labels, ...stopLabels].map(escapeAudioRegExp).join("|");
  if (!labelPattern) return "";
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[：:]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stopPattern})\\s*[：:]|$)`, "i");
  return block.match(pattern)?.[1]?.trim() || "";
}

function escapeAudioRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workflowAudioShotTextCandidate(shots = [], language = "display", target = "") {
  const chunks = shots
    .map((shot) => {
      const text = language === "display" ? workflowShotScriptText(shot) : workflowShotScriptTextForLanguage(shot, language);
      return text ? { text } : null;
    })
    .filter(Boolean);
  if (!chunks.length || !target) return { language, chunks, score: 0 };
  const combined = normalizeAudioMatchText(chunks.map((chunk) => chunk.text).join(""));
  const sample = chunks.map((chunk) => normalizeAudioMatchText(chunk.text)).find((text) => text.length >= 6) || combined.slice(0, 24);
  const targetHead = target.slice(0, Math.min(40, target.length));
  let score = 0;
  if (sample && target.includes(sample)) score += sample.length;
  if (targetHead && combined.includes(targetHead)) score += targetHead.length;
  score += audioTextOverlapScore(combined, target);
  return { language, chunks, score };
}

function workflowShotScriptText(shot = {}) {
  return normalizeId(shot.script || shot.copy || shot.voiceover || shot.narration || shot.correspondingScript || shot.content || shot.text);
}

function workflowShotScriptTextForLanguage(shot = {}, language = "zh") {
  const localized = shot.localizedScripts && typeof shot.localizedScripts === "object" ? shot.localizedScripts : {};
  if (language === "en") return normalizeId(shot.scriptEn || shot.englishScript || shot.script_en || localized.en || localized.english);
  if (language === "zh") return normalizeId(shot.scriptZh || shot.chineseScript || shot.script_zh || localized.zh || localized.cn || localized.chinese);
  return normalizeId(localized[language]);
}

function normalizeAudioMatchText(text = "") {
  return normalizeId(text).replace(/[\s。！？!?；;，,：:、.]/g, "").toLowerCase();
}

function audioTextOverlapScore(left = "", right = "") {
  if (!left || !right) return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  const step = Math.max(4, Math.floor(shorter.length / 20));
  let score = 0;
  for (let index = 0; index < shorter.length; index += step) {
    const piece = shorter.slice(index, index + step);
    if (piece.length >= 4 && longer.includes(piece)) score += piece.length;
  }
  return score;
}

function finalWorkflowScript(run, input = {}, options = {}) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  if (options.talkingVideo) {
    return String(
      result.scriptOutput ||
        result.script ||
        result.content ||
        input.script ||
        input.finalScript ||
        "",
    ).trim();
  }
  return String(
    input.script ||
      input.finalScript ||
      result.finalScript ||
      result.optimizedScript ||
      result.optimizedOutput ||
      result.scriptTranslation ||
      result.scriptOutput ||
      "",
  ).trim();
}

function workflowOptimizeStage(run) {
  const stages = run.stages && typeof run.stages === "object" ? run.stages : {};
  const result = run.result && typeof run.result === "object" ? run.result : {};
  if (result.scriptTranslation || result.optimizedScript || result.optimizedOutput || result.optimizationOutput) return "done";
  if (stages.optimize && !["pending", "waiting"].includes(stages.optimize)) return stages.optimize;
  return "skipped";
}

async function loadWorkflowContext(userId, runId, config) {
  const run = await getWorkflowRun(userId, runId, config);
  const workflows = await listWorkflows(userId, config);
  const workflow = workflows.find((item) => item.id === run.workflowId && item.userId === userId);
  if (!workflow) throw httpError(404, "工作流不存在。");
  return { workflow: workflowConfigForRunSnapshot(workflow, run), run };
}

function estimateSegments(script, requestedDuration = 0) {
  const sentences = splitSentences(script);
  const weights = sentences.map(estimateSentenceDuration);
  const rawDuration = weights.reduce((sum, value) => sum + value, 0);
  const scale = requestedDuration > 0 && rawDuration > 0 ? requestedDuration / rawDuration : 1;
  let cursor = 0;
  return sentences.map((text, index) => {
    const start = roundTime(cursor);
    const end = roundTime(cursor + weights[index] * scale);
    cursor = end;
    return {
      index: index + 1,
      text,
      start,
      end,
    };
  });
}

function splitSentences(script) {
  const text = String(script || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const matches = text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
  return matches.map((item) => item.trim()).filter(Boolean);
}

function estimateSentenceDuration(text) {
  const value = String(text || "").trim();
  const latinWords = value.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || [];
  if (latinWords.length >= Math.max(3, value.length / 5)) {
    return Math.max(1.2, latinWords.length / DEFAULT_WORDS_PER_SECOND_EN + 0.25);
  }
  const chars = value.replace(/\s+/g, "").length;
  return Math.max(1.2, chars / DEFAULT_CHARS_PER_SECOND_ZH + 0.2);
}

function normalizeSegments(segments = [], totalDuration = 0) {
  let cursor = 0;
  return segments.map((segment, index) => {
    const start = Number.isFinite(Number(segment.start)) ? Number(segment.start) : cursor;
    const fallbackEnd = index === segments.length - 1 && totalDuration > 0 ? totalDuration : start + estimateSentenceDuration(segment.text);
    const end = Math.max(start, Number.isFinite(Number(segment.end)) ? Number(segment.end) : fallbackEnd);
    cursor = end;
    return {
      index: Number(segment.index || index + 1),
      text: String(segment.text || "").trim(),
      start: roundTime(start),
      end: roundTime(end),
    };
  }).filter((segment) => segment.text);
}

function segmentsToSrt(segments = []) {
  return segments.map((segment, index) => (
    `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n${segment.text}\n`
  )).join("\n");
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function roundTime(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}


function extractAudioUrl(data) {
  const visit = (value) => {
    if (!value) return "";
    if (typeof value === "string") return /^https?:\/\//i.test(value) || /^\/files\//i.test(value) ? value : "";
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return "";
    }
    if (typeof value === "object") {
      for (const key of ["audio_url", "audioUrl", "url", "file_url", "output", "content"]) {
        const found = visit(value[key]);
        if (found) return found;
      }
    }
    return "";
  };
  return visit(data);
}

function extractAudioDuration(data) {
  return Number(data?.duration || data?.audio_duration || data?.audioDuration || data?.data?.duration || data?.result?.duration || 0);
}

function extractAudioSegments(data) {
  return data?.segments || data?.data?.segments || data?.result?.segments || data?.timestamps || [];
}

function extractSubtitleSrt(data) {
  return String(data?.subtitle_srt || data?.subtitleSrt || data?.srt || data?.data?.subtitle_srt || data?.result?.subtitle_srt || "");
}

async function readAudioError(response, contentType = "") {
  if (/json/i.test(contentType)) return await response.json().catch(() => ({}));
  const text = await response.text().catch(() => "");
  return { message: text.slice(0, 500) };
}

function audioExtension(contentType = "", fallback = "mp3") {
  if (/wav/i.test(contentType)) return "wav";
  if (/mpeg|mp3/i.test(contentType)) return "mp3";
  if (/ogg/i.test(contentType)) return "ogg";
  return String(fallback || "mp3").replace(/[^a-z0-9]/gi, "") || "mp3";
}

function normalizeId(value) {
  return String(value || "").trim();
}
