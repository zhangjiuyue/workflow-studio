"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildToolImageDownloadUrl,
  createImageZipJob,
  createVideoToolTask,
  deleteToolTask,
  downloadToolFile,
  downloadToolFileZip,
  downloadImageZipJob,
  generateAudio,
  generateImages,
  getImageZipJob,
  listApiKeys,
  listAssets,
  listToolTasks,
  queryVideoToolTask,
  readAuthToken,
  resolveFlowStudioFileUrl,
  saveToolTask,
  uploadAssetFiles,
} from "../../lib/flowstudio-api";
import PageLoading from "../../components/PageLoading";
import SavedAudioVoicePicker from "../../components/SavedAudioVoicePicker";
import { localizedText, useLanguage } from "../../components/LanguageProvider";
import { configuredAudioModels } from "../../lib/audio-model-options";
import { apiKeysForService } from "../../lib/api-key-options";
import { allImageModels, imageModelsForApiKey } from "../../lib/image-model-options";
import { videoGenerationModels as videoModels, videoModelsForApiKey } from "../../lib/video-model-options";

const audioEmotionOptions = [
  { value: "natural", label: "自然" },
  { value: "happy", label: "愉悦" },
  { value: "sad", label: "低沉" },
  { value: "angry", label: "有力" },
];

const audioModels = configuredAudioModels;

const audioVoicePresets = [
  {
    id: "default",
    name: "默认音色",
    tag: "系统",
    description: "不指定音色，由 音频服务 使用当前模型默认声音。",
    referenceId: "",
  },
  {
    id: "clone",
    name: "克隆音色",
    tag: "参考音频",
    description: "使用上传的参考音频随文生成配音。",
    referenceId: "",
  },
  {
    id: "saved",
    name: "已克隆音色",
    tag: "ID",
    description: "填写 音频服务 voice/model reference ID 后直接调用。",
    referenceId: "",
  },
];

const toolModes = [
  { id: "image", label: { zh: "图片生成", en: "Image" }, apiLabel: { zh: "图片生成", en: "image generation" } },
  { id: "video", label: { zh: "视频生成", en: "Video" }, apiLabel: { zh: "视频生成", en: "video generation" } },
  { id: "text", label: { zh: "文本生成", en: "Text" }, apiLabel: { zh: "文本生成", en: "text generation" } },
  { id: "audio", label: { zh: "音频生成", en: "Audio" }, apiLabel: { zh: "音频生成", en: "audio generation" } },
];

const fallbackVisualStyles = [
  {
    id: "system-real-photo",
    name: "真实摄影风",
    prompt: "realistic photography, natural lighting, authentic details, professional camera",
  },
  {
    id: "system-3d-animation",
    name: "3D动画风",
    prompt: "3D animation style, cinematic lighting, vibrant colors, smooth rendering",
  },
];

const emptyImageConfig = {
  apiKeyId: "",
  model: "",
  resolution: "1k",
  format: "png",
  ratio: "9:16",
  count: 1,
  projectName: "image",
  visualStyleId: "system-real-photo",
};

const emptyVideoConfig = {
  apiKeyId: "",
  model: "canvas-seedance-2-0",
  resolution: "默认",
  ratio: "16:9",
  duration: "6s",
  generationMode: "text",
  projectName: "video",
};

const emptyAudioConfig = {
  apiKeyId: "",
  model: configuredAudioModels[0]?.id || "s2-pro",
  format: "mp3",
  speed: 1,
  emotion: "natural",
  projectName: "audio",
  voicePresetId: "default",
  referenceId: "",
  bitrate: 128,
};

const AUDIO_SEGMENT_MAX_CHARS = 520;

export default function CreateDashboard() {
  const { language } = useLanguage();
  const [mode, setMode] = useState("image");
  const [apiKeys, setApiKeys] = useState([]);
  const [visualStyles, setVisualStyles] = useState(fallbackVisualStyles);
  const [tasks, setTasks] = useState([]);
  const [imageConfig, setImageConfig] = useState(emptyImageConfig);
  const [videoConfig, setVideoConfig] = useState(emptyVideoConfig);
  const [audioConfig, setAudioConfig] = useState(emptyAudioConfig);
  const [imagePrompt, setImagePrompt] = useState("");
  const [batchPrompt, setBatchPrompt] = useState("");
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoBatchPrompt, setVideoBatchPrompt] = useState("");
  const [audioText, setAudioText] = useState(() => (typeof localStorage === "undefined" ? "" : localStorage.getItem("flowstudio-audio-draft") || ""));
  const [referenceImages, setReferenceImages] = useState([]);
  const [referenceAudios, setReferenceAudios] = useState([]);
  const [imageLibraries, setImageLibraries] = useState([]);
  const [videoFrames, setVideoFrames] = useState({ first: null, last: null, references: [] });
  const [loadState, setLoadState] = useState("loading");
  const [message, setMessage] = useState("正在读取自由创作配置...");
  const [initialLoading, setInitialLoading] = useState(true);
  const [busyTaskId, setBusyTaskId] = useState("");
  const [previewImage, setPreviewImage] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [galleryImportContext, setGalleryImportContext] = useState(null);
  const [imageSelectionActive, setImageSelectionActive] = useState(false);
  const [selectedImageIds, setSelectedImageIds] = useState([]);
  const [selectedAudioGroupId, setSelectedAudioGroupId] = useState("");
  const [selectedAudioGroupIds, setSelectedAudioGroupIds] = useState([]);
  const [imagePackageJob, setImagePackageJob] = useState(null);
  const [downloadingPackage, setDownloadingPackage] = useState(false);
  const [downloadingAudioSelection, setDownloadingAudioSelection] = useState(false);
  const pollingVideoIdsRef = useRef(new Set());
  const imageSubmissionRunningRef = useRef(false);
  const audioQueueRef = useRef([]);
  const audioQueueRunningRef = useRef(false);
  const deletedAudioTaskIdsRef = useRef(new Set());

  useEffect(() => {
    if (!readAuthToken()) return;
    let active = true;

    async function loadCreateData() {
      setLoadState("loading");
      setMessage("正在同步 API、风格和历史任务...");
      try {
        const [apiResult, visualResult, taskResult, imageLibraryResult] = await Promise.allSettled([
          listApiKeys(),
          listAssets("visual-style"),
          listToolTasks(),
          listAssets("image-library"),
        ]);
        if (!active) return;
        if (apiResult.status !== "fulfilled") throw apiResult.reason;

        const keys = Array.isArray(apiResult.value.apiKeys) ? apiResult.value.apiKeys : [];
        const styles = visualResult.status === "fulfilled" && Array.isArray(visualResult.value.assets)
          ? mergeVisualStyles(visualResult.value.assets)
          : fallbackVisualStyles;
        const loadedTasks = taskResult.status === "fulfilled" && Array.isArray(taskResult.value.assets)
          ? taskResult.value.assets.map(normalizeToolTask).filter(Boolean)
          : [];
        const libraries = imageLibraryResult.status === "fulfilled"
          ? normalizeCreateImageLibraries(imageLibraryResult.value || { groups: [], assets: [] })
          : [];

        setApiKeys(keys);
        setVisualStyles(styles);
        setImageLibraries(libraries);
        setTasks(loadedTasks);
        setImageConfig((current) => syncConfigDefaults(current, "image", keys, styles));
        setVideoConfig((current) => syncConfigDefaults(current, "video", keys, styles));
        setAudioConfig((current) => syncConfigDefaults(current, "audio", keys, styles));
        setLoadState(taskResult.status === "fulfilled" && visualResult.status === "fulfilled" && imageLibraryResult.status === "fulfilled" ? "ready" : "warning");
        setMessage(taskResult.status === "fulfilled" ? "自由创作配置已同步。" : "配置已同步，历史任务暂时无法读取。");
      } catch (error) {
        if (!active) return;
        setLoadState("error");
        setMessage(error.message || "自由创作配置读取失败。");
      } finally {
        if (active) setInitialLoading(false);
      }
    }

    loadCreateData();
    return () => {
      active = false;
    };
  }, []);

  const isPendingMode = mode === "text";
  const activeConfig = mode === "image" ? imageConfig : mode === "video" ? videoConfig : audioConfig;
  const activeModeMeta = toolModes.find((item) => item.id === mode) || toolModes[0];
  const activeModeApiLabel = localizedText(activeModeMeta.apiLabel, language);
  const modeApiKeys = useMemo(() => apiKeysForService(apiKeys, serviceTypeForMode(mode)), [apiKeys, mode]);
  const activeApiKey = modeApiKeys.find((item) => item.id === activeConfig.apiKeyId) || modeApiKeys[0];
  const availableModels = modelsForMode(mode, activeApiKey);
  const activeModel = availableModels.find((model) => model.id === activeConfig.model) || availableModels[0];
  const modeTasks = useMemo(() => tasks.filter((task) => task.type === mode), [tasks, mode]);
  const audioHistoryGroups = useMemo(() => collectAudioHistoryGroups(tasks), [tasks]);
  const selectedAudioGroup = mode === "audio"
    ? audioHistoryGroups.find((group) => group.id === selectedAudioGroupId) || audioHistoryGroups[0] || null
    : null;
  const latestAudioGroupTasks = selectedAudioGroup?.tasks || [];
  const selectableImages = useMemo(() => collectSelectableToolImages(modeTasks), [modeTasks]);
  const selectedImageSet = useMemo(() => new Set(selectedImageIds), [selectedImageIds]);
  const selectedAudioGroupSet = useMemo(() => new Set(selectedAudioGroupIds), [selectedAudioGroupIds]);
  const selectedAudioHistoryGroups = useMemo(
    () => audioHistoryGroups.filter((group) => selectedAudioGroupSet.has(group.id)),
    [audioHistoryGroups, selectedAudioGroupSet],
  );
  const allImagesSelected = mode === "image" && selectableImages.length > 0 && selectedImageIds.length === selectableImages.length;
  const allAudioGroupsSelected = mode === "audio" && audioHistoryGroups.length > 0 && selectedAudioGroupIds.length === audioHistoryGroups.length;
  const framesRequired = mode === "video" && activeModel && videoConfig.generationMode !== "text";
  const showInitialLoading = initialLoading && loadState === "loading";

  useEffect(() => {
    if (isPendingMode) return;
    if (!activeApiKey && activeConfig.apiKeyId) {
      updateConfig(mode, { apiKeyId: "" });
      return;
    }
    if (activeApiKey && activeApiKey.id !== activeConfig.apiKeyId) {
      updateConfig(mode, { apiKeyId: activeApiKey.id });
    }
  }, [activeApiKey, activeConfig.apiKeyId, isPendingMode, mode]);

  useEffect(() => {
    if (isPendingMode || !activeModel) return;
    const patch = {};
    if (!availableModels.some((model) => model.id === activeConfig.model)) patch.model = activeModel.id;
    if (mode === "image" || mode === "video") {
      if (!activeModel.resolutions.includes(activeConfig.resolution)) patch.resolution = activeModel.resolutions[0] || "";
      if (!activeModel.ratios.some((ratio) => ratio.value === activeConfig.ratio)) patch.ratio = activeModel.ratios[0]?.value || "";
    }
    if (mode === "image" && activeModel.formats && !activeModel.formats.includes(imageConfig.format)) patch.format = activeModel.formats[0] || "png";
    if (mode === "audio") {
      if (activeModel.formats && !activeModel.formats.includes(audioConfig.format)) patch.format = activeModel.formats[0] || "mp3";
      if (activeModel.emotions && !activeModel.emotions.some((item) => item.value === audioConfig.emotion)) patch.emotion = activeModel.emotions[0]?.value || "natural";
    }
    if (mode === "video") {
      if (!activeModel.durations.includes(videoConfig.duration)) patch.duration = activeModel.durations[0] || "";
      if (!activeModel.modes.some((item) => item.value === videoConfig.generationMode)) patch.generationMode = activeModel.modes[0]?.value || "text";
    }
    if (Object.keys(patch).length) updateConfig(mode, patch);
  }, [activeModel, activeConfig, availableModels, audioConfig.emotion, audioConfig.format, imageConfig.format, isPendingMode, mode, videoConfig.duration, videoConfig.generationMode]);

  useEffect(() => {
    if (mode !== "image") {
      setImageSelectionActive(false);
      setSelectedImageIds([]);
      setImagePackageJob(null);
    }
  }, [mode]);

  useEffect(() => {
    const availableIds = new Set(selectableImages.map((image) => image.id));
    setSelectedImageIds((current) => current.filter((id) => availableIds.has(id)));
  }, [selectableImages]);

  useEffect(() => {
    const availableIds = new Set(audioHistoryGroups.map((group) => group.id));
    setSelectedAudioGroupIds((current) => current.filter((id) => availableIds.has(id)));
  }, [audioHistoryGroups]);

  useEffect(() => {
    if (!readAuthToken()) return undefined;
    const timer = setInterval(() => {
      const pendingTasks = tasks.filter((task) => task.type === "video" && task.status === "running" && task.meta?.taskId && task.meta?.apiKeyId);
      pendingTasks.forEach((task) => {
        if (pollingVideoIdsRef.current.has(task.id)) return;
        pollingVideoIdsRef.current.add(task.id);
        syncVideoTaskResult(task, { background: true }).finally(() => {
          pollingVideoIdsRef.current.delete(task.id);
        });
      });
    }, 10000);
    return () => clearInterval(timer);
  }, [tasks]);

  function updateConfig(targetMode, patch) {
    if (targetMode === "image") {
      setImageConfig((current) => ({ ...current, ...patch }));
    } else if (targetMode === "video") {
      setVideoConfig((current) => ({ ...current, ...patch }));
    } else if (targetMode === "audio") {
      setAudioConfig((current) => ({ ...current, ...patch }));
    }
  }

  async function reloadTasks() {
    setLoadState("loading");
    setMessage("正在刷新历史任务...");
    try {
      const result = await listToolTasks();
      setTasks(Array.isArray(result.assets) ? result.assets.map(normalizeToolTask).filter(Boolean) : []);
      setLoadState("ready");
      setMessage("历史任务已刷新。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "历史任务刷新失败。");
    }
  }

  async function handleReferenceFiles(files) {
    const slots = Math.max(0, 20 - referenceImages.length);
    const selected = Array.from(files || []).filter((file) => file.type.startsWith("image/")).slice(0, slots);
    const nextImages = [];
    for (const file of selected) {
      nextImages.push({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        dataUrl: await fileToDataUrl(file),
      });
    }
    setReferenceImages((current) => [...current, ...nextImages]);
  }

  function handleImportGalleryReferences(images) {
    const existingIds = new Set(referenceImages.map((image) => image.id));
    const slots = Math.max(0, 20 - referenceImages.length);
    if (!slots) return showError("参考图已达 20 张上限。");
    const imported = images
      .map(normalizeImportedReferenceImage)
      .filter((image) => image.fileUrl || image.dataUrl)
      .filter((image) => !existingIds.has(image.id))
      .slice(0, slots);
    if (!imported.length) return showError("选中的图库图片已导入，或没有可用图片地址。");
    setReferenceImages((current) => [...current, ...imported]);
    setLoadState("ready");
    setMessage(`已从图库导入 ${imported.length} 张参考图。`);
    setGalleryImportContext(null);
  }

  function openImageGalleryImport() {
    setGalleryImportContext({
      target: "image-reference",
      title: "从图库导入参考图",
      description: "选择图片库中的图片作为本次图片生成参考图。",
      maxCount: 20,
      selectedCount: referenceImages.length,
      multiple: true,
    });
  }

  function openVideoGalleryImport(kind) {
    const isMultiReference = kind === "references";
    const isFirstLast = kind === "first-last";
    setGalleryImportContext({
      target: `video-${kind}`,
      kind,
      title: isFirstLast ? "从图库导入首尾帧" : kind === "last" ? "从图库导入尾帧" : kind === "references" ? "从图库导入参考图" : "从图库导入首帧",
      description: isMultiReference ? "选择图片库中的图片作为视频通用参考。" : isFirstLast ? "最多选择 2 张，按顺序导入首帧和尾帧。" : "选择 1 张图片导入到当前视频帧位。",
      maxCount: isMultiReference ? 9 : isFirstLast ? 2 : 1,
      selectedCount: isMultiReference ? videoFrames.references.length : 0,
      multiple: isMultiReference || isFirstLast,
    });
  }

  function handleImportGalleryImages(images) {
    if (galleryImportContext?.target === "image-reference") {
      handleImportGalleryReferences(images);
      return;
    }
    const kind = galleryImportContext?.kind || "first";
    const imported = images.map(normalizeImportedReferenceImage).filter((image) => image.fileUrl || image.dataUrl);
    if (!imported.length) return showError("选中的图库图片没有可用图片地址。");
    if (kind === "references") {
      setVideoFrames((current) => {
        const existingIds = new Set(current.references.map((image) => image.id));
        const slots = Math.max(0, 9 - current.references.length);
        const next = imported.filter((image) => !existingIds.has(image.id)).slice(0, slots);
        if (!next.length) return current;
        return { ...current, references: [...current.references, ...next] };
      });
      setMessage(`已从图库导入 ${Math.min(imported.length, Math.max(0, 9 - videoFrames.references.length))} 张视频参考图。`);
    } else if (kind === "first-last") {
      setVideoFrames((current) => ({ ...current, first: imported[0] || current.first, last: imported[1] || current.last }));
      setMessage(imported[1] ? "已从图库导入首尾帧。" : "已从图库导入首帧。");
    } else {
      setVideoFrames((current) => ({ ...current, [kind]: imported[0] }));
      setMessage(kind === "last" ? "已从图库导入尾帧。" : "已从图库导入参考图。");
    }
    setLoadState("ready");
    setGalleryImportContext(null);
  }

  async function handleVideoFrameFiles(kind, files) {
    const selected = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
    try {
      if (kind === "references") {
        const slots = Math.max(0, 9 - videoFrames.references.length);
        const refs = await prepareVideoFrameImages(selected.slice(0, slots));
        setVideoFrames((current) => ({ ...current, references: [...current.references, ...refs] }));
        return;
      }
      const file = selected[0];
      if (!file) return;
      const [prepared] = await prepareVideoFrameImages([file]);
      if (!prepared) return;
      setVideoFrames((current) => ({
        ...current,
        [kind]: prepared,
      }));
    } catch (error) {
      showError(error.message || "参考图上传失败，请重新选择图片。");
    }
  }

  async function prepareVideoFrameImages(files) {
    const selected = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
    if (!selected.length) return [];
    const dataUrls = await Promise.all(selected.map(fileToDataUrl));
    setLoadState("loading");
    setMessage(`正在上传 ${selected.length} 张视频参考图...`);
    const uploadResult = await uploadAssetFiles(selected);
    const uploadedFiles = Array.isArray(uploadResult.files) ? uploadResult.files : [];
    const prepared = selected.map((file, index) => {
      const uploaded = uploadedFiles[index] || {};
      const fileUrl = resolveFlowStudioFileUrl(uploaded.url || uploaded.fileUrl || "");
      return {
        id: crypto.randomUUID(),
        name: uploaded.originalName || file.name,
        type: uploaded.mimeType || file.type,
        dataUrl: dataUrls[index],
        fileUrl,
        fileKey: uploaded.key || uploaded.fileKey || "",
      };
    });
    if (prepared.some((image) => !image.fileUrl)) throw new Error("参考图上传后没有返回可用图片链接。");
    setLoadState("ready");
    setMessage(`已上传 ${prepared.length} 张视频参考图。`);
    return prepared;
  }

  async function handleDownloadPreviewImage(image) {
    const imageUrl = resolveFlowStudioFileUrl(image?.url || "");
    if (!imageUrl) return showError("图片地址为空，无法下载。");
    try {
      const fallbackName = `${safeToolFileName(image?.title || "generated-image")}.${imageExtensionFromUrl(imageUrl) || "png"}`;
      if (imageUrl.startsWith("data:image/")) {
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        downloadToolBlob(blob, `${safeToolFileName(image?.title || "generated-image")}.${imageExtensionFromMime(blob.type) || "png"}`);
      } else {
        downloadToolLink(buildToolImageDownloadUrl({ url: imageUrl, fileName: fallbackName }), fallbackName);
      }
      setLoadState("ready");
      setMessage("图片下载已开始。");
    } catch (error) {
      showError(error.message || "图片下载失败。");
      throw error;
    }
  }

  async function handleGenerateImage() {
    const prompt = imagePrompt.trim();
    if (!prompt) return showError("请先输入图片提示词。");
    await runImageTasks([createImageTask(prompt, "queued")]);
  }

  async function handleGenerateBatchImages() {
    const prompts = parsePromptList(batchPrompt);
    if (!prompts.length) return showError("请先在批量导入区域填写提示词。");
    setBatchPrompt("");
    await runImageTasks(prompts.map((prompt) => createImageTask(prompt, "queued")));
  }

  async function runImageTasks(nextTasks) {
    if (!activeApiKey) return showError("请先选择图片生成 API。");
    if (imageSubmissionRunningRef.current) return;
    imageSubmissionRunningRef.current = true;
    setBusyTaskId(nextTasks[0]?.id || "image-submission");
    try {
      setTasks((current) => [...nextTasks, ...current]);
      setLoadState("loading");
      setMessage(`已加入 ${nextTasks.length} 个图片任务。`);

      for (const task of nextTasks) {
        await persistTask(task);
        await executeImageTask(task);
      }
    } finally {
      imageSubmissionRunningRef.current = false;
      setBusyTaskId("");
    }
  }

  async function executeImageTask(task) {
    const model = allImageModels.find((item) => item.id === task.meta?.model) || allImageModels[0];
    const runningTask = { ...task, status: "running", error: "", resultImages: [], updatedAt: new Date().toISOString() };
    setBusyTaskId(task.id);
    replaceTask(runningTask);
    await persistTask(runningTask);
    try {
      const result = await generateImages({
        requestId: task.id,
        apiKeyId: task.meta.apiKeyId,
        channel: activeApiKey.channel,
        modelId: model.modelId,
        prompt: buildImagePrompt(task, visualStyles),
        references: task.meta.references || [],
        ratio: task.meta.ratio,
        format: task.meta.format,
        resolution: task.meta.resolution,
        count: task.count || 1,
      });
      const images = extractImagesFromResponse(result).map(resolveFlowStudioFileUrl).filter(Boolean);
      if (!images.length) throw new Error("后端已完成请求，但没有返回可显示图片。");
      const doneTask = {
        ...runningTask,
        status: "done",
        resultImages: images,
        error: "",
        updatedAt: new Date().toISOString(),
        meta: { ...(runningTask.meta || {}), completedAt: new Date().toISOString() },
      };
      replaceTask(doneTask);
      await persistTask(doneTask);
      setLoadState("ready");
      setMessage("图片任务已完成。");
    } catch (error) {
      const errorTask = {
        ...runningTask,
        status: "error",
        error: error.message || "图片生成失败。",
        updatedAt: new Date().toISOString(),
      };
      replaceTask(errorTask);
      await persistTask(errorTask);
      setLoadState("error");
      setMessage(errorTask.error);
    } finally {
      if (!imageSubmissionRunningRef.current) setBusyTaskId("");
    }
  }

  async function handleGenerateVideo() {
    const prompt = videoPrompt.trim();
    if (!prompt) return showError("请先输入视频提示词。");
    if (!validateVideoFrames()) return;
    await runVideoTasks([createVideoTaskDraft(prompt)]);
  }

  async function handleGenerateBatchVideos() {
    const prompts = parsePromptList(videoBatchPrompt);
    if (!prompts.length) return showError("请先在批量导入区域填写视频提示词。");
    if (!validateVideoFrames()) return;
    setVideoBatchPrompt("");
    await runVideoTasks(prompts.map(createVideoTaskDraft));
  }

  async function runVideoTasks(nextTasks) {
    if (!activeApiKey) return showError("请先选择视频生成 API。");
    setTasks((current) => [...nextTasks, ...current]);
    setLoadState("loading");
    setMessage(`已加入 ${nextTasks.length} 个视频任务。`);

    for (const task of nextTasks) {
      await persistTask(task);
      await executeVideoTask(task);
    }
  }

  async function executeVideoTask(task) {
    const model = videoModels.find((item) => item.id === task.meta?.model) || videoModels[0];
    const runningTask = { ...task, status: "running", videoUrl: "", error: "", updatedAt: new Date().toISOString() };
    setBusyTaskId(task.id);
    replaceTask(runningTask);
    await persistTask(runningTask);
    try {
      const result = await createVideoToolTask({
        apiKeyId: task.meta.apiKeyId,
        channel: activeApiKey.channel,
        modelId: model.modelId,
        modelProvider: model.provider,
        prompt: task.prompt,
        ratio: task.meta.ratio,
        resolution: task.meta.resolution,
        duration: task.meta.duration,
        generationMode: task.meta.generationMode,
        frames: task.meta.frames || [],
      });
      const nextTask = normalizeVideoResult(runningTask, result);
      replaceTask(nextTask);
      await persistTask(nextTask);
      setLoadState(nextTask.status === "done" ? "ready" : nextTask.status === "error" ? "error" : "warning");
      setMessage(nextTask.status === "done" ? "视频任务已完成。" : nextTask.status === "error" ? nextTask.error || "视频任务生成失败。" : "视频任务已提交，可稍后查询结果。");
    } catch (error) {
      const errorTask = { ...runningTask, status: "error", error: error.message || "视频生成失败。", updatedAt: new Date().toISOString() };
      replaceTask(errorTask);
      await persistTask(errorTask);
      setLoadState("error");
      setMessage(errorTask.error);
    } finally {
      setBusyTaskId("");
    }
  }

  async function handleQueryVideo(task) {
    await syncVideoTaskResult(task, { background: false });
  }

  async function syncVideoTaskResult(task, options = {}) {
    const taskId = task.meta?.taskId;
    const apiKeyId = task.meta?.apiKeyId;
    if (!taskId || !apiKeyId) return showError("这个视频任务还没有可查询的任务编号。");
    if (!options.background) {
      setBusyTaskId(task.id);
      setLoadState("loading");
      setMessage("正在查询视频结果...");
    }
    try {
      const result = await queryVideoToolTask(apiKeyId, taskId);
      const nextTask = normalizeVideoResult(task, result);
      replaceTask(nextTask);
      await persistTask(nextTask);
      if (!options.background || nextTask.status !== "running") {
        setLoadState(nextTask.status === "done" ? "ready" : nextTask.status === "error" ? "error" : "warning");
        setMessage(nextTask.status === "done" ? (options.background ? "视频结果已自动同步。" : "视频结果已同步。") : nextTask.status === "error" ? nextTask.error || "视频任务生成失败。" : "视频仍在生成中。");
      }
    } catch (error) {
      if (!options.background) showError(error.message || "视频结果查询失败。");
    } finally {
      if (!options.background) setBusyTaskId("");
    }
  }

  async function handleAudioReferenceFiles(files) {
    const slots = Math.max(0, 5 - referenceAudios.length);
    const selected = Array.from(files || [])
      .filter((file) => file.type.startsWith("audio/"))
      .slice(0, slots);
    const nextAudios = [];
    for (const file of selected) {
      nextAudios.push({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        dataUrl: await fileToDataUrl(file),
        transcript: "",
      });
    }
    if (!nextAudios.length) return;
    setReferenceAudios((current) => [...current, ...nextAudios]);
    setLoadState("ready");
    setMessage(`已添加 ${nextAudios.length} 条参考音频。`);
  }

  function handleGenerateAudio() {
    const text = audioText.trim();
    if (!text) return showError("请先输入配音文本。");
    const groupId = crypto.randomUUID();
    const segments = splitAudioText(text);
    const nextTasks = segments.map((segment, index) => createAudioTaskDraft(segment.text, {
      groupId,
      segmentIndex: index + 1,
      segmentTotal: segments.length,
      sourceText: text,
      startChar: segment.start,
      endChar: segment.end,
    }));
    if (enqueueAudioTasks(nextTasks)) setSelectedAudioGroupId(groupId);
  }

  function enqueueAudioTasks(nextTasks) {
    if (!activeApiKey) return showError("请先选择 音频服务 API。");
    if (audioConfig.voicePresetId === "clone" && !referenceAudios.length) return showError("克隆音色需要先上传至少 1 条参考音频。");
    if (audioConfig.voicePresetId === "saved" && !audioConfig.referenceId.trim()) return showError("已克隆音色需要填写 音频服务 音色 ID。");
    nextTasks.forEach((task) => deletedAudioTaskIdsRef.current.delete(task.id));
    audioQueueRef.current.push(...nextTasks);
    setTasks((current) => [...nextTasks, ...current]);
    setLoadState("loading");
    setMessage(nextTasks.length > 1 ? `长文本已自动拆成 ${nextTasks.length} 段，已加入音频队列。` : "已加入 1 个音频任务队列。");
    void processAudioQueue();
    return true;
  }

  async function processAudioQueue() {
    if (audioQueueRunningRef.current) return;
    audioQueueRunningRef.current = true;
    try {
      while (audioQueueRef.current.length) {
        const task = audioQueueRef.current.shift();
        if (!task || deletedAudioTaskIdsRef.current.has(task.id)) continue;
        setMessage(audioQueueRef.current.length ? `正在生成音频，队列中还有 ${audioQueueRef.current.length} 个任务。` : "正在生成音频。");
        setLoadState("loading");
        await persistTask(task);
        await executeAudioTask(task);
      }
    } finally {
      audioQueueRunningRef.current = false;
    }
  }

  async function executeAudioTask(task) {
    if (deletedAudioTaskIdsRef.current.has(task.id)) return;
    const model = audioModels.find((item) => item.id === task.meta?.model) || audioModels[0];
    const runningTask = { ...task, status: "running", audioUrl: "", error: "", updatedAt: new Date().toISOString() };
    setBusyTaskId(task.id);
    replaceTask(runningTask);
    await persistTask(runningTask);
    try {
      const result = await generateAudio({
        apiKeyId: task.meta.apiKeyId,
        modelId: model.modelId,
        text: task.prompt,
        format: task.meta.format,
        bitrate: task.meta.bitrate,
        speed: task.meta.speed,
        emotion: task.meta.emotion,
        referenceId: task.meta.referenceId,
        references: task.meta.references || [],
        projectName: task.name,
      });
      if (deletedAudioTaskIdsRef.current.has(task.id)) return;
      const doneTask = normalizeAudioResult(runningTask, result);
      if (!doneTask.audioUrl) throw new Error("后端已完成请求，但没有返回可播放音频。");
      replaceTask(doneTask);
      await persistTask(doneTask);
      setLoadState("ready");
      setMessage(task.meta?.segmentTotal > 1 ? `音频分段 ${task.meta.segmentIndex}/${task.meta.segmentTotal} 已完成。` : "音频任务已完成。");
    } catch (error) {
      if (deletedAudioTaskIdsRef.current.has(task.id)) return;
      const errorTask = { ...runningTask, status: "error", error: friendlyAudioError(error), updatedAt: new Date().toISOString() };
      replaceTask(errorTask);
      await persistTask(errorTask);
      setLoadState("error");
      setMessage(errorTask.error);
    } finally {
      setBusyTaskId((current) => (current === task.id ? "" : current));
    }
  }

  function requestRegenerate(task) {
    setConfirmDialog({
      tone: "default",
      title: task.type === "image" ? "确认重生图片？" : task.type === "audio" ? "确认重生音频？" : "确认重生视频？",
      message: `将基于“${task.name}”重新创建一条生成任务，原任务会保留。`,
      confirmText: "确认重生",
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleRegenerate(task);
      },
    });
  }

  async function handleRegenerate(task) {
    if (task.type === "image") {
      if (imageSubmissionRunningRef.current) return;
      imageSubmissionRunningRef.current = true;
      try {
        await executeImageTask({ ...task, id: crypto.randomUUID(), name: uniqueTaskName(imageConfig.projectName || "image", tasks, "image"), createdAt: new Date().toISOString(), status: "queued" });
      } finally {
        imageSubmissionRunningRef.current = false;
        setBusyTaskId("");
      }
      return;
    }
    if (task.type === "audio") {
      enqueueAudioTasks([{ ...task, id: crypto.randomUUID(), name: uniqueTaskName(audioConfig.projectName || "audio", tasks, "audio"), createdAt: new Date().toISOString(), status: "queued" }]);
      return;
    }
    await executeVideoTask({ ...task, id: crypto.randomUUID(), name: uniqueTaskName(videoConfig.projectName || "video", tasks, "video"), createdAt: new Date().toISOString(), status: "draft" });
  }

  function requestDeleteTask(task) {
    setConfirmDialog({
      tone: "danger",
      title: "确认删除任务？",
      message: `删除“${task.name}”后，这条任务记录将从当前列表移除。`,
      confirmText: "删除",
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleDeleteTask(task);
      },
    });
  }

  async function handleDeleteTask(task) {
    setTasks((current) => current.filter((item) => item.id !== task.id));
    try {
      await deleteToolTask(task.id);
      setLoadState("ready");
      setMessage("任务已删除。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "任务删除失败。");
    }
  }

  function requestDeleteAudioGroup(group) {
    if (!group?.tasks?.length) return;
    setConfirmDialog({
      tone: "danger",
      title: "确认删除历史任务？",
      message: `删除“${group.name}”后，本次音频任务的 ${group.tasks.length} 条分段记录都会移除。`,
      confirmText: "删除",
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleDeleteAudioTasks(group.tasks);
        setSelectedAudioGroupId("");
        setSelectedAudioGroupIds((current) => current.filter((id) => id !== group.id));
      },
    });
  }

  function requestDeleteSelectedAudioGroups() {
    if (!selectedAudioHistoryGroups.length) return;
    const selectedTasks = selectedAudioHistoryGroups.flatMap((group) => group.tasks || []);
    setConfirmDialog({
      tone: "danger",
      title: "确认删除所选音频历史？",
      message: `将删除 ${selectedAudioHistoryGroups.length} 个历史任务组的 ${selectedTasks.length} 条音频记录。`,
      confirmText: "删除所选",
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleDeleteAudioTasks(selectedTasks);
        if (selectedAudioHistoryGroups.some((group) => group.id === selectedAudioGroupId)) setSelectedAudioGroupId("");
        setSelectedAudioGroupIds([]);
      },
    });
  }

  function requestClearAudioHistory() {
    const audioTasks = tasks.filter((task) => task.type === "audio");
    if (!audioTasks.length) return;
    setConfirmDialog({
      tone: "danger",
      title: "确认清空音频历史？",
      message: `将删除 ${audioTasks.length} 条音频任务记录，图片和视频任务不会受到影响。`,
      confirmText: "清空",
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleDeleteAudioTasks(audioTasks);
        setSelectedAudioGroupId("");
        setSelectedAudioGroupIds([]);
      },
    });
  }

  async function handleDeleteAudioTasks(audioTasks) {
    const ids = audioTasks.map((task) => task.id).filter(Boolean);
    if (!ids.length) return;
    const idSet = new Set(ids);
    ids.forEach((id) => deletedAudioTaskIdsRef.current.add(id));
    audioQueueRef.current = audioQueueRef.current.filter((task) => !idSet.has(task.id));
    setTasks((current) => current.filter((item) => !idSet.has(item.id)));
    try {
      await Promise.all(ids.map((id) => deleteToolTask(id).catch((error) => {
        if (error?.status !== 404) throw error;
      })));
      setLoadState("ready");
      setMessage(ids.length > 1 ? `已删除 ${ids.length} 条音频任务记录。` : "音频任务已删除。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "音频历史删除失败。");
    }
  }

  async function handleDownloadSelectedAudioGroups() {
    if (!selectedAudioHistoryGroups.length) return showError("请先选择要下载的音频历史。");
    if (downloadingAudioSelection) return;
    setDownloadingAudioSelection(true);
    setLoadState("loading");
    setMessage(`正在准备下载 ${selectedAudioHistoryGroups.length} 个音频历史任务...`);
    try {
      const fileCount = await downloadAudioGroups(selectedAudioHistoryGroups);
      if (!fileCount) return showError("所选历史任务暂无可下载音频。");
      setLoadState("ready");
      setMessage(fileCount > 1 ? `已打包 ${fileCount} 条音频，下载已开始。` : "音频下载已开始。");
    } catch (error) {
      showError(error.message || "音频下载失败。");
    } finally {
      setDownloadingAudioSelection(false);
    }
  }

  function toggleSelectAllAudioGroups() {
    if (!audioHistoryGroups.length) return;
    setSelectedAudioGroupIds(allAudioGroupsSelected ? [] : audioHistoryGroups.map((group) => group.id));
  }

  function toggleAudioGroupSelection(groupId) {
    setSelectedAudioGroupIds((current) => (
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]
    ));
  }

  function toggleSelectAllImages() {
    if (!selectableImages.length) return;
    if (allImagesSelected) {
      setSelectedImageIds([]);
      setImageSelectionActive(false);
      return;
    }
    setImageSelectionActive(true);
    setSelectedImageIds(selectableImages.map((image) => image.id));
  }

  function toggleImageSelection(imageId) {
    setImageSelectionActive(true);
    setSelectedImageIds((current) => (
      current.includes(imageId) ? current.filter((id) => id !== imageId) : [...current, imageId]
    ));
  }

  async function handlePackageSelectedImages() {
    const selectedImages = selectableImages.filter((image) => selectedImageSet.has(image.id));
    if (!selectedImages.length) return showError("请先选择要下载的图片。");
    const initialJob = {
      status: "running",
      done: 0,
      total: selectedImages.length,
      progress: 4,
      detail: `准备打包 ${selectedImages.length} 张图片`,
      fileName: "",
      downloadPath: "",
      error: "",
    };
    setImagePackageJob(initialJob);
    setLoadState("loading");
    setMessage(`正在打包 ${selectedImages.length} 张图片...`);
    try {
      const created = await createImageZipJob(toolImageZipPayload(selectedImages));
      let job = created.job;
      if (job) setImagePackageJob(job);
      while (job?.status === "running" || job?.status === "queued") {
        setMessage(job.detail || `正在打包图片 ${job.done || 0}/${job.total || selectedImages.length}...`);
        await browserDelay(1000);
        const result = await getImageZipJob(job.id);
        job = result.job;
        if (job) setImagePackageJob(job);
      }
      if (job?.status !== "done" || !job.downloadPath) throw new Error(job?.error || "图片压缩包创建失败。");
      setImagePackageJob(job);
      setLoadState("ready");
      setMessage("压缩包已打包完成，可点击下载。");
    } catch (error) {
      setImagePackageJob((current) => ({
        ...(current || initialJob),
        status: "error",
        progress: 100,
        detail: error.message || "图片打包失败。",
        error: error.message || "图片打包失败。",
      }));
      showError(error.message || "图片打包失败。");
    }
  }

  async function handleDownloadImagePackage(job = imagePackageJob) {
    if (!job?.downloadPath || downloadingPackage) return;
    if (job.expiresAt && Date.now() > Number(job.expiresAt)) {
      setImagePackageJob({ ...job, status: "expired", detail: "下载链接已过期，请重新打包。" });
      return showError("下载链接已过期，请重新打包。");
    }
    setDownloadingPackage(true);
    setMessage("正在准备下载压缩包...");
    try {
      const result = await downloadImageZipJob(job.downloadPath);
      downloadToolBlob(result.blob, result.fileName || job.fileName || "自由创作图片.zip");
      setLoadState("ready");
      setMessage("压缩包下载已开始。");
    } catch (error) {
      showError(error.message || "压缩包下载失败。");
    } finally {
      setDownloadingPackage(false);
    }
  }

  function createImageTask(prompt, status = "draft") {
    const model = allImageModels.find((item) => item.id === imageConfig.model) || allImageModels[0];
    return {
      id: crypto.randomUUID(),
      type: "image",
      name: uniqueTaskName(imageConfig.projectName || "image", tasks, "image"),
      prompt,
      count: imageConfig.count || 1,
      status,
      resultImages: [],
      createdAt: new Date().toISOString(),
      meta: {
        apiKeyId: activeApiKey?.id || imageConfig.apiKeyId,
        model: imageConfig.model,
        modelName: model.name,
        resolution: imageConfig.resolution,
        format: imageConfig.format,
        ratio: imageConfig.ratio,
        visualStyleId: imageConfig.visualStyleId,
        references: referenceImages.map(({ name, dataUrl, fileUrl, fileKey }) => ({ name, dataUrl, fileUrl: fileUrl || "", fileKey: fileKey || "" })),
      },
    };
  }

  function createVideoTaskDraft(prompt) {
    const model = videoModels.find((item) => item.id === videoConfig.model) || videoModels[0];
    return {
      id: crypto.randomUUID(),
      type: "video",
      name: uniqueTaskName(videoConfig.projectName || "video", tasks, "video"),
      prompt,
      status: "draft",
      videoUrl: "",
      createdAt: new Date().toISOString(),
      meta: {
        apiKeyId: activeApiKey?.id || videoConfig.apiKeyId,
        model: videoConfig.model,
        modelId: model.modelId,
        modelName: model.name,
        provider: model.provider,
        resolution: videoConfig.resolution,
        ratio: videoConfig.ratio,
        duration: videoConfig.duration,
        generationMode: videoConfig.generationMode,
        frames: getVideoFrames(videoConfig.generationMode, model, videoFrames),
      },
    };
  }

  function createAudioTaskDraft(prompt, options = {}) {
    const model = audioModels.find((item) => item.id === audioConfig.model) || audioModels[0];
    const voicePreset = audioVoicePresets.find((item) => item.id === audioConfig.voicePresetId) || audioVoicePresets[0];
    const references = audioConfig.voicePresetId === "clone"
      ? referenceAudios.map(({ name, type, dataUrl, transcript }) => ({ name, type, dataUrl, text: transcript || "" }))
      : [];
    const segmentTotal = Math.max(1, Number(options.segmentTotal || 1));
    const segmentIndex = Math.max(1, Number(options.segmentIndex || 1));
    const baseName = audioConfig.projectName || "audio";
    return {
      id: crypto.randomUUID(),
      type: "audio",
      name: uniqueTaskName(segmentTotal > 1 ? `${baseName}-${String(segmentIndex).padStart(2, "0")}` : baseName, tasks, "audio"),
      prompt,
      status: "queued",
      audioUrl: "",
      createdAt: new Date().toISOString(),
      meta: {
        apiKeyId: activeApiKey?.id || audioConfig.apiKeyId,
        model: audioConfig.model,
        modelId: model.modelId,
        modelName: model.name,
        format: audioConfig.format,
        emotion: audioConfig.emotion,
        bitrate: Number(audioConfig.bitrate || 128),
        speed: Number(audioConfig.speed || 1),
        voicePresetId: audioConfig.voicePresetId,
        voiceName: voicePreset.name,
        referenceId: audioConfig.voicePresetId === "saved" ? audioConfig.referenceId.trim() : "",
        references,
        groupId: options.groupId || crypto.randomUUID(),
        segmentIndex,
        segmentTotal,
        sourceText: options.sourceText || prompt,
        startChar: Number(options.startChar || 0),
        endChar: Number(options.endChar || prompt.length),
      },
    };
  }

  function validateVideoFrames() {
    if (!framesRequired) return true;
    if (supportsVideoAllReference(activeModel) && videoConfig.generationMode === "all-reference") {
      if (!videoFrames.references.length) {
        showError("全能参考模式需要至少上传 1 张参考图。");
        return false;
      }
      return true;
    }
    if (!videoFrames.first) {
      showError("当前模式需要上传首帧或参考图片。");
      return false;
    }
    if (videoConfig.generationMode === "first-last-frame" && !videoFrames.last) {
      showError("首尾帧模式需要同时上传尾帧图片。");
      return false;
    }
    return true;
  }

  function replaceTask(nextTask) {
    setTasks((current) => [nextTask, ...current.filter((item) => item.id !== nextTask.id)]);
  }

  async function persistTask(task) {
    try {
      await saveToolTask({ ...task, storedOnServer: true });
    } catch (error) {
      console.warn("自由创作任务暂未同步到后端。", error);
    }
  }

  function showError(text) {
    setLoadState("error");
    setMessage(text);
  }

  return (
    <div className="create-dashboard-next">
      <section className="create-panel-next create-overview-next">
        <div className="create-heading-next">
          <div>
            <h2>创作工具</h2>
            <p>面向图片、视频、文本和音频生成的批量创作台。API Key 请在 API 页面统一管理。</p>
          </div>
          <div className="create-mode-tabs-next" role="tablist" aria-label="自由创作模式">
            {toolModes.map((item) => (
              <button className={mode === item.id ? "selected" : ""} type="button" onClick={() => setMode(item.id)} key={item.id}>
                {localizedText(item.label, language)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="create-workbench-next">
        {showInitialLoading ? (
          <PageLoading label="正在读取自由创作配置" />
        ) : isPendingMode ? (
          <PendingFeature mode={mode} />
        ) : (
          <>
            <aside className="create-panel-next create-config-next">
              <div className="create-card-head-next">
                <h3>配置</h3>
                <span className={loadState}>{loadStateLabel(loadState)}</span>
              </div>

              <label>
                API 配置
                <select value={activeConfig.apiKeyId || activeApiKey?.id || ""} onChange={(event) => updateConfig(mode, { apiKeyId: event.target.value })}>
                  <option value="">{language === "en" ? `Select ${activeModeApiLabel} API` : `选择${activeModeApiLabel} API`}</option>
                  {modeApiKeys.map((key) => (
                    <option value={key.id} key={key.id}>{formatApiChannelName(key.channel)}</option>
                  ))}
                </select>
              </label>

              <label>
                模型
                <select value={activeModel?.id || ""} onChange={(event) => updateConfig(mode, { model: event.target.value })}>
                  {availableModels.map((model) => (
                    <option value={model.id} key={model.id}>{model.name}</option>
                  ))}
                </select>
              </label>

              {mode === "image" ? (
                <>
                  <ConfigButtons
                    label="分辨率"
                    values={activeModel?.resolutions || []}
                    value={imageConfig.resolution}
                    onChange={(value) => updateConfig("image", { resolution: value })}
                    compact
                  />
                  <ConfigButtons label="每场景张数" values={[1, 2, 3, 4, 5]} value={imageConfig.count} onChange={(value) => updateConfig("image", { count: Number(value) })} compact />
                </>
              ) : null}

              {mode === "video" ? (
                <ConfigButtons
                  label="分辨率"
                  values={activeModel?.resolutions || []}
                  value={videoConfig.resolution}
                  onChange={(value) => updateConfig("video", { resolution: value })}
                  formatter={videoResolutionLabel}
                />
              ) : null}

              {mode === "image" && activeModel?.formats ? (
                <ConfigButtons label="图片格式" values={activeModel.formats} value={imageConfig.format} onChange={(value) => updateConfig("image", { format: value })} />
              ) : null}

              {mode === "audio" ? (
                <>
                  <ConfigButtons label="输出格式" values={activeModel?.formats || []} value={audioConfig.format} onChange={(value) => updateConfig("audio", { format: value, bitrate: value === "opus" ? 64 : 128 })} />
                  <label>
                    语速
                    <input type="range" min="0.5" max="2" step="0.1" value={audioConfig.speed} onChange={(event) => updateConfig("audio", { speed: Number(event.target.value) })} />
                    <span className="field-value-next">{Number(audioConfig.speed || 1).toFixed(1)}x</span>
                  </label>
                  <label>
                    情绪
                    <select value={audioConfig.emotion} onChange={(event) => updateConfig("audio", { emotion: event.target.value })}>
                      {(activeModel?.emotions || []).map((emotion) => (
                        <option value={emotion.value} key={emotion.value}>{emotion.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    音色模式
                    <select value={audioConfig.voicePresetId} onChange={(event) => updateConfig("audio", { voicePresetId: event.target.value })}>
                      {audioVoicePresets.map((voice) => (
                        <option value={voice.id} key={voice.id}>{voice.name}</option>
                      ))}
                    </select>
                  </label>
                  {audioConfig.voicePresetId === "saved" ? (
                    <SavedAudioVoicePicker
                      value={audioConfig.referenceId}
                      onChange={(referenceId) => updateConfig("audio", { referenceId })}
                      idLabel="音频服务 音色 ID"
                    />
                  ) : null}
                  <label>
                    项目名称
                    <input value={audioConfig.projectName} onChange={(event) => updateConfig("audio", { projectName: event.target.value })} placeholder="默认 audio" />
                  </label>
                </>
              ) : null}

              {mode === "image" || mode === "video" ? (
                <label>
                  画面尺寸
                  <select value={activeConfig.ratio} onChange={(event) => updateConfig(mode, { ratio: event.target.value })}>
                    {(activeModel?.ratios || []).map((ratio) => (
                      <option value={ratio.value} key={ratio.value}>{ratio.label} · {ratio.value}</option>
                    ))}
                  </select>
                </label>
              ) : null}

              {mode === "image" ? (
            <>
              <label>
                项目名称
                <input value={imageConfig.projectName} onChange={(event) => updateConfig("image", { projectName: event.target.value })} placeholder="默认 image" />
              </label>
              <label>
                风格预设
                <select value={imageConfig.visualStyleId} onChange={(event) => updateConfig("image", { visualStyleId: event.target.value })}>
                  {visualStyles.map((style) => (
                    <option value={style.id} key={style.id}>{style.name}</option>
                  ))}
                </select>
              </label>
            </>
              ) : null}

              {mode === "video" ? (
            <>
              <ConfigButtons label="时长" values={activeModel?.durations || []} value={videoConfig.duration} onChange={(value) => updateConfig("video", { duration: value })} />
              <ConfigButtons label="生视频模式" values={activeModel?.modes || []} value={videoConfig.generationMode} onChange={(value) => updateConfig("video", { generationMode: value })} />
              <label>
                项目名称
                <input value={videoConfig.projectName} onChange={(event) => updateConfig("video", { projectName: event.target.value })} placeholder="默认 video" />
              </label>
            </>
              ) : null}
            </aside>

            <main className="create-main-next">
              {mode === "image" ? (
                <ImageComposer
                  imagePrompt={imagePrompt}
                  setImagePrompt={setImagePrompt}
                  batchPrompt={batchPrompt}
                  setBatchPrompt={setBatchPrompt}
                  referenceImages={referenceImages}
                  setReferenceImages={setReferenceImages}
                  imageLibraries={imageLibraries}
                  onReferenceFiles={handleReferenceFiles}
                  onOpenGalleryImport={openImageGalleryImport}
                  onPreviewImage={setPreviewImage}
                  onGenerate={handleGenerateImage}
                  onGenerateBatch={handleGenerateBatchImages}
                  disabled={Boolean(busyTaskId)}
                />
              ) : null}

              {mode === "video" ? (
                <VideoComposer
                  videoPrompt={videoPrompt}
                  setVideoPrompt={setVideoPrompt}
                  videoBatchPrompt={videoBatchPrompt}
                  setVideoBatchPrompt={setVideoBatchPrompt}
                  videoConfig={videoConfig}
                  activeModel={activeModel}
                  framesRequired={framesRequired}
                  videoFrames={videoFrames}
                  setVideoFrames={setVideoFrames}
                  imageLibraries={imageLibraries}
                  onFrameFiles={handleVideoFrameFiles}
                  onOpenGalleryImport={openVideoGalleryImport}
                  onPreviewImage={setPreviewImage}
                  onGenerate={handleGenerateVideo}
                  onGenerateBatch={handleGenerateBatchVideos}
                  disabled={Boolean(busyTaskId)}
                />
              ) : null}

              {mode === "audio" ? (
                <AudioComposer
                  audioText={audioText}
                  setAudioText={setAudioText}
                  audioConfig={audioConfig}
                  referenceAudios={referenceAudios}
                  setReferenceAudios={setReferenceAudios}
                  latestTasks={latestAudioGroupTasks}
                  historyGroups={audioHistoryGroups}
                  selectedGroupId={selectedAudioGroup?.id || ""}
                  selectedGroupIds={selectedAudioGroupIds}
                  allGroupsSelected={allAudioGroupsSelected}
                  downloadingSelection={downloadingAudioSelection}
                  onSelectHistory={setSelectedAudioGroupId}
                  onToggleHistorySelection={toggleAudioGroupSelection}
                  onToggleAllHistory={toggleSelectAllAudioGroups}
                  onDownloadSelectedHistory={handleDownloadSelectedAudioGroups}
                  onDeleteSelectedHistory={requestDeleteSelectedAudioGroups}
                  onDeleteHistory={requestDeleteAudioGroup}
                  onClearHistory={requestClearAudioHistory}
                  onReferenceFiles={handleAudioReferenceFiles}
                  onGenerate={handleGenerateAudio}
                  onRefresh={reloadTasks}
                  disabled={false}
                />
              ) : null}

              {mode !== "audio" ? (
              <section className="create-panel-next create-results-next">
                <div className="create-card-head-next">
                  <div>
                    <h3>{resultsTitle(mode)}</h3>
                    <p>{resultsDescription(mode)}</p>
                  </div>
                  <div className="create-result-actions-next">
                    {mode === "image" && selectableImages.length ? (
                      <>
                        <button className="secondary-action compact" type="button" onClick={toggleSelectAllImages}>
                          {allImagesSelected ? "取消全选" : "全选"}
                        </button>
                        {imageSelectionActive ? (
                          <button className="primary-action compact" type="button" disabled={!selectedImageIds.length || imagePackageJob?.status === "running" || imagePackageJob?.status === "queued"} onClick={handlePackageSelectedImages}>
                            {imagePackageJob?.status === "running" || imagePackageJob?.status === "queued" ? "打包中..." : `下载${selectedImageIds.length ? ` ${selectedImageIds.length}` : ""}`}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    <button className="secondary-action compact" type="button" onClick={reloadTasks}>刷新</button>
                  </div>
                </div>
                {mode === "image" && imagePackageJob ? (
                  <ToolImagePackageStatus job={imagePackageJob} downloadingPackage={downloadingPackage} onDownload={() => handleDownloadImagePackage(imagePackageJob)} />
                ) : null}
                <div className="create-task-list-next">
                  {modeTasks.length ? (
                    modeTasks.map((task) => (
                      <TaskCard
                        task={task}
                        busy={busyTaskId === task.id}
                        selectionActive={imageSelectionActive}
                        selectedImageSet={selectedImageSet}
                        onDelete={() => requestDeleteTask(task)}
                        onRegenerate={() => requestRegenerate(task)}
                        onQueryVideo={() => handleQueryVideo(task)}
                        onPreviewImage={setPreviewImage}
                        onToggleImageSelection={toggleImageSelection}
                        key={task.id}
                      />
                    ))
                  ) : (
                    <article className="create-empty-next">
                      <strong>暂无任务</strong>
                      <span>{emptyTaskHint(mode)}</span>
                    </article>
                  )}
                </div>
              </section>
              ) : null}
            </main>
          </>
        )}
      </div>

      <p className={`create-sync-message-next ${loadState}`}>{message}</p>
      {galleryImportContext ? (
        <GalleryImportDialog
          libraries={imageLibraries}
          title={galleryImportContext.title}
          description={galleryImportContext.description}
          maxCount={galleryImportContext.maxCount}
          selectedCount={galleryImportContext.selectedCount}
          multiple={galleryImportContext.multiple}
          onImport={handleImportGalleryImages}
          onClose={() => setGalleryImportContext(null)}
        />
      ) : null}
      {previewImage ? <ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} onDownload={handleDownloadPreviewImage} /> : null}
      {confirmDialog ? <ConfirmDialog dialog={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

function ImageComposer({ imagePrompt, setImagePrompt, batchPrompt, setBatchPrompt, referenceImages, setReferenceImages, imageLibraries, onReferenceFiles, onOpenGalleryImport, onPreviewImage, onGenerate, onGenerateBatch, disabled }) {
  const libraryImageCount = imageLibraries.reduce((sum, library) => sum + (library.images?.length || 0), 0);
  return (
    <>
      <section className="create-panel-next reference-panel-next">
        <div className="create-card-head-next">
          <div>
            <h3>参考图</h3>
            <p>最多 20 张，随当前图片任务一起提交。</p>
          </div>
          <div className="reference-actions-next">
            <button className="secondary-action compact" type="button" onClick={onOpenGalleryImport}>
              从图库导入
            </button>
            <span className="soft-counter-next">{referenceImages.length}/20</span>
          </div>
        </div>
        {!libraryImageCount ? <p className="reference-gallery-hint-next">图片库暂无图片时，可先本地上传参考图。</p> : null}
        <label className="create-upload-next">
          <input type="file" accept="image/*" multiple onChange={(event) => onReferenceFiles(event.target.files)} />
          <span>上传多张参考图</span>
          <small>JPG / PNG / WEBP</small>
        </label>
        <ImageThumbs images={referenceImages} onRemove={(id) => setReferenceImages((current) => current.filter((image) => image.id !== id))} onPreview={onPreviewImage} />
      </section>

      <div className="create-input-grid-next">
        <section className="create-panel-next create-input-card-next">
          <div className="create-card-head-next">
            <div>
              <h3>提示词输入</h3>
              <p>用于单个任务生图。</p>
            </div>
            <button className="secondary-action compact" type="button" onClick={() => setImagePrompt("")}>清空</button>
          </div>
          <textarea value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} rows={9} placeholder="描述你想生成的图片，例如：一位穿银色夹克的未来城市旅行者，霓虹雨夜，真实摄影风，电影级光影" />
          <div className="create-action-bar-next single">
            <button className="primary-action compact" type="button" disabled={disabled} onClick={onGenerate}>生成图片</button>
          </div>
        </section>

        <section className="create-panel-next create-input-card-next">
          <div className="create-card-head-next">
            <div>
              <h3>批量导入</h3>
              <p>支持 JSON 数组或逐行文本。</p>
            </div>
            <button className="secondary-action compact" type="button" onClick={() => setBatchPrompt("")}>清空</button>
          </div>
          <textarea value={batchPrompt} onChange={(event) => setBatchPrompt(event.target.value)} rows={9} placeholder='[{"prompt":"雨夜城市"},{"prompt":"赛博产品海报"}]' />
          <div className="create-action-bar-next">
            <FileImportButton onText={setBatchPrompt} />
            <button className="primary-action compact" type="button" disabled={disabled} onClick={onGenerateBatch}>批量生产</button>
          </div>
        </section>
      </div>
    </>
  );
}

function VideoComposer({ videoPrompt, setVideoPrompt, videoBatchPrompt, setVideoBatchPrompt, videoConfig, activeModel, framesRequired, videoFrames, setVideoFrames, imageLibraries, onFrameFiles, onOpenGalleryImport, onPreviewImage, onGenerate, onGenerateBatch, disabled }) {
  const isSingleReference = videoConfig.generationMode === "image-prompt";
  const showAllReference = supportsVideoAllReference(activeModel) && videoConfig.generationMode === "all-reference";
  const isTextMode = !framesRequired;
  const showFirstLast = framesRequired && !showAllReference;
  const galleryImportKind = showAllReference ? "references" : videoConfig.generationMode === "first-last-frame" && !isSingleReference ? "first-last" : "first";
  const libraryImageCount = imageLibraries.reduce((sum, library) => sum + (library.images?.length || 0), 0);
  return (
    <>
      <section className="create-panel-next reference-panel-next">
        <div className="create-card-head-next">
          <div>
            <h3>{showAllReference || isSingleReference || isTextMode ? "参考图" : "首尾帧"}</h3>
            <p>{showAllReference ? "通用参考支持最多 9 张参考图。" : isSingleReference ? "当前模式支持 1 张参考图。" : isTextMode ? "文生视频模式无需上传参考图。" : "首帧模式上传 1 张即可，首尾帧模式可上传首帧和尾帧。"}</p>
          </div>
          <div className="reference-actions-next">
            {!isTextMode ? (
              <button className="secondary-action compact" type="button" onClick={() => onOpenGalleryImport(galleryImportKind)}>
                从图库导入
              </button>
            ) : null}
            {showAllReference ? <span className="soft-counter-next">{videoFrames.references.length}/9</span> : null}
          </div>
        </div>
        {!libraryImageCount && !isTextMode ? <p className="reference-gallery-hint-next">图片库暂无图片时，可先本地上传参考图。</p> : null}
        {isTextMode ? (
          <div className="video-reference-empty-next">
            <strong>无需参考图</strong>
            <span>当前模式会直接根据视频提示词生成。</span>
          </div>
        ) : null}
        {showAllReference ? (
          <>
            <label className="create-upload-next compact">
              <input type="file" accept="image/*" multiple onChange={(event) => onFrameFiles("references", event.target.files)} />
              <span>上传参考图</span>
              <small>最多 9 张</small>
            </label>
            <ImageThumbs images={videoFrames.references} onRemove={(id) => setVideoFrames((current) => ({ ...current, references: current.references.filter((image) => image.id !== id) }))} onPreview={onPreviewImage} />
          </>
        ) : null}
        {showFirstLast ? (
          <div className={`video-frame-grid-next ${isSingleReference || videoConfig.generationMode !== "first-last-frame" ? "single" : ""}`}>
            <FrameUpload label={isSingleReference ? "上传垫图" : "上传首帧"} image={videoFrames.first} onFiles={(files) => onFrameFiles("first", files)} onRemove={() => setVideoFrames((current) => ({ ...current, first: null }))} onPreview={onPreviewImage} />
            {!isSingleReference && videoConfig.generationMode === "first-last-frame" ? (
              <FrameUpload label="上传尾帧" image={videoFrames.last} onFiles={(files) => onFrameFiles("last", files)} onRemove={() => setVideoFrames((current) => ({ ...current, last: null }))} onPreview={onPreviewImage} />
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="create-input-grid-next">
        <section className="create-panel-next create-input-card-next">
          <div className="create-card-head-next">
            <div>
              <h3>视频提示词</h3>
              <p>用于单个视频任务。</p>
            </div>
            <button className="secondary-action compact" type="button" onClick={() => setVideoPrompt("")}>清空</button>
          </div>
          <textarea value={videoPrompt} onChange={(event) => setVideoPrompt(event.target.value)} rows={9} placeholder="描述你想生成的视频，例如：黄昏海边，一位旅行者走向发光的城市天际线，电影镜头，缓慢推进" />
          <div className="create-action-bar-next single">
            <button className="primary-action compact" type="button" disabled={disabled} onClick={onGenerate}>生成视频</button>
          </div>
        </section>

        <section className="create-panel-next create-input-card-next">
          <div className="create-card-head-next">
            <div>
              <h3>批量导入</h3>
              <p>逐行文本或 JSON 数组均可。</p>
            </div>
            <button className="secondary-action compact" type="button" onClick={() => setVideoBatchPrompt("")}>清空</button>
          </div>
          <textarea value={videoBatchPrompt} onChange={(event) => setVideoBatchPrompt(event.target.value)} rows={9} placeholder='[{"prompt":"未来城市延时摄影"},{"prompt":"雪山公路航拍"}]' />
          <div className="create-action-bar-next">
            <FileImportButton onText={setVideoBatchPrompt} />
            <button className="primary-action compact" type="button" disabled={disabled} onClick={onGenerateBatch}>批量生成</button>
          </div>
        </section>
      </div>
    </>
  );
}

function AudioHistoryPanel({
  groups,
  selectedGroupId,
  selectedGroupIds = [],
  allGroupsSelected = false,
  downloadingSelection = false,
  onSelect,
  onToggleSelected,
  onToggleAll,
  onDownloadSelected,
  onDeleteSelected,
  onDelete,
  onClear,
}) {
  const selectedCount = selectedGroupIds.length;
  return (
    <section className="create-panel-next audio-history-panel-next">
      <div className="create-card-head-next">
        <div>
          <h3>历史任务</h3>
          <p>以往生成过的音频记录，可切换查看、选择下载或删除。</p>
        </div>
        {groups.length ? (
          <div className="audio-history-actions-next">
            <button className="secondary-action compact" type="button" onClick={onToggleAll}>
              {allGroupsSelected ? "取消全选" : "全选"}
            </button>
            {selectedCount ? (
              <>
                <button className="primary-action compact" type="button" disabled={downloadingSelection} onClick={onDownloadSelected}>
                  {downloadingSelection ? "下载中..." : `下载 ${selectedCount}`}
                </button>
                <button className="secondary-action compact danger" type="button" onClick={onDeleteSelected}>删除 {selectedCount}</button>
              </>
            ) : null}
            <button className="secondary-action compact" type="button" onClick={onClear}>清空全部</button>
          </div>
        ) : null}
      </div>
      {groups.length ? (
        <div className="audio-history-list-next">
          {groups.map((group) => {
            const picked = selectedGroupIds.includes(group.id);
            return (
              <article className={`audio-history-item-next ${group.id === selectedGroupId ? "selected" : ""} ${picked ? "picked" : ""}`} key={group.id}>
                <label className="audio-history-select-next" onClick={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={picked} onChange={() => onToggleSelected(group.id)} />
                  <span>{picked ? "已选" : "选择"}</span>
                </label>
                <button className="audio-history-open-next" type="button" onClick={() => onSelect(group.id)}>
                  <span>{group.name}</span>
                  <small>{group.doneCount}/{group.total} 段 · {audioGroupStatusLabel(group)}</small>
                </button>
                <button className="audio-history-delete-next" type="button" onClick={() => onDelete(group)}>删除</button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="audio-history-empty-next">
          <strong>暂无历史任务</strong>
          <span>完成音频生成后，记录会显示在这里。</span>
        </div>
      )}
    </section>
  );
}

function AudioComposer({
  audioText,
  setAudioText,
  audioConfig,
  referenceAudios,
  setReferenceAudios,
  latestTasks,
  historyGroups,
  selectedGroupId,
  selectedGroupIds,
  allGroupsSelected,
  downloadingSelection,
  onSelectHistory,
  onToggleHistorySelection,
  onToggleAllHistory,
  onDownloadSelectedHistory,
  onDeleteSelectedHistory,
  onDeleteHistory,
  onClearHistory,
  onReferenceFiles,
  onGenerate,
  onRefresh,
  disabled,
}) {
  const segmentCount = splitAudioText(audioText).length;
  const textCountLabel = audioText.trim()
    ? segmentCount > 1 ? `${audioText.trim().length} 字 · 预计拆为 ${segmentCount} 段` : `${audioText.trim().length} 字 · 单段生成`
    : "0 字";
  return (
    <>
      <section className="create-panel-next reference-panel-next audio-reference-panel-next">
        <div className="create-card-head-next">
          <div>
            <h3>参考音频</h3>
            <p>建议上传 10-30 秒清晰单人声，尽量无背景音；超过 30 秒可能影响克隆稳定性。</p>
          </div>
          <span className="soft-counter-next">{referenceAudios.length}/5</span>
        </div>
        <label className="create-upload-next">
          <input type="file" accept="audio/*,.mp3,.wav,.m4a,.opus" multiple onChange={(event) => onReferenceFiles(event.target.files)} />
          <span>上传参考音频</span>
          <small>MP3 / WAV / M4A / OPUS，建议 10-30 秒</small>
        </label>
        <AudioReferenceList
          audios={referenceAudios}
          onUpdate={(id, patch) => setReferenceAudios((current) => current.map((audio) => (audio.id === id ? { ...audio, ...patch } : audio)))}
          onRemove={(id) => setReferenceAudios((current) => current.filter((audio) => audio.id !== id))}
        />
      </section>

      <div className="create-input-grid-next">
        <section className="create-panel-next create-input-card-next audio-text-card-next">
          <div className="create-card-head-next">
            <div>
              <h3>配音文本</h3>
              <p>输入旁白、口播或角色台词。</p>
            </div>
            <button className="secondary-action compact" type="button" onClick={() => setAudioText("")}>清空</button>
          </div>
          <textarea value={audioText} onChange={(event) => setAudioText(event.target.value)} rows={9} placeholder="例如：欢迎来到 Workflow Studio，这是一段用于视频开场的自然旁白。" />
          <div className="audio-text-meta-next">
            <span>{textCountLabel}</span>
            <span>长文本会自动按句子拆段顺序生成。</span>
          </div>
          <div className="create-action-bar-next">
            <button className="secondary-action compact" type="button" onClick={() => saveAudioDraft(audioText)}>保存草稿</button>
            <button className="primary-action compact" type="button" disabled={disabled} onClick={onGenerate}>生成音频</button>
          </div>
        </section>

        <section className="create-panel-next audio-preview-card-next">
          <div className="create-card-head-next">
            <div>
              <h3>生成结果</h3>
              <p>预览音频并导出时间戳。</p>
            </div>
            <div className="audio-result-head-actions-next">
              <span className={`audio-status-pill-next ${audioGroupPreviewStatus(latestTasks)}`}>{audioGroupPreviewStatusLabel(latestTasks)}</span>
              <button className="secondary-action compact" type="button" onClick={onRefresh}>刷新</button>
            </div>
          </div>
          <AudioPreviewResult tasks={latestTasks} />
        </section>
        <AudioHistoryPanel
          groups={historyGroups}
          selectedGroupId={selectedGroupId}
          selectedGroupIds={selectedGroupIds}
          allGroupsSelected={allGroupsSelected}
          downloadingSelection={downloadingSelection}
          onSelect={onSelectHistory}
          onToggleSelected={onToggleHistorySelection}
          onToggleAll={onToggleAllHistory}
          onDownloadSelected={onDownloadSelectedHistory}
          onDeleteSelected={onDeleteSelectedHistory}
          onDelete={onDeleteHistory}
          onClear={onClearHistory}
        />
      </div>
    </>
  );
}

function AudioPreviewResult({ tasks = [] }) {
  if (!tasks.length) {
    return (
      <div className="audio-preview-empty-next">
        <strong>待生成</strong>
        <span>输入配音文本后，音频会在这里预览。</span>
      </div>
    );
  }
  const orderedTasks = orderAudioTasks(tasks);
  const doneTasks = orderedTasks.filter((task) => resolveFlowStudioFileUrl(task.audioUrl || ""));
  const activeTask = doneTasks[0] || orderedTasks[0];
  const audioUrl = resolveFlowStudioFileUrl(activeTask.audioUrl || "");
  const status = audioGroupPreviewStatus(orderedTasks);
  const isDone = doneTasks.length > 0;
  const isError = status === "error";
  return (
    <div className={`audio-preview-result-next ${status}`}>
      <div className="audio-waveform-next" aria-hidden="true">
        {Array.from({ length: 56 }).map((_, index) => (
          <span style={{ height: `${18 + ((index * 17) % 38)}px` }} key={index} />
        ))}
      </div>
      {isDone ? (
        <>
          <audio src={audioUrl} controls />
          {orderedTasks.length > 1 ? (
            <div className="audio-segment-list-next">
              {orderedTasks.map((task) => {
                const segmentUrl = resolveFlowStudioFileUrl(task.audioUrl || "");
                return (
                  <a className={segmentUrl ? "ready" : task.status} href={segmentUrl || undefined} target="_blank" download={segmentUrl ? `${task.name}.${task.meta?.format || "mp3"}` : undefined} key={task.id}>
                    <span>{String(task.meta?.segmentIndex || 1).padStart(2, "0")}</span>
                    <strong>{taskStatusLabel(task)}</strong>
                  </a>
                );
              })}
            </div>
          ) : null}
          <div className="audio-preview-actions-next">
            <button className="primary-action compact" type="button" onClick={() => downloadAudioGroup(orderedTasks)}>下载音频</button>
            <button className="secondary-action compact" type="button" onClick={() => exportAudioTimestamps(orderedTasks)}>导出时间戳</button>
          </div>
        </>
      ) : (
        <div className={`audio-preview-status-next ${isError ? "error" : ""}`}>
          <strong>{isError ? "生成失败" : status === "running" ? "音频生成中" : "等待生成"}</strong>
          <span>{orderedTasks.find((task) => task.error)?.error || "生成完成后会显示播放器。"}</span>
        </div>
      )}
    </div>
  );
}

function AudioReferenceList({ audios, onUpdate, onRemove }) {
  if (!audios.length) return null;
  return (
    <div className="audio-reference-list-next">
      {audios.map((audio) => (
        <article className="audio-reference-item-next" key={audio.id}>
          <div>
            <strong>{audio.name || "参考音频"}</strong>
            <button type="button" onClick={() => onRemove(audio.id)}>删除</button>
          </div>
          <audio src={audio.dataUrl} controls />
          <input value={audio.transcript || ""} onChange={(event) => onUpdate(audio.id, { transcript: event.target.value })} placeholder="参考音频对应文字，可选但建议填写" />
        </article>
      ))}
    </div>
  );
}

function PendingFeature({ mode }) {
  const title = mode === "text" ? "文本生成功能待开发" : "音频生成功能待开发";
  return (
    <section className="create-panel-next create-pending-next">
      <strong>{title}</strong>
      <span>入口已预留，具体生成配置和任务流程后续接入。</span>
    </section>
  );
}

function GalleryImportDialog({ libraries, title = "从图库导入参考图", description = "选择图片库中的图片作为参考图。", maxCount = 20, selectedCount = 0, multiple = true, onImport, onClose }) {
  const images = useMemo(() => flattenGalleryImages(libraries), [libraries]);
  const slots = Math.max(0, maxCount - selectedCount);
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedImages = images.filter((image) => selectedIds.includes(image.id));

  function toggleImage(imageId) {
    setSelectedIds((current) => {
      if (current.includes(imageId)) return current.filter((id) => id !== imageId);
      if (!multiple) return [imageId];
      if (current.length >= slots) return current;
      return [...current, imageId];
    });
  }

  return (
    <div className="tool-dialog-backdrop-next" role="presentation" onClick={onClose}>
      <section className="tool-gallery-dialog-next" role="dialog" aria-modal="true" aria-label="从图库导入参考图" onClick={(event) => event.stopPropagation()}>
        <div className="tool-dialog-head-next">
          <div>
            <strong>{title}</strong>
            <p>{description}</p>
          </div>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
        {images.length ? (
          <div className="tool-gallery-grid-next">
            {images.map((image) => {
              const checked = selectedIds.includes(image.id);
              const disabled = !checked && selectedIds.length >= slots;
              return (
                <label className={`tool-gallery-item-next ${checked ? "selected" : ""} ${disabled ? "disabled" : ""}`} key={image.id}>
                  <input type={multiple ? "checkbox" : "radio"} name="toolGalleryImportImage" checked={checked} disabled={disabled} onChange={() => toggleImage(image.id)} />
                  <img src={image.fileUrl || image.dataUrl} alt={image.name} />
                  <span>{image.libraryName} · {image.name}</span>
                </label>
              );
            })}
          </div>
        ) : (
          <div className="tool-gallery-empty-next">
            <strong>图片库暂无图片</strong>
            <span>请先到创意资产的图片库中创建图库并上传图片。</span>
          </div>
        )}
        <div className="tool-dialog-actions-next">
          <span className="tool-gallery-count-next">可导入 {slots} 张，已选 {selectedIds.length} 张</span>
          <button className="secondary-action compact" type="button" onClick={onClose}>取消</button>
          <button className="primary-action compact" type="button" disabled={!selectedImages.length} onClick={() => onImport(selectedImages)}>
            导入选中图片
          </button>
        </div>
      </section>
    </div>
  );
}

function ImagePreviewDialog({ image, onClose, onDownload }) {
  const [downloadState, setDownloadState] = useState({ busy: false, error: "" });

  async function handleDownloadClick() {
    if (downloadState.busy) return;
    setDownloadState({ busy: true, error: "" });
    try {
      await onDownload?.(image);
      setDownloadState({ busy: false, error: "" });
    } catch (error) {
      setDownloadState({ busy: false, error: error.message || "图片下载失败。" });
    }
  }

  return (
    <div className="tool-dialog-backdrop-next" role="presentation" onClick={onClose}>
      <section className="tool-image-preview-dialog-next" role="dialog" aria-modal="true" aria-label={image.title || "图片预览"} onClick={(event) => event.stopPropagation()}>
        <div className="tool-dialog-head-next">
          <strong>{image.title || "图片预览"}</strong>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
        <img src={image.url} alt={image.title || "生成图片预览"} />
        {downloadState.error ? <p className="tool-image-preview-error-next">{downloadState.error}</p> : null}
        <button className="primary-action compact" type="button" disabled={downloadState.busy} onClick={handleDownloadClick}>
          {downloadState.busy ? "下载中..." : "下载图片"}
        </button>
      </section>
    </div>
  );
}

function ConfirmDialog({ dialog, onClose }) {
  return (
    <div className="tool-dialog-backdrop-next" role="presentation" onClick={onClose}>
      <section className={`tool-confirm-dialog-next ${dialog.tone || ""}`} role="dialog" aria-modal="true" aria-label={dialog.title} onClick={(event) => event.stopPropagation()}>
        <div>
          <strong>{dialog.title}</strong>
          <p>{dialog.message}</p>
        </div>
        <div className="tool-dialog-actions-next">
          <button className="secondary-action compact" type="button" onClick={onClose}>取消</button>
          <button className={`primary-action compact ${dialog.tone === "danger" ? "danger" : ""}`} type="button" onClick={dialog.onConfirm}>{dialog.confirmText || "确认"}</button>
        </div>
      </section>
    </div>
  );
}

function ToolImagePackageStatus({ job, downloadingPackage, onDownload }) {
  const status = job.status || "running";
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const isDone = status === "done" && job.downloadPath;
  const isError = status === "error" || status === "expired";
  return (
    <div className={`tool-image-package-card-next ${isDone ? "done" : ""} ${isError ? "error" : ""}`}>
      <div className="tool-image-package-copy-next">
        <strong>{isDone ? "压缩包已准备好" : isError ? "压缩包不可用" : "正在打包图片"}</strong>
        <span>{job.detail || (isDone ? "点击下载按钮后开始保存到本地。" : `已处理 ${job.done || 0}/${job.total || 0} 张图片`)}</span>
        {isDone && job.expiresAt ? <span>下载链接 {toolPackageExpiresText(job.expiresAt)}，过期后需要重新打包。</span> : null}
      </div>
      <div className="tool-image-package-progress-next" aria-label={`打包进度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="tool-image-package-actions-next">
        {job.fileName ? <code>{job.fileName}</code> : <code>准备生成压缩包...</code>}
        {isDone ? (
          <button className="primary-action compact" type="button" disabled={downloadingPackage} onClick={onDownload}>
            {downloadingPackage ? "准备下载..." : "下载 ZIP"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TaskCard({ task, busy, selectionActive = false, selectedImageSet = new Set(), onDelete, onRegenerate, onQueryVideo, onPreviewImage, onToggleImageSelection }) {
  if (task.type === "audio") {
    const audioUrl = resolveFlowStudioFileUrl(task.audioUrl || "");
    return (
      <article className={`create-task-card-next audio ${audioUrl ? "has-audio" : ""}`}>
        <TaskHead task={task} busy={busy} onDelete={onDelete} onRegenerate={onRegenerate} />
        <textarea value={task.prompt || ""} readOnly rows={4} />
        <div className={`audio-result-box-next ${task.status}`}>
          {audioUrl ? (
            <>
              <audio src={audioUrl} controls />
              <a className="secondary-action compact" href={audioUrl} target="_blank" download={`${task.name}.${task.meta?.format || "mp3"}`}>下载音频</a>
            </>
          ) : (
            <>
              <strong>{task.status === "error" ? "生成失败" : task.status === "running" ? "音频生成中" : "待生成音频"}</strong>
              <small>{task.error || "提交后音频会显示在这里。"}</small>
            </>
          )}
        </div>
        <div className="result-strip-next"><span>{taskStatusLabel(task)}</span><span>{task.meta?.format?.toUpperCase?.() || "MP3"}</span></div>
      </article>
    );
  }

  if (task.type === "video") {
    return (
      <article className={`create-task-card-next video ${task.videoUrl ? "has-video" : ""}`}>
        <TaskHead task={task} busy={busy} onDelete={onDelete} onRegenerate={onRegenerate} />
        <textarea value={task.prompt || ""} readOnly rows={4} />
        <div className={`video-result-box-next ${task.status}`}>
          {task.videoUrl ? (
            <>
              <video src={resolveFlowStudioFileUrl(task.videoUrl)} controls playsInline />
              <a className="secondary-action compact" href={resolveFlowStudioFileUrl(task.videoUrl)} target="_blank" download={`${task.name}.mp4`}>下载视频</a>
            </>
          ) : (
            <>
              <strong>{task.status === "error" ? "生成失败" : task.status === "running" ? "视频生成中" : "待生成视频"}</strong>
              <small>{task.error || (task.meta?.taskId ? `任务编号：${task.meta.taskId}` : "提交后结果会显示在这里。")}</small>
              {task.meta?.taskId ? <button className="secondary-action compact" type="button" disabled={busy} onClick={onQueryVideo}>查询结果</button> : null}
            </>
          )}
        </div>
        <div className="result-strip-next"><span>{taskStatusLabel(task)}</span><span>{task.meta?.modelName || "视频模型"}</span></div>
      </article>
    );
  }

  const images = Array.isArray(task.resultImages) ? task.resultImages : [];
  const tileCount = Math.max(task.count || 1, images.length || 0);
  return (
    <article className="create-task-card-next">
      <TaskHead task={task} busy={busy} onDelete={onDelete} onRegenerate={onRegenerate} />
      <textarea value={task.prompt || ""} readOnly rows={4} />
      <div className="image-result-grid-next">
        {task.error ? (
          <div className="image-result-tile-next error"><span>生成失败</span><small>{task.error}</small></div>
        ) : Array.from({ length: tileCount }).map((_, index) => {
          const image = images[index];
          const imageUrl = resolveFlowStudioFileUrl(image);
          const selectionId = toolImageSelectionId(task.id, index);
          const selected = selectedImageSet.has(selectionId);
          return (
            <div className={`image-result-tile-next ${image ? "ready" : task.status}`} key={`${task.id}-${index}`}>
              {image ? (
                <>
                  <button className="image-preview-button-next" type="button" onClick={() => onPreviewImage?.({ url: imageUrl, title: `${task.name} ${index + 1}` })}>
                    <img src={imageUrl} alt={`${task.name} ${index + 1}`} />
                  </button>
                  {selectionActive ? (
                    <label className={`tool-image-select-next ${selected ? "selected" : ""}`}>
                      <input type="checkbox" checked={selected} onChange={() => onToggleImageSelection?.(selectionId)} />
                      <span>{selected ? "已选" : "选择"}</span>
                    </label>
                  ) : null}
                </>
              ) : (
                <span>{task.status === "running" ? "生成中" : task.status === "queued" ? "排队中" : "待生成"}</span>
              )}
              <small>{String(index + 1).padStart(2, "0")}</small>
            </div>
          );
        })}
      </div>
      <div className="result-strip-next"><span>{taskStatusLabel(task)}</span><span>{task.count || 1} 张</span></div>
    </article>
  );
}

function TaskHead({ task, busy, onDelete, onRegenerate }) {
  const metaText = task.type === "audio"
    ? `${task.meta?.modelName || "音频模型"} · ${(task.meta?.format || "mp3").toUpperCase()} · ${task.meta?.voiceName || "默认音色"}`
    : `${task.meta?.modelName || "生成模型"} · ${task.meta?.resolution || "默认"} · ${task.meta?.ratio || "9:16"}`;
  return (
    <div className="create-card-head-next task">
      <div>
        <h3>{task.name}</h3>
        <p>{metaText}</p>
      </div>
      <div className="task-actions-next">
        <button type="button" disabled={busy || task.status === "running"} onClick={onRegenerate}>重生</button>
        <button className="danger" type="button" disabled={busy} onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}

function ConfigButtons({ label, values, value, onChange, formatter, compact = false }) {
  if (!values?.length) return null;
  return (
    <div className={`create-config-block-next ${compact ? "compact" : ""}`}>
      <div className="field-label-next">{label}</div>
      <div className="config-stepper-next">
        {values.map((item) => {
          const optionValue = typeof item === "object" ? item.value : item;
          const optionLabel = typeof item === "object" ? item.label : item;
          return (
            <button className={String(value) === String(optionValue) ? "selected" : ""} type="button" onClick={() => onChange(optionValue)} key={optionValue}>
              {formatter ? formatter(optionLabel) : optionLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileImportButton({ onText }) {
  return (
    <label className="secondary-action compact file-import-next">
      导入
      <input type="file" accept=".json,.txt,.csv,application/json,text/plain,text/csv" onChange={async (event) => {
        const file = event.target.files?.[0];
        if (file) onText(await file.text());
        event.target.value = "";
      }} />
    </label>
  );
}

function ImageThumbs({ images, onRemove, onPreview }) {
  if (!images.length) return null;
  return (
    <div className="reference-preview-list-next">
      {images.map((image) => (
        <figure className="reference-thumb-next" key={image.id}>
          <button className="reference-thumb-preview-next" type="button" onClick={() => onPreview?.({ url: resolveFlowStudioFileUrl(image.dataUrl || image.fileUrl), title: image.name || "参考图" })}>
            <img src={resolveFlowStudioFileUrl(image.dataUrl || image.fileUrl)} alt={image.name || "参考图"} />
          </button>
          <button type="button" onClick={() => onRemove(image.id)}>×</button>
          <figcaption>{image.name || "参考图"}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function FrameUpload({ label, image, onFiles, onRemove, onPreview }) {
  return (
    <div className={`frame-upload-next ${image ? "filled" : ""}`}>
      {image ? (
        <>
          <button className="frame-preview-button-next" type="button" onClick={() => onPreview?.({ url: resolveFlowStudioFileUrl(image.dataUrl || image.fileUrl), title: image.name || label })}>
            <img src={resolveFlowStudioFileUrl(image.dataUrl || image.fileUrl)} alt={label} />
          </button>
          <button type="button" onClick={(event) => {
            event.preventDefault();
            onRemove();
          }}>×</button>
        </>
      ) : (
        <label className="frame-empty-trigger-next">
          <input type="file" accept="image/*" onChange={(event) => onFiles(event.target.files)} />
          <span>{label}</span>
        </label>
      )}
    </div>
  );
}

function serviceTypeForMode(mode) {
  if (mode === "audio") return "audio";
  if (mode === "video") return "video";
  if (mode === "image") return "image";
  return "";
}

function modelsForMode(mode, apiKey) {
  if (mode === "image") return imageModelsForApiKey(apiKey);
  if (mode === "video") return videoModelsForApiKey(apiKey);
  if (mode === "audio") return audioModels.filter((model) => !apiKey?.channel || sameApiChannel(model.channel, apiKey.channel));
  return [];
}

function sameApiChannel(left = "", right = "") {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function formatApiChannelName(channel = "") {
  const value = String(channel || "").trim();
  if (/^canvas$/i.test(value)) return "Canvas";
  return value;
}

function syncConfigDefaults(config, mode, apiKeys, styles) {
  const keys = apiKeysForService(apiKeys, serviceTypeForMode(mode));
  if (mode === "image") {
    return {
      ...emptyImageConfig,
      ...config,
      apiKeyId: keys.some((key) => key.id === config.apiKeyId) ? config.apiKeyId : keys[0]?.id || "",
      visualStyleId: styles.some((style) => style.id === config.visualStyleId) ? config.visualStyleId : styles[0]?.id || "",
    };
  }
  if (mode === "audio") {
    return {
      ...emptyAudioConfig,
      ...config,
      apiKeyId: keys.some((key) => key.id === config.apiKeyId) ? config.apiKeyId : keys[0]?.id || "",
    };
  }
  return {
    ...emptyVideoConfig,
    ...config,
    apiKeyId: keys.some((key) => key.id === config.apiKeyId) ? config.apiKeyId : keys[0]?.id || "",
  };
}

function mergeVisualStyles(assets) {
  const normalized = assets.map((asset) => {
    const payload = asset.payload && typeof asset.payload === "object" ? asset.payload : {};
    return {
      id: asset.id || payload.id,
      name: asset.name || payload.name || "未命名风格",
      prompt: payload.prompt || asset.prompt || "",
    };
  }).filter((style) => style.id);
  const ids = new Set(normalized.map((style) => style.id));
  return [...fallbackVisualStyles.filter((style) => !ids.has(style.id)), ...normalized];
}

function normalizeCreateImageLibraries(data) {
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const libraryMap = new Map(groups.map((group) => {
    const library = normalizeCreateImageLibraryGroup(group);
    return [library.id, library];
  }));

  assets.map(normalizeCreateAsset).forEach((asset) => {
    if (Array.isArray(asset.images) && asset.images.length) {
      const library = libraryMap.get(asset.id) || normalizeCreateImageLibraryGroup(asset);
      library.images.push(...asset.images.map((image) => normalizeCreateImageAsset(image, library.id, library.name)));
      libraryMap.set(library.id, library);
      return;
    }

    const groupId = asset.groupId || "ungrouped-image-library";
    if (!libraryMap.has(groupId)) {
      libraryMap.set(groupId, {
        id: groupId,
        name: "未分组",
        desc: "",
        images: [],
      });
    }
    const library = libraryMap.get(groupId);
    library.images.push(normalizeCreateImageAsset(asset, groupId, library.name));
  });

  return Array.from(libraryMap.values()).filter((library) => library.images.length || library.id !== "ungrouped-image-library");
}

function normalizeCreateImageLibraryGroup(group = {}) {
  return {
    id: group.id || crypto.randomUUID(),
    name: group.name || "未命名图库",
    desc: group.desc || group.description || "",
    images: [],
  };
}

function normalizeCreateAsset(asset = {}) {
  const payload = asset.payload && typeof asset.payload === "object" ? asset.payload : {};
  return {
    ...payload,
    id: asset.id || payload.id || crypto.randomUUID(),
    groupId: asset.groupId || payload.groupId || "",
    name: asset.name || payload.name || "未命名图片",
    desc: asset.desc || payload.desc || "",
    type: asset.mimeType || payload.mimeType || payload.type || "image/png",
    dataUrl: resolveFlowStudioFileUrl(payload.dataUrl || asset.dataUrl || ""),
    fileUrl: resolveFlowStudioFileUrl(asset.fileUrl || payload.fileUrl || payload.dataUrl || ""),
    fileKey: asset.fileKey || payload.fileKey || "",
    mimeType: asset.mimeType || payload.mimeType || payload.type || "image/png",
    images: Array.isArray(payload.images) ? payload.images : Array.isArray(asset.images) ? asset.images : [],
    createdAt: asset.createdAt || payload.createdAt || "",
  };
}

function normalizeCreateImageAsset(image = {}, groupId, libraryName = "图片库") {
  const normalized = normalizeCreateAsset({ ...image, groupId: image.groupId || groupId });
  return {
    ...normalized,
    id: normalized.id || crypto.randomUUID(),
    groupId,
    libraryName,
    name: normalized.name || "图库图片",
    fileUrl: resolveFlowStudioFileUrl(normalized.fileUrl || normalized.dataUrl || ""),
    dataUrl: resolveFlowStudioFileUrl(normalized.dataUrl || normalized.fileUrl || ""),
  };
}

function flattenGalleryImages(libraries) {
  return libraries.flatMap((library) => (
    (library.images || []).map((image) => ({
      ...image,
      libraryName: image.libraryName || library.name || "图片库",
      fileUrl: resolveFlowStudioFileUrl(image.fileUrl || image.dataUrl || ""),
      dataUrl: resolveFlowStudioFileUrl(image.dataUrl || image.fileUrl || ""),
    }))
  )).filter((image) => image.fileUrl || image.dataUrl);
}

function normalizeImportedReferenceImage(image = {}) {
  const fileUrl = resolveFlowStudioFileUrl(image.fileUrl || image.dataUrl || "");
  const dataUrl = resolveFlowStudioFileUrl(image.dataUrl || image.fileUrl || "");
  return {
    id: image.id || crypto.randomUUID(),
    name: image.name || "图库图片",
    type: image.type || image.mimeType || "image/png",
    dataUrl,
    fileUrl,
    fileKey: image.fileKey || "",
  };
}

function normalizeToolTask(asset) {
  const payload = asset.payload && typeof asset.payload === "object" ? asset.payload : {};
  if (!payload.id && !asset.id) return null;
  return {
    ...payload,
    id: asset.id || payload.id,
    name: asset.name || payload.name || "自由创作任务",
    type: payload.type || "image",
    status: payload.status || "draft",
    resultImages: Array.isArray(payload.resultImages) ? payload.resultImages.map(resolveFlowStudioFileUrl).filter(Boolean) : [],
    videoUrl: resolveFlowStudioFileUrl(payload.videoUrl || ""),
    audioUrl: resolveFlowStudioFileUrl(payload.audioUrl || ""),
    createdAt: asset.createdAt || payload.createdAt || new Date().toISOString(),
    updatedAt: asset.updatedAt || payload.updatedAt || "",
    meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {},
    storedOnServer: true,
  };
}

function parsePromptList(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => item?.prompt || item?.text || item?.content || String(item)).map((item) => item.trim()).filter(Boolean);
    }
    return Object.values(parsed).map((item) => (typeof item === "string" ? item : item?.prompt || item?.text || JSON.stringify(item))).map((item) => item.trim()).filter(Boolean);
  } catch {
    return text.split("\n").map((line) => line.trim()).filter(Boolean);
  }
}

function buildImagePrompt(task, styles) {
  const style = styles.find((item) => item.id === task.meta?.visualStyleId);
  return [task.prompt, style?.prompt ? `风格参考：${style.prompt}` : ""].filter(Boolean).join("\n\n");
}

function extractImagesFromResponse(data) {
  if (!data) return [];
  if (Array.isArray(data.images)) return data.images.map(imageValue);
  if (Array.isArray(data.resultImages)) return data.resultImages.map(imageValue);
  if (data.imageUrl || data.url || data.fileUrl) return [imageValue(data)];
  if (Array.isArray(data.data)) return data.data.map(imageValue);
  if (Array.isArray(data.choices)) {
    return data.choices.flatMap((choice) => {
      const content = choice?.message?.content;
      if (Array.isArray(content)) return content.map(imageValue);
      return imageValue(choice);
    });
  }
  return [];
}

function imageValue(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (item.url || item.imageUrl || item.fileUrl) return item.url || item.imageUrl || item.fileUrl;
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.image?.url) return item.image.url;
  if (item.type === "image_url") return item.image_url?.url || "";
  if (item.type === "image") return item.source?.data ? `data:${item.source.media_type || "image/png"};base64,${item.source.data}` : "";
  return "";
}

function collectSelectableToolImages(tasks) {
  return tasks.flatMap((task) => {
    const images = Array.isArray(task.resultImages) ? task.resultImages : [];
    return images.map((image, index) => {
      const url = resolveFlowStudioFileUrl(image);
      return {
        id: toolImageSelectionId(task.id, index),
        taskId: task.id,
        taskName: task.name || "image",
        index,
        url,
        prompt: task.prompt || "",
      };
    });
  }).filter((image) => image.url);
}

function toolImageSelectionId(taskId, index) {
  return `${taskId}:${index}`;
}

function toolImageZipPayload(images) {
  const stamp = formatDateStamp();
  return {
    folder: `自由创作图片-${stamp}`,
    fileName: `自由创作图片-${stamp}.zip`,
    sheet: {
      name: "自由创作图片清单",
      headers: ["图片序号", "图片文件", "提示词"],
    },
    files: images.map((image, index) => {
      const serial = String(index + 1).padStart(2, "0");
      const baseName = safeToolFileName(`${serial}-${image.taskName}-${image.index + 1}`);
      const extension = imageExtensionFromUrl(image.url) || "png";
      return {
        url: image.url,
        name: `images/${baseName}.${extension}`,
        label: `${serial} ${image.taskName}`,
        prompt: image.prompt || "",
      };
    }),
  };
}

function safeToolFileName(name) {
  return String(name || "image").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "image";
}

function imageExtensionFromUrl(url = "") {
  const match = String(url).split("?")[0].split("#")[0].match(/\.([a-zA-Z0-9]+)$/);
  const extension = match?.[1]?.toLowerCase() || "";
  if (!["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) return "";
  return extension === "jpeg" ? "jpg" : extension;
}

function imageExtensionFromMime(mime = "") {
  const normalized = String(mime || "").split(";")[0].trim().toLowerCase();
  return {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  }[normalized] || "";
}

function formatDateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function toolPackageExpiresText(value) {
  const time = Number(value);
  if (!time) return "短期有效";
  const minutes = Math.max(1, Math.round((time - Date.now()) / 60000));
  return `${minutes} 分钟后过期`;
}

function browserDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadToolBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  downloadToolLink(url, fileName);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function downloadToolLink(url, fileName) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function saveAudioDraft(text) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem("flowstudio-audio-draft", String(text || ""));
}

function splitAudioText(text, maxChars = AUDIO_SEGMENT_MAX_CHARS) {
  const source = String(text || "").trim();
  if (!source) return [];
  const pieces = source
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const segments = [];
  let current = "";
  let cursor = 0;
  let currentStart = 0;
  const pushCurrent = () => {
    const value = current.trim();
    if (!value) return;
    segments.push({
      text: value,
      start: currentStart,
      end: currentStart + value.length,
    });
    current = "";
  };
  for (const piece of pieces.length ? pieces : [source]) {
    if (!current) currentStart = cursor;
    if (piece.length > maxChars) {
      pushCurrent();
      for (let index = 0; index < piece.length; index += maxChars) {
        const chunk = piece.slice(index, index + maxChars).trim();
        if (chunk) segments.push({ text: chunk, start: cursor + index, end: cursor + index + chunk.length });
      }
    } else if ((current ? current.length + 1 : 0) + piece.length <= maxChars) {
      current = current ? `${current}\n${piece}` : piece;
    } else {
      pushCurrent();
      currentStart = cursor;
      current = piece;
    }
    cursor += piece.length;
  }
  pushCurrent();
  return segments.length ? segments : [{ text: source, start: 0, end: source.length }];
}

function collectAudioHistoryGroups(tasks) {
  const groups = new Map();
  tasks
    .filter((task) => task.type === "audio")
    .forEach((task) => {
      const groupId = task.meta?.groupId || task.id;
      if (!groups.has(groupId)) {
        groups.set(groupId, {
          id: groupId,
          name: audioGroupName(task),
          createdAt: task.createdAt || "",
          updatedAt: task.updatedAt || task.createdAt || "",
          tasks: [],
        });
      }
      const group = groups.get(groupId);
      group.tasks.push(task);
      if ((task.updatedAt || task.createdAt || "") > group.updatedAt) group.updatedAt = task.updatedAt || task.createdAt || "";
    });
  return Array.from(groups.values())
    .map((group) => {
      const ordered = orderAudioTasks(group.tasks);
      return {
        ...group,
        tasks: ordered,
        total: ordered[0]?.meta?.segmentTotal || ordered.length || 1,
        doneCount: ordered.filter((task) => task.status === "done" || task.audioUrl).length,
        errorCount: ordered.filter((task) => task.status === "error").length,
      };
    })
    .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
}

function audioGroupName(task) {
  const name = String(task.name || "audio");
  return name.replace(/-\d{2}$/g, "") || name;
}

function orderAudioTasks(tasks = []) {
  return [...tasks].sort((left, right) => {
    const leftIndex = Number(left.meta?.segmentIndex || 1);
    const rightIndex = Number(right.meta?.segmentIndex || 1);
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
  });
}

function audioGroupPreviewStatus(tasks = []) {
  if (!tasks.length) return "queued";
  if (tasks.some((task) => task.status === "error")) return "error";
  if (tasks.some((task) => task.status === "running" || task.status === "queued")) return "running";
  if (tasks.every((task) => task.status === "done" || task.audioUrl)) return "done";
  return "queued";
}

function audioGroupPreviewStatusLabel(tasks = []) {
  const status = audioGroupPreviewStatus(tasks);
  if (status === "done") return "已生成";
  if (status === "error") return "异常";
  if (status === "running") return "生成中";
  return "待生成";
}

function audioGroupStatusLabel(group) {
  if (group.errorCount) return "异常";
  if (group.doneCount >= group.total) return "已生成";
  if (group.doneCount) return "部分完成";
  return "待生成";
}

async function downloadAudioGroup(tasks = []) {
  const readyTasks = orderAudioTasks(tasks).filter((task) => task.audioUrl);
  if (!readyTasks.length) return;
  if (readyTasks.length === 1) {
    const task = readyTasks[0];
    const result = await downloadToolFile({
      url: resolveFlowStudioFileUrl(task.audioUrl || ""),
      fileName: `${safeToolFileName(task.name || "audio")}.${task.meta?.format || "mp3"}`,
    });
    downloadToolBlob(result.blob, result.fileName);
    return;
  }
  const groupName = audioGroupName(readyTasks[0]);
  const result = await downloadToolFileZip({
    folder: safeToolFileName(groupName || "audio"),
    fileName: `${safeToolFileName(groupName || "audio")}.zip`,
    manifestName: "音频清单",
    files: readyTasks.map((task, index) => {
      const serial = String(task.meta?.segmentIndex || index + 1).padStart(2, "0");
      return {
        url: resolveFlowStudioFileUrl(task.audioUrl || ""),
        name: `audio/${serial}-${safeToolFileName(task.name || "audio")}.${task.meta?.format || "mp3"}`,
        label: task.prompt || "",
      };
    }),
  });
  downloadToolBlob(result.blob, result.fileName);
}

async function downloadAudioGroups(groups = []) {
  const selectedGroups = groups.filter((group) => group?.tasks?.length);
  if (!selectedGroups.length) return 0;
  if (selectedGroups.length === 1) {
    const readyTasks = orderAudioTasks(selectedGroups[0].tasks).filter((task) => task.audioUrl);
    if (!readyTasks.length) return 0;
    await downloadAudioGroup(selectedGroups[0].tasks);
    return readyTasks.length;
  }
  const files = selectedGroups.flatMap((group, groupIndex) => {
    const groupFolder = `${String(groupIndex + 1).padStart(2, "0")}-${safeToolFileName(group.name || "audio")}`;
    return orderAudioTasks(group.tasks)
      .filter((task) => task.audioUrl)
      .map((task, taskIndex) => {
        const serial = String(task.meta?.segmentIndex || taskIndex + 1).padStart(2, "0");
        return {
          url: resolveFlowStudioFileUrl(task.audioUrl || ""),
          name: `${groupFolder}/${serial}-${safeToolFileName(task.name || "audio")}.${task.meta?.format || "mp3"}`,
          label: task.prompt || "",
        };
      });
  });
  if (!files.length) return 0;
  const result = await downloadToolFileZip({
    folder: "audio-history",
    fileName: "audio-history.zip",
    manifestName: "音频清单",
    files,
  });
  downloadToolBlob(result.blob, result.fileName);
  return files.length;
}

async function exportAudioTimestamps(tasks = []) {
  const rows = await buildAudioTimestampRows(tasks);
  if (!rows.length) return;
  const csv = [
    ["segment", "start", "end", "text", "audio"].join(","),
    ...rows.map((row) => [
      row.segment,
      row.start,
      row.end,
      csvCell(row.text),
      csvCell(row.audioUrl),
    ].join(",")),
  ].join("\n");
  const srt = rows.map((row, index) => [
    String(index + 1),
    `${row.start} --> ${row.end}`,
    row.text,
  ].join("\n")).join("\n\n");
  const baseName = safeToolFileName(rows[0]?.groupName || "audio-timestamps");
  downloadToolBlob(new Blob([`${csv}\n\n[SRT]\n${srt}`], { type: "text/plain;charset=utf-8" }), `${baseName}-timestamps.txt`);
}

async function buildAudioTimestampRows(tasks = []) {
  let cursorMs = 0;
  const rows = [];
  for (const task of orderAudioTasks(tasks)) {
    const audioUrl = resolveFlowStudioFileUrl(task.audioUrl || "");
    const durationMs = await getAudioDurationMs(audioUrl).catch(() => estimateAudioDurationMs(task.prompt || "", task.meta?.speed));
    const row = {
      groupName: audioGroupName(task),
      segment: Number(task.meta?.segmentIndex || 1),
      start: formatSrtTime(cursorMs),
      end: formatSrtTime(cursorMs + durationMs),
      text: task.prompt || "",
      audioUrl,
    };
    cursorMs += durationMs;
    rows.push(row);
  }
  return rows;
}

function getAudioDurationMs(url) {
  if (!url || typeof Audio === "undefined") return Promise.reject(new Error("音频地址为空。"));
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const cleanup = () => {
      audio.removeAttribute("src");
      audio.load();
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = Number(audio.duration || 0);
      cleanup();
      if (duration > 0) resolve(Math.round(duration * 1000));
      else reject(new Error("音频时长不可用。"));
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("音频时长读取失败。"));
    };
    audio.src = url;
  });
}

function estimateAudioDurationMs(text, speed = 1) {
  const chars = String(text || "").replace(/\s+/g, "").length;
  const normalizedSpeed = Math.max(0.5, Math.min(2, Number(speed || 1)));
  return Math.max(1600, Math.round((chars / (4.2 * normalizedSpeed)) * 1000));
}

function formatSrtTime(ms) {
  const safeMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(safeMs / 3600000);
  const minutes = Math.floor((safeMs % 3600000) / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function csvCell(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

function normalizeVideoResult(task, result = {}) {
  const videoUrl = resolveFlowStudioFileUrl(result.videoUrl || result.url || result.outputUrl || "");
  const taskId = result.taskId || result.id || task.meta?.taskId || "";
  const status = String(result.status || "").toLowerCase();
  const failed = ["failed", "error", "cancelled", "canceled"].includes(status);
  return {
    ...task,
    status: videoUrl ? "done" : failed ? "error" : "running",
    videoUrl,
    error: failed ? result.message || "视频任务生成失败。" : "",
    updatedAt: new Date().toISOString(),
    meta: {
      ...(task.meta || {}),
      taskId,
      completedAt: videoUrl ? new Date().toISOString() : task.meta?.completedAt || "",
    },
  };
}

function normalizeAudioResult(task, result = {}) {
  const audioUrl = resolveFlowStudioFileUrl(result.audioUrl || result.url || result.outputUrl || "");
  return {
    ...task,
    status: audioUrl ? "done" : "error",
    audioUrl,
    error: audioUrl ? "" : result.message || "音频任务生成失败。",
    updatedAt: new Date().toISOString(),
    meta: {
      ...(task.meta || {}),
      mimeType: result.mimeType || task.meta?.mimeType || "",
      sizeBytes: result.sizeBytes || task.meta?.sizeBytes || 0,
      completedAt: audioUrl ? new Date().toISOString() : task.meta?.completedAt || "",
    },
  };
}

function friendlyAudioError(error) {
  const message = error?.message || "音频生成失败。";
  if (error?.status === 404 && /接口不存在|not\s*found|404/i.test(message)) {
    return "音频生成接口不存在。请确认后端已部署当前分支，并且前端 NEXT_PUBLIC_API_BASE_URL 指向这次更新后的后端服务。";
  }
  return message;
}

function getVideoFrames(mode, model, frames) {
  if (mode === "text") return [];
  const url = image => image?.fileUrl || image?.dataUrl;
  if (mode === "all-reference") return frames.references.map(url).filter(Boolean);
  if (mode === "first-last-frame") return [url(frames.first), url(frames.last)].filter(Boolean);
  return [url(frames.first)].filter(Boolean);
}

function supportsVideoAllReference(model) {
  return model?.modes?.some(mode => mode.value === "all-reference") || false;
}

function uniqueTaskName(baseName, tasks, type) {
  const base = String(baseName || type || "task").trim() || type || "task";
  const existing = new Set(tasks.filter((task) => task.type === type).map((task) => task.name));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function resultsTitle(mode) {
  return {
    image: "生成结果",
    video: "视频任务",
    audio: "音频结果",
  }[mode] || "生成结果";
}

function resultsDescription(mode) {
  return {
    image: "点击图片可打开原图，支持单张下载。",
    video: "任务提交后可查询视频结果。",
    audio: "可试听生成音频并下载文件。",
  }[mode] || "任务结果会显示在这里。";
}

function emptyTaskHint(mode) {
  return {
    image: "输入提示词或导入批量提示词后开始生成。",
    video: "添加视频提示词后可提交生成任务。",
    audio: "输入配音文本后可提交生成任务。",
  }[mode] || "添加提示词后可提交生成任务。";
}

function taskStatusLabel(task) {
  if (task.status === "done") {
    if (task.type === "video") return "已生成视频";
    if (task.type === "audio") return "已生成音频";
    return "已生成预览";
  }
  if (task.status === "error") return "生成失败";
  if (task.status === "running") {
    if (task.type === "video") return "查询生成结果中";
    if (task.type === "audio") return "正在生成音频";
    return "正在生成";
  }
  if (task.status === "queued") return "排队等待";
  if (task.type === "video") return "等待生成视频";
  if (task.type === "audio") return "等待生成音频";
  return "等待生成图片";
}

function loadStateLabel(state) {
  if (state === "ready") return "已同步";
  if (state === "warning") return "待确认";
  if (state === "error") return "异常";
  return "同步中";
}

function videoResolutionLabel(value) {
  if (value === "true") return "开启";
  if (value === "false") return "关闭";
  return value;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
