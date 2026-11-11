"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createWorkflow,
  createWorkflowRun,
  confirmWorkflowTopics,
  deleteWorkflow,
  executeWorkflowTopics,
  generateAudio,
  getWorkflowRun,
  listApiKeys,
  listAssets,
  listWorkflowSummaries,
  queueWorkflowNode,
  readAuthToken,
  resolveFlowStudioFileUrl,
  updateWorkflow,
  updateWorkflowRun,
  uploadAssetFiles,
} from "../../lib/flowstudio-api";
import { apiKeysForService } from "../../lib/api-key-options";
import SavedAudioVoicePicker from "../../components/SavedAudioVoicePicker";
import { mergeAudioModelOptions } from "../../lib/audio-model-options";
import { imageModelsForApiKey } from "../../lib/image-model-options";
import { apiKeySupportsVideoAnalysis, llmModelsForApiKey, videoAnalysisModelId, videoAnalysisModelsForApiKey } from "../../lib/llm-model-options";
import { canReuseWorkflowVideoAnalysis } from "../../lib/workflow-video-analysis-reuse.mjs";
import { orderWorkflowStageIds, workflowNodeActiveStatus } from "../../lib/workflow-stage-policy.mjs";
import { splitWorkflowTopicTranslation } from "../../lib/workflow-topic-display.mjs";
import { normalizeYoutubeVideoUrl } from "../../lib/youtube-video-url.mjs";

const workflowTypes = [
  { id: "explain", label: "口播视频" },
  { id: "ecommerce", label: "带货视频" },
  { id: "story", label: "故事视频" },
  { id: "free", label: "自由创作" },
];

const ecommerceAssetDefinitions = [
  { key: "scriptAssetId", listKey: "scripts", type: "script", label: "脚本库", emptyLabel: "不选择脚本资产", multiple: false },
  { key: "roleAssetId", listKey: "roles", type: "role", label: "角色库", emptyLabel: "不选择角色资产", multiple: false },
  { key: "productAssetId", listKey: "products", type: "product", label: "带货产品", emptyLabel: "不选择带货产品", multiple: false },
  { key: "hookAssetId", modeKey: "hookSelectionMode", listKey: "hooks", type: "hook", label: "爆款开头", emptyLabel: "不选择爆款开头", multiple: false, randomLabel: "随机 1 个" },
  { key: "elementAssetIds", modeKey: "elementSelectionMode", listKey: "elements", type: "element", label: "爆款元素", emptyLabel: "暂不使用爆款元素", multiple: true, max: 3, randomLabel: "随机最多 3 个" },
];

const storyAssetDefinitions = ecommerceAssetDefinitions.filter((definition) => definition.type !== "product");

const workflowLanguageOptions = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英语" },
  { value: "de", label: "德语" },
  { value: "fr", label: "法语" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "id", label: "印尼语" },
  { value: "pt", label: "葡萄牙语" },
  { value: "es", label: "西班牙语" },
];

const explainWorkflowLanguageOptions = workflowLanguageOptions;

const workflowAudienceProfileOptions = [
  { value: "unspecified", label: "不指定" },
  { value: "50-plus", label: "50岁以上" },
  { value: "35-50", label: "35-50岁" },
  { value: "25-34", label: "25-34岁" },
  { value: "18-24", label: "18-24岁" },
];

const workflowStoryEnvironmentOptions = [
  { value: "unspecified", label: "不指定" },
  { value: "china", label: "中国" },
  { value: "united-states", label: "美国" },
  { value: "united-kingdom", label: "英国" },
  { value: "germany", label: "德国" },
  { value: "france", label: "法国" },
  { value: "japan", label: "日本" },
  { value: "south-korea", label: "韩国" },
  { value: "india", label: "印度" },
  { value: "indonesia", label: "印度尼西亚" },
  { value: "vietnam", label: "越南" },
  { value: "portugal", label: "葡萄牙" },
  { value: "spain", label: "西班牙" },
];

const workflowRoleReferenceModes = [
  { id: "random", label: "随机选择", description: "每次生成分镜时，为角色随机匹配一张角色参考图。" },
  { id: "default", label: "使用默认", description: "固定使用角色库里标记为默认的角色图。" },
  { id: "manual", label: "手动指定", description: "为每个角色指定一张固定参考图。" },
  { id: "none", label: "无参考图", description: "分镜映射不引用角色库图片，仅保留角色文字提示。" },
];

const workflowStages = [
  { id: "topic", name: "选题" },
  { id: "outline", name: "大纲" },
  { id: "script", name: "文案" },
  { id: "optimize", name: "优化" },
  { id: "shot", name: "分镜" },
  { id: "image", name: "图片" },
  { id: "audio", name: "音频" },
  { id: "videoPrompt", name: "视频提示" },
  { id: "video", name: "视频" },
];

const pendingWorkflowScriptRunsKey = "flowstudio:pending-workflow-script-runs";
const workflowReturnSnapshotKey = "flowstudio:workflow-return-snapshot";
const workflowReturnSnapshotMaxAgeMs = 15 * 60 * 1000;
const storyVideoAnalysisMaxBytes = 20 * 1024 * 1024;

const defaultWorkflowVisualStyles = [
  {
    id: "system-real-photo",
    name: "真实摄影风",
    desc: "真实镜头、自然光线、细节可信，适合人物、城市、纪实和产品图片。",
    prompt: "realistic photography, natural lighting, authentic details, shallow depth of field, high dynamic range, professional camera, true-to-life texture",
    system: true,
  },
  {
    id: "system-3d-animation",
    name: "3D动画风",
    desc: "3D 动画渲染质感，色彩明快，适合夸张角色、产品展示和轻剧情画面。",
    prompt: "3D animation style, stylized characters, cinematic lighting, vibrant colors, smooth rendering, high detail, playful composition",
    system: true,
  },
];

const workflowAudioFormats = ["mp3", "wav", "opus"];
const workflowAudioEmotions = [
  { value: "natural", label: "自然" },
  { value: "happy", label: "愉悦" },
  { value: "sad", label: "低沉" },
  { value: "angry", label: "有力" },
];
const workflowAudioVoiceModes = [
  { id: "default", name: "默认音色", description: "使用模型默认声音，适合快速生成。" },
  { id: "clone", name: "克隆音色", description: "上传 10-30 秒参考音频随文克隆。" },
  { id: "saved", name: "已克隆音色", description: "填写 音频服务 已保存的 reference_id。" },
];

const emptyForm = {
  name: "",
  type: "explain",
  llmKeyId: "",
  topicLlmKeyId: "",
  topicModelId: "",
  storyModelId: "",
  shotModelId: "",
  imageKeyId: "",
  imageModelId: "",
  imageResolution: "1k",
  imageSize: "",
  audioKeyId: "",
  audioModelId: "",
  audioVoice: "alloy",
  audioFormat: "mp3",
  audioEmotion: "natural",
  audioBitrate: 128,
  audioSpeed: 1,
  audioVoicePresetId: "default",
  audioReferenceId: "",
  audioReferences: [],
  topicInspiration: "",
  topicOriginality: 50,
  commentaryTrack: "",
  topicMode: "ai",
  inputScriptTitle: "",
  inputScript: "",
  inputScriptDurationMode: "smart",
  inputScriptTargetDurationSeconds: "",
  inputScriptShotDurationSeconds: 4.5,
  customTopicsText: "",
  customTopicItems: [{ title: "", adaptation: "" }],
  language: "",
  audienceProfile: "50-plus",
  storyEnvironment: "unspecified",
  endingInteractionEnabled: false,
  scriptPrompt: "",
  scriptPromptAssetId: "",
  writingStyleId: "",
  visualStyleId: "system-real-photo",
  topicCount: 5,
  ratio: "9:16",
  shotMode: "standard",
  executionStep: "story",
  storyScriptSourceMode: "library",
  storyVideoSourceMode: "upload",
  storyVideoUrl: "",
  storyVideoFile: null,
  storyVideoDurationSeconds: 0,
  storyVideoName: "",
  storyVideoError: "",
  storyVideoSaveToLibrary: false,
  storyVideoAnalysisLlmKeyId: "",
  storyVideoAnalysisModelId: "",
  storyVideoAnalysisConfigChanged: false,
  storyVideoSource: null,
  storyVideoScriptAsset: null,
  scriptAssetId: "",
  roleAssetId: "",
  preferRoleLibraryNames: false,
  roleReferenceImageMode: "random",
  roleReferenceImageSelections: {},
  hookSelectionMode: "none",
  hookAssetId: "",
  elementSelectionMode: "none",
  elementAssetIds: [],
  productAssetId: "",
  strengthenProduct: false,
  purchaseGuidanceEnabled: false,
  purchaseGuidanceText: "",
};

const emptyWorkflowReferences = {
  apiKeys: [],
  prompts: [],
  writingStyles: [],
  visualStyles: [],
  scripts: [],
  roles: [],
  hooks: [],
  elements: [],
  products: [],
};

export default function WorkflowsDashboard() {
  const [workflows, setWorkflows] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [loadState, setLoadState] = useState("loading");
  const [message, setMessage] = useState("正在读取工作流...");
  const [busyAction, setBusyAction] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [referenceData, setReferenceData] = useState(emptyWorkflowReferences);
  const [refreshingScope, setRefreshingScope] = useState("");
  const [actionDialog, setActionDialog] = useState(null);
  const [retryDialog, setRetryDialog] = useState(null);
  const loadingWorkflowListRef = useRef(false);

  useEffect(() => {
    if (!readAuthToken()) return;
    let active = true;
    const workflowId = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("workflowId") || "";
    const returnSnapshot = readWorkflowReturnSnapshot(workflowId);
    if (returnSnapshot) {
      const pendingScriptRunIds = readPendingWorkflowScriptRunIds();
      setWorkflows([normalizeWorkflow(returnSnapshot, pendingScriptRunIds)]);
      setSelectedWorkflowId(workflowId);
      setLoadState("ready");
      setMessage("正在后台同步最新任务...");
      loadWorkflowList(() => active, { keepContent: true });
    } else {
      loadWorkflowList(() => active);
    }
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || selectedWorkflowId) return;
    const workflowId = new URLSearchParams(window.location.search).get("workflowId");
    if (workflowId && workflows.some((workflow) => workflow.id === workflowId)) {
      setSelectedWorkflowId(workflowId);
    }
  }, [selectedWorkflowId, workflows]);

  useEffect(() => {
    if (!readAuthToken() || !workflows.some(workflowHasLiveRun)) return undefined;
    const timer = window.setInterval(() => {
      loadWorkflowList(() => true, { silent: true });
    }, 6000);
    return () => window.clearInterval(timer);
  }, [workflows]);

  async function loadWorkflowList(isActive = () => true, options = {}) {
    if (options.silent && loadingWorkflowListRef.current) return;
    loadingWorkflowListRef.current = true;
    const shouldLoadReferences = !options.silent && options.references !== false;
    if (!options.silent && !options.keepContent) {
      setLoadState("loading");
      setMessage("正在读取工作流...");
    }
    try {
      const [workflowResult, referenceResult] = await Promise.allSettled([
        listWorkflowSummaries(),
        shouldLoadReferences ? loadWorkflowReferences() : Promise.resolve(null),
      ]);
      if (!isActive()) return;
      if (workflowResult.status !== "fulfilled") throw workflowResult.reason;
      if (options.keepContent) clearWorkflowReturnSnapshot();
      const pendingScriptRunIds = readPendingWorkflowScriptRunIds();
      setWorkflows(Array.isArray(workflowResult.value.workflows) ? workflowResult.value.workflows.map((workflow) => normalizeWorkflow(workflow, pendingScriptRunIds)) : []);
      if (shouldLoadReferences && referenceResult.status === "fulfilled") {
        setReferenceData(referenceResult.value);
      }
      if (!options.silent) {
        setLoadState(!shouldLoadReferences || referenceResult.status === "fulfilled" ? "ready" : "warning");
        setMessage(!shouldLoadReferences || referenceResult.status === "fulfilled" ? "工作流已同步。" : "工作流已同步，部分配置名称暂时无法读取。");
      }
    } catch (error) {
      if (!isActive()) return;
      if (options.silent || options.keepContent) return;
      setLoadState("error");
      setMessage(error.message || "工作流读取失败。");
    } finally {
      loadingWorkflowListRef.current = false;
    }
  }

  const stats = useMemo(() => workflowStats(workflows), [workflows]);

  function updateForm(key, value) {
    if (loadState === "error") {
      setLoadState("ready");
      setMessage("");
    }
    setForm((current) => normalizeWorkflowCreateForm({ ...current, [key]: value }, referenceData, key));
  }

  async function handleCreateWorkflow(event) {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setLoadState("error");
      setMessage("请填写工作流名称。");
      return;
    }
    const validationMessage = validateWorkflowConfigForSave({ ...form, name });
    if (validationMessage) {
      setLoadState("error");
      setMessage(validationMessage);
      return;
    }

    setBusyAction("create-workflow");
    setLoadState("loading");
    setMessage(workflowUsesDirectVideo(form) && form.storyVideoFile ? "正在上传工作流视频..." : "正在创建工作流...");
    let preparedStoryVideo;
    try {
      preparedStoryVideo = await prepareWorkflowVideoSource(form, referenceData);
    } catch (error) {
      setBusyAction("");
      setLoadState("error");
      setMessage(error.message || "工作流视频准备失败。");
      return;
    }

    const preparedForm = {
      ...form,
      storyVideoSource: preparedStoryVideo.source,
      storyVideoScriptAsset: preparedStoryVideo.scriptAsset,
    };
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const topicMode = normalizeWorkflowTopicMode(preparedForm.topicMode, preparedForm.type);
    const isEcommerceWorkflow = preparedForm.type === "ecommerce";
    const storyboardWorkflow = isStoryboardWorkflow(preparedForm);
    const customTopicItems = storyboardWorkflow ? customTopicItemsForSave(preparedForm.customTopicItems, preparedForm.customTopicsText) : [];
    const customTopicTitles = storyboardWorkflow ? customTopicTitlesFromItems(customTopicItems) : stringListFromLines(preparedForm.customTopicsText);
    const topicAdaptations = storyboardWorkflow ? customTopicAdaptationsFromItems(customTopicItems) : {};
    const topicGenerates = workflowGeneratesTopics({ type: preparedForm.type, topicMode });
    const visualStyle = workflowVisualStyleSnapshot(referenceData.visualStyles, preparedForm.visualStyleId);
    const ecommerceAssets = workflowEcommerceAssetSnapshot(referenceData, preparedForm);
    const missingProductImages = isEcommerceWorkflow ? ecommerceProductAssetsMissingImages(ecommerceAssets.products) : [];
    if (missingProductImages.length) {
      setBusyAction("");
      setLoadState("error");
      setMessage("商品库缺少商品图，请先上传商品图后再新增工作流。");
      return;
    }
    const config = {
      id,
      name,
      type: preparedForm.type,
      llmKeyId: preparedForm.llmKeyId,
      topicLlmKeyId: preparedForm.topicLlmKeyId,
      topicModelId: preparedForm.topicModelId,
      storyModelId: preparedForm.storyModelId,
      shotModelId: preparedForm.shotModelId,
      imageKeyId: preparedForm.imageKeyId,
      imageModelId: preparedForm.imageModelId,
      imageResolution: preparedForm.imageResolution,
      imageSize: workflowImageRequestSize(preparedForm.ratio),
      audioKeyId: preparedForm.audioKeyId,
      audioModelId: preparedForm.audioModelId,
      audioVoice: preparedForm.audioVoice,
      audioFormat: preparedForm.audioFormat,
      audioEmotion: preparedForm.audioEmotion,
      audioBitrate: Number(preparedForm.audioBitrate || 128),
      audioSpeed: Number(preparedForm.audioSpeed || 1),
      audioVoicePresetId: preparedForm.audioVoicePresetId,
      audioReferenceId: preparedForm.audioReferenceId.trim(),
      audioReferences: normalizeWorkflowAudioReferences(preparedForm.audioReferences),
      topicInspiration: preparedForm.topicInspiration.trim(),
      topicOriginality: Number(preparedForm.topicOriginality ?? 50),
      commentaryTrack: preparedForm.commentaryTrack.trim(),
      topicMode,
      inputScriptTitle: workflowUsesInputScript(preparedForm) ? preparedForm.inputScriptTitle.trim() : "",
      inputScript: workflowUsesInputScript(preparedForm) ? preparedForm.inputScript.trim() : "",
      inputScriptDurationMode: workflowUsesInputScript(preparedForm) ? normalizeInputScriptDurationMode(preparedForm.inputScriptDurationMode) : "smart",
      inputScriptTargetDurationSeconds: workflowUsesInputScript(preparedForm) && normalizeInputScriptDurationMode(preparedForm.inputScriptDurationMode) === "custom"
        ? normalizeInputScriptTargetDurationSeconds(preparedForm.inputScriptTargetDurationSeconds)
        : 0,
      inputScriptShotDurationSeconds: workflowUsesInputScript(preparedForm) ? 4.5 : 0,
      customTopics: storyboardWorkflow ? customTopicItems : customTopicTitles,
      topicAdaptations,
      language: preparedForm.language,
      audienceProfile: storyboardWorkflow ? normalizeWorkflowAudienceProfile(preparedForm.audienceProfile) : "",
      storyEnvironment: storyboardWorkflow ? normalizeWorkflowStoryEnvironment(preparedForm.storyEnvironment) : "unspecified",
      endingInteractionEnabled: storyboardWorkflow && Boolean(preparedForm.endingInteractionEnabled),
      scriptPrompt: preparedForm.scriptPrompt.trim(),
      writingStyleId: preparedForm.writingStyleId,
      visualStyleId: preparedForm.visualStyleId,
      visualStyleName: visualStyle.name,
      visualStylePrompt: visualStyle.prompt,
      topicCount: Number(preparedForm.topicCount || 5),
      ratio: preparedForm.ratio,
      executionStep: preparedForm.executionStep,
      shotMode: preparedForm.shotMode,
      storyScriptSourceMode: preparedForm.storyScriptSourceMode,
      storyVideoSource: preparedStoryVideo.source,
      scriptAssetId: workflowUsesInputScript(preparedForm)
        ? ""
        : workflowUsesDirectVideo(preparedForm) && preparedStoryVideo.source?.saveToScriptLibrary
          ? preparedStoryVideo.source.scriptAssetId || ""
          : preparedForm.scriptAssetId,
      roleAssetId: preparedForm.roleAssetId,
      preferRoleLibraryNames: storyboardWorkflow && Boolean(preparedForm.roleAssetId) && Boolean(preparedForm.preferRoleLibraryNames),
      roleReferenceImageMode: normalizeRoleReferenceImageMode(preparedForm.roleReferenceImageMode, "random"),
      roleReferenceImageSelections: normalizeRoleReferenceImageSelections(preparedForm.roleReferenceImageSelections),
      hookSelectionMode: preparedForm.hookSelectionMode,
      hookAssetId: workflowSnapshotSingleAssetId(ecommerceAssets.hooks),
      elementSelectionMode: preparedForm.elementSelectionMode,
      elementAssetIds: workflowSnapshotAssetIds(ecommerceAssets.elements).slice(0, 3),
      productAssetId: isEcommerceWorkflow ? preparedForm.productAssetId : "",
      strengthenProduct: isEcommerceWorkflow && Boolean(preparedForm.strengthenProduct),
      purchaseGuidanceEnabled: isEcommerceWorkflow && Boolean(preparedForm.purchaseGuidanceEnabled),
      purchaseGuidanceText: isEcommerceWorkflow && preparedForm.purchaseGuidanceEnabled ? preparedForm.purchaseGuidanceText.trim() : "",
      ecommerceAssets,
      createdAt: now,
      runCount: 0,
      storedOnServer: true,
      topicGenerationStatus: topicGenerates ? "running" : "done",
      generatedTopics: topicGenerates ? [] : customTopicTitles,
      selectedTopics: [],
    };

    setMessage("正在创建工作流...");
    try {
      const created = await createWorkflow({
        id,
        name,
        type: preparedForm.type,
        config,
      });
      const workflowId = created?.workflow?.id || id;
      const workflowForRun = { ...config, id: workflowId };
      const seedRun = createTopicSeedRun(workflowForRun);
      const savedRunResult = await createWorkflowRun(workflowId, workflowRunPayload(seedRun));
      const savedRun = normalizeWorkflowRun(savedRunResult?.run || seedRun);
      let queueWarning = "";
      if (workflowRequiresVideoAnalysis(workflowForRun)) {
        try {
          await queueWorkflowNode(savedRun.id, "source", {
            workflowId,
            title: "视频解析",
            payload: {
              topicPayload: workflowTopicQueuePayload(workflowForRun),
            },
          });
        } catch (queueError) {
          queueWarning = queueError.message || "工作流已创建，但视频解析排队失败。";
        }
      } else if (workflowUsesInputScript(workflowForRun)) {
        try {
          await queueInputScriptWorkflowRun(savedRun.id, workflowForRun);
        } catch (queueError) {
          queueWarning = queueError.message || "工作流已创建，但完整剧本转换排队失败。";
        }
      } else if (workflowGeneratesTopics(workflowForRun)) {
        try {
          await queueWorkflowNode(savedRun.id, "topic", {
            workflowId,
            title: "选题生成",
            payload: workflowTopicQueuePayload(workflowForRun),
          });
        } catch (queueError) {
          queueWarning = queueError.message || "选题任务已创建，但排队生成失败。";
        }
      }
      setForm(emptyForm);
      setShowCreateForm(false);
      await loadWorkflowList();
      setLoadState(queueWarning ? "warning" : "ready");
      setMessage(queueWarning || (workflowRequiresVideoAnalysis(workflowForRun)
        ? "工作流已创建，视频将先解析，再自动进入选题生成。"
        : workflowUsesInputScript(workflowForRun)
          ? "工作流已创建，已跳过选题，完整剧本正在转换为后续文案格式。"
          : workflowGeneratesTopics(workflowForRun) ? "工作流已创建，选题生成已进入队列。" : "工作流已创建，自定义选题已可确认。"));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "工作流创建失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteWorkflow(workflow) {
    setActionDialog({
      tone: "danger",
      title: "删除工作流",
      summary: "删除后无法恢复，相关运行记录也会一起删除。",
      target: workflow.name,
      confirmText: "确认删除",
      onConfirm: () => confirmDeleteWorkflow(workflow),
    });
  }

  async function confirmDeleteWorkflow(workflow) {
    setBusyAction(`delete-workflow-${workflow.id}`);
    setLoadState("loading");
    setMessage("正在删除工作流...");
    try {
      await deleteWorkflow(workflow.id);
      if (selectedWorkflowId === workflow.id) setSelectedWorkflowId("");
      await loadWorkflowList();
      setLoadState("ready");
      setMessage("工作流已删除。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "工作流删除失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleManualRefresh(scope = "list") {
    setRefreshingScope(scope);
    await loadWorkflowList(() => true);
    setRefreshingScope("");
  }

  function openDeleteRunDialog(workflow, run) {
    const childRuns = (workflow.runs || []).filter((item) => item.parentRunId === run.id);
    const isMain = run.kind !== "topic-child";
    setActionDialog({
      tone: "danger",
      title: isMain ? "删除主任务" : "删除子任务",
      summary: isMain
        ? `将删除主任务 #${run.serial || run.id}，${childRuns.length} 个子任务会一并删除。`
        : `将删除子任务 #${run.serial || run.id}。`,
      target: workflowRunDeleteTarget(workflow, run),
      hint: "删除后任务会从当前列表移除，相关结果和节点状态也会一起隐藏。",
      confirmText: "确认删除",
      onConfirm: () => handleDeleteWorkflowRun(workflow, run),
    });
  }

  async function handleDeleteWorkflowRun(workflow, run) {
    const runIds = new Set([run.id, ...(workflow.runs || []).filter((item) => item.parentRunId === run.id).map((item) => item.id)]);
    setBusyAction(`delete-run-${run.id}`);
    setLoadState("loading");
    setMessage("正在删除任务...");
    try {
      for (const runId of runIds) {
        await updateWorkflowRun(runId, {
          status: "deleted",
          completedAt: new Date().toISOString(),
        });
      }
      await loadWorkflowList();
      setSelectedWorkflowId(workflow.id);
      setLoadState("ready");
      setMessage("任务已删除。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "任务删除失败。");
    } finally {
      setBusyAction("");
    }
  }

  function openRetryRunDialog(workflow, run) {
    const stage = failedWorkflowStage(run, workflow);
    if (!stage) return;
    const type = workflowRetryType(stage.id);
    const keys = apiKeysForService(referenceData.apiKeys, type);
    const defaultApiId = workflowRetryApiId(workflow, stage.id);
    const selectedApi = keys.find((key) => key.id === defaultApiId) || keys[0] || null;
    const models = workflowRetryModelOptions(type, selectedApi);
    const missingImageShots = stage.id === "image" ? workflowMissingImageShots(run) : [];
    setRetryDialog({
      workflowId: workflow.id,
      runId: run.id,
      stageId: stage.id,
      title: "重试节点",
      summary: stage.id === "image" && missingImageShots.length
        ? `即将只补生成任务 #${run.serial || run.id} 缺失的 ${missingImageShots.length} 张图片。`
        : `即将重试任务 #${run.serial || run.id} 的「${stage.name}」节点。`,
      hint: workflowRetryHint(stage.id),
      apiType: type,
      apiId: selectedApi?.id || "",
      modelId: workflowRetryModelId(workflow, stage.id, models),
      shotIds: missingImageShots.map(workflowShotId).filter(Boolean),
      missingImageCount: missingImageShots.length,
      ...(stage.id === "audio" ? {
        audioVoice: workflow.audioVoice || "",
        audioFormat: workflow.audioFormat || "mp3",
        audioEmotion: workflow.audioEmotion || "natural",
        audioBitrate: Number(workflow.audioBitrate || 128),
        audioSpeed: Number(workflow.audioSpeed || 1),
        audioVoicePresetId: workflow.audioVoicePresetId || "default",
        audioReferenceId: workflow.audioReferenceId || "",
        audioReferences: normalizeWorkflowAudioReferences(workflow.audioReferences),
      } : {}),
    });
  }

  async function handleRetryWorkflowRun(dialog) {
    const workflow = workflows.find((item) => item.id === dialog.workflowId);
    const summaryRun = workflow?.runs?.find((item) => item.id === dialog.runId);
    if (!workflow || !summaryRun) return;
    const stage = workflowStages.find((item) => item.id === dialog.stageId);
    if (!stage) return;
    setBusyAction(`retry-run-${summaryRun.id}`);
    setLoadState("loading");
    setMessage(`正在重试${stage.name}节点...`);
    try {
      const run = dialog.stageId === "audio"
        ? normalizeWorkflowRun((await getWorkflowRun(summaryRun.id))?.run || summaryRun)
        : summaryRun;
      const payload = workflowRetryPayload(workflow, dialog);
      const nextRunState = {
        status: "running",
        completedAt: "",
        stages: workflowStagesAfterRetry(run, dialog.stageId, workflow),
        ...(dialog.stageId === "source" ? {
          topicGenerationStatus: "pending",
          topicGenerationError: "",
        } : {}),
        error: "",
      };
      if (dialog.stageId === "audio") {
        const script = workflowRunFinalScript(run, workflow);
        if (!script) throw new Error("请先完成文案节点，再重试音频。");
        const audioResult = await generateAudio({
          apiKeyId: payload.audioKeyId,
          text: script,
          prompt: script,
          modelId: payload.audioModelId || payload.modelId,
          model: payload.audioModelId || payload.modelId,
          format: payload.format || "mp3",
          emotion: payload.emotion || "natural",
          bitrate: payload.bitrate || 128,
          speed: payload.speed || 1,
          voice: payload.voice || "",
          voicePresetId: payload.voicePresetId || "default",
          referenceId: payload.referenceId || "",
          references: payload.references || [],
          projectName: run.topic || workflow.name || "workflow-audio",
          taskType: "workflow-audio",
        });
        const audio = buildWorkflowAudioFromGeneratedResult(audioResult, script);
        if (!audio.audio_url) throw new Error("音频已生成，但没有返回可播放音频 URL。");
        const updatedRun = await updateWorkflowRun(run.id, {
          ...nextRunState,
          status: "waiting",
          stages: {
            ...nextRunState.stages,
            audio: "done",
          },
          result: workflowResultSnapshot(run, {
            audio,
            audioUrl: audio.audio_url,
            audioDuration: audio.duration,
            audioSegments: audio.segments,
            subtitleSrt: audio.subtitle_srt,
            timeline: workflowTimelineFromAudio(run, audio),
            audioStatus: "done",
            audioError: "",
          }),
          error: "",
        });
        if (updatedRun?.run) {
          setWorkflows((current) => current.map((item) => item.id === workflow.id ? {
            ...item,
            runs: item.runs.map((itemRun) => itemRun.id === run.id ? normalizeWorkflowRun(updatedRun.run) : itemRun),
          } : item));
        }
      } else {
        await queueWorkflowNode(run.id, dialog.stageId, {
          workflowId: workflow.id,
          title: `${stage.name}重试`,
          payload,
        });
        await updateWorkflowRun(run.id, nextRunState);
      }
      setRetryDialog(null);
      await loadWorkflowList();
      setSelectedWorkflowId(workflow.id);
      setLoadState("ready");
      setMessage(dialog.stageId === "audio" ? `${stage.name}节点已重新生成。` : `${stage.name}节点已重新进入队列。`);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "节点重试失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleUpdateWorkflow(workflow, nextConfig) {
    const name = nextConfig.name.trim();
    if (!name) {
      setLoadState("error");
      setMessage("请填写工作流名称。");
      return false;
    }
    const validationMessage = validateWorkflowConfigForSave({ ...nextConfig, name });
    if (validationMessage) {
      setLoadState("error");
      setMessage(validationMessage);
      return false;
    }

    setBusyAction(`update-workflow-${workflow.id}`);
    setLoadState("loading");
    setMessage(workflowUsesDirectVideo(nextConfig) && nextConfig.storyVideoFile ? "正在上传工作流视频..." : "正在保存工作流配置...");
    let preparedStoryVideo;
    try {
      preparedStoryVideo = await prepareWorkflowVideoSource(nextConfig, referenceData);
    } catch (error) {
      setBusyAction("");
      setLoadState("error");
      setMessage(error.message || "工作流视频准备失败。");
      return false;
    }

    const preparedConfig = {
      ...nextConfig,
      storyVideoSource: preparedStoryVideo.source,
      storyVideoScriptAsset: preparedStoryVideo.scriptAsset,
    };
    const {
      customTopicsText,
      customTopicItems,
      scriptPromptAssetId,
      storyVideoFile,
      storyVideoUrl,
      storyVideoDurationSeconds,
      storyVideoName,
      storyVideoError,
      storyVideoSaveToLibrary,
      storyVideoAnalysisLlmKeyId,
      storyVideoAnalysisModelId,
      storyVideoAnalysisConfigChanged,
      storyVideoScriptAsset,
      ...editableConfig
    } = preparedConfig;
    const isEcommerceWorkflow = editableConfig.type === "ecommerce";
    const storyboardWorkflow = isStoryboardWorkflow(editableConfig);
    const nextCustomTopicItems = storyboardWorkflow ? customTopicItemsForSave(customTopicItems, customTopicsText) : [];
    const nextCustomTopicTitles = storyboardWorkflow ? customTopicTitlesFromItems(nextCustomTopicItems) : stringListFromLines(customTopicsText);
    const visualStyle = workflowVisualStyleSnapshot(referenceData.visualStyles, editableConfig.visualStyleId);
    const ecommerceAssets = workflowEcommerceAssetSnapshot(referenceData, {
      ...editableConfig,
      storyVideoScriptAsset: preparedStoryVideo.scriptAsset,
    });
    const missingProductImages = isEcommerceWorkflow ? ecommerceProductAssetsMissingImages(ecommerceAssets.products) : [];
    if (missingProductImages.length) {
      setLoadState("error");
      setMessage("商品库缺少商品图，请先上传商品图后再保存工作流配置。");
      setBusyAction("");
      return false;
    }
    const config = workflowConfigForSave(workflow, {
      ...editableConfig,
      visualStyleName: visualStyle.name,
      visualStylePrompt: visualStyle.prompt,
      name,
      customTopics: storyboardWorkflow ? nextCustomTopicItems : nextCustomTopicTitles,
      topicAdaptations: storyboardWorkflow ? customTopicAdaptationsFromItems(nextCustomTopicItems) : {},
      imageSize: workflowImageRequestSize(editableConfig.ratio),
      topicCount: Number(nextConfig.topicCount || 5),
      topicOriginality: Number(nextConfig.topicOriginality ?? 50),
      inputScriptTitle: workflowUsesInputScript(editableConfig) ? String(editableConfig.inputScriptTitle || "").trim() : "",
      inputScript: workflowUsesInputScript(editableConfig) ? String(editableConfig.inputScript || "").trim() : "",
      inputScriptDurationMode: workflowUsesInputScript(editableConfig) ? normalizeInputScriptDurationMode(editableConfig.inputScriptDurationMode) : "smart",
      inputScriptTargetDurationSeconds: workflowUsesInputScript(editableConfig) && normalizeInputScriptDurationMode(editableConfig.inputScriptDurationMode) === "custom"
        ? normalizeInputScriptTargetDurationSeconds(editableConfig.inputScriptTargetDurationSeconds)
        : 0,
      inputScriptShotDurationSeconds: workflowUsesInputScript(editableConfig) ? 4.5 : 0,
      audienceProfile: storyboardWorkflow ? normalizeWorkflowAudienceProfile(editableConfig.audienceProfile) : "",
      storyEnvironment: storyboardWorkflow ? normalizeWorkflowStoryEnvironment(editableConfig.storyEnvironment) : "unspecified",
      endingInteractionEnabled: storyboardWorkflow && Boolean(editableConfig.endingInteractionEnabled),
      preferRoleLibraryNames: storyboardWorkflow && Boolean(editableConfig.roleAssetId) && Boolean(editableConfig.preferRoleLibraryNames),
      roleReferenceImageMode: normalizeRoleReferenceImageMode(editableConfig.roleReferenceImageMode, "default"),
      roleReferenceImageSelections: normalizeRoleReferenceImageSelections(editableConfig.roleReferenceImageSelections),
      storyVideoSource: preparedStoryVideo.source,
      scriptAssetId: workflowUsesInputScript(editableConfig)
        ? ""
        : workflowUsesDirectVideo(editableConfig) && preparedStoryVideo.source?.saveToScriptLibrary
          ? preparedStoryVideo.source.scriptAssetId || ""
          : editableConfig.scriptAssetId,
      hookAssetId: workflowSnapshotSingleAssetId(ecommerceAssets.hooks),
      elementAssetIds: workflowSnapshotAssetIds(ecommerceAssets.elements).slice(0, 3),
      productAssetId: isEcommerceWorkflow ? editableConfig.productAssetId : "",
      strengthenProduct: isEcommerceWorkflow && Boolean(editableConfig.strengthenProduct),
      purchaseGuidanceEnabled: isEcommerceWorkflow && Boolean(editableConfig.purchaseGuidanceEnabled),
      purchaseGuidanceText: isEcommerceWorkflow && editableConfig.purchaseGuidanceEnabled ? String(editableConfig.purchaseGuidanceText || "").trim() : "",
      ecommerceAssets,
      updatedAt: new Date().toISOString(),
    });

    setMessage("正在保存工作流配置...");
    try {
      await updateWorkflow(workflow.id, {
        name,
        type: nextConfig.type,
        config,
      });
      await loadWorkflowList();
      setLoadState("ready");
      setMessage("工作流配置已保存。");
      return true;
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "工作流配置保存失败。");
      return false;
    } finally {
      setBusyAction("");
    }
  }

  async function handleRerunWorkflow(workflow) {
    const seedRun = createTopicSeedRun(workflow);
    setBusyAction(`rerun-workflow-${workflow.id}`);
    setLoadState("loading");
    setMessage("正在创建新的主任务...");
    try {
      const savedRunResult = await createWorkflowRun(workflow.id, workflowRunPayload(seedRun));
      const savedRun = normalizeWorkflowRun(savedRunResult?.run || seedRun);
      let queueWarning = "";
      if (workflowRequiresVideoAnalysis(workflow)) {
        try {
          await queueWorkflowNode(savedRun.id, "source", {
            workflowId: workflow.id,
            title: "视频解析",
            payload: {
              topicPayload: workflowTopicQueuePayload(workflow),
            },
          });
        } catch (queueError) {
          queueWarning = queueError.message || "新的主任务已创建，但视频解析排队失败。";
        }
      } else if (workflowUsesInputScript(workflow)) {
        try {
          await queueInputScriptWorkflowRun(savedRun.id, workflow);
        } catch (queueError) {
          queueWarning = queueError.message || "新的主任务已创建，但完整剧本转换排队失败。";
        }
      } else if (workflowGeneratesTopics(workflow)) {
        try {
          await queueWorkflowNode(savedRun.id, "topic", {
            workflowId: workflow.id,
            title: "选题生成",
            payload: workflowTopicQueuePayload(workflow),
          });
        } catch (queueError) {
          queueWarning = queueError.message || "新的主任务已创建，但选题排队失败。";
        }
      }
      await loadWorkflowList();
      setSelectedWorkflowId(workflow.id);
      setLoadState(queueWarning ? "warning" : "ready");
      setMessage(queueWarning || (workflowRequiresVideoAnalysis(workflow)
        ? "新的主任务已创建，视频将先解析，再自动进入选题生成。"
        : workflowUsesInputScript(workflow)
          ? "新的主任务已创建，已跳过选题，完整剧本正在转换为后续文案格式。"
          : workflowGeneratesTopics(workflow) ? "新的主任务已创建，选题生成已进入队列。" : "新的主任务已创建，可继续确认自定义选题。"));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "再次运行失败。");
    } finally {
      setBusyAction("");
    }
  }

  function openWorkflowDetail(workflowId) {
    setSelectedWorkflowId(workflowId);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `/workflows?workflowId=${encodeURIComponent(workflowId)}`);
    }
  }

  function returnToWorkflowList() {
    setSelectedWorkflowId("");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/workflows");
    }
  }

  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId);
  const showWorkflowListLoading = loadState === "loading" || refreshingScope === "list";

  return (
    <div className="workflows-dashboard">
      {showCreateForm ? (
        <CreateWorkflowPanel
          form={form}
          referenceData={referenceData}
          saving={busyAction === "create-workflow"}
          message={message}
          messageState={loadState}
          onBack={() => setShowCreateForm(false)}
          onChange={updateForm}
          onSubmit={handleCreateWorkflow}
        />
      ) : !selectedWorkflow ? (
        <section className="workflow-panel-next workflow-list-panel-next">
          <div className="workflow-home-head-next">
            <div>
              <h2>工作流</h2>
              <p>管理你的工作流任务，进入单个任务后再查看运行记录和节点操作。</p>
            </div>
            <div className="workflow-home-actions-next">
              <button className={`secondary-action compact ${refreshingScope === "list" ? "loading" : loadState}`} type="button" disabled={refreshingScope === "list"} onClick={() => handleManualRefresh("list")}>
                {refreshingScope === "list" ? <span className="workflow-refresh-spinner-next" aria-hidden="true"></span> : "↻"} 刷新
              </button>
              <button className="primary-action compact" type="button" onClick={() => setShowCreateForm(true)}>
                + 新增工作流
              </button>
            </div>
          </div>

          {showWorkflowListLoading ? (
            <WorkflowPageLoading label={refreshingScope === "list" ? "正在刷新工作流" : "正在读取工作流"} />
          ) : (
            <>
              <section className="workflow-stats-next workflow-stats-compact-next" aria-label="工作流统计">
                <MetricCard label="总工作流" value={stats.total} />
                <MetricCard label="运行中" value={stats.running} />
                <MetricCard label="已完成" value={stats.completed} />
                <MetricCard label="任务总数" value={stats.runs} />
              </section>

              <div className="workflow-list-next">
                {workflows.length ? (
                  workflows.map((workflow) => (
                    <WorkflowCard
                      workflow={workflow}
                      deleting={busyAction === `delete-workflow-${workflow.id}`}
                      onOpen={() => openWorkflowDetail(workflow.id)}
                      onDelete={() => handleDeleteWorkflow(workflow)}
                      key={workflow.id}
                    />
                  ))
                ) : (
                  <article className="workflow-empty-next">
                    <strong>还没有工作流</strong>
                    <span>先创建一个工作流，后续可继续配置节点和查看任务记录。</span>
                  </article>
                )}
              </div>
            </>
          )}
          <p className={`workflow-sync-message-next ${loadState}`}>{message}</p>
        </section>
      ) : (
        <WorkflowDetailShell
          workflow={selectedWorkflow}
          referenceData={referenceData}
          saving={busyAction === `update-workflow-${selectedWorkflow.id}`}
          rerunning={busyAction === `rerun-workflow-${selectedWorkflow.id}`}
          refreshing={refreshingScope === "detail"}
          deletingRunId={busyAction.startsWith("delete-run-") ? busyAction.replace("delete-run-", "") : ""}
          retryingRunId={busyAction.startsWith("retry-run-") ? busyAction.replace("retry-run-", "") : ""}
          onRefresh={() => handleManualRefresh("detail")}
          onSave={(nextConfig) => handleUpdateWorkflow(selectedWorkflow, nextConfig)}
          onRerun={() => handleRerunWorkflow(selectedWorkflow)}
          onDeleteRun={(run) => openDeleteRunDialog(selectedWorkflow, run)}
          onRetryRun={(run) => openRetryRunDialog(selectedWorkflow, run)}
          onBack={returnToWorkflowList}
        />
      )}
      {actionDialog ? (
        <WorkflowActionDialog
          dialog={actionDialog}
          busy={Boolean(busyAction)}
          onClose={() => setActionDialog(null)}
          onConfirm={async () => {
            const action = actionDialog.onConfirm;
            setActionDialog(null);
            if (typeof action === "function") await action();
          }}
        />
      ) : null}
      {retryDialog ? (
        <WorkflowRetryDialog
          dialog={retryDialog}
          referenceData={referenceData}
          busy={busyAction === `retry-run-${retryDialog.runId}`}
          onChange={setRetryDialog}
          onClose={() => setRetryDialog(null)}
          onConfirm={handleRetryWorkflowRun}
        />
      ) : null}
    </div>
  );
}

function createTopicSeedRun(workflow) {
  const topicMode = normalizeWorkflowTopicMode(workflow.topicMode, workflow.type);
  const storyboardWorkflow = isStoryboardWorkflow(workflow);
  const topicGenerates = workflowGeneratesTopics(workflow);
  const waitsForVideo = workflowRequiresVideoAnalysis(workflow);
  const inputScriptMode = workflowUsesInputScript(workflow);
  const customTopicItems = storyboardWorkflow ? customTopicItemsForSave(workflow.customTopics) : [];
  const generatedTopics = !topicGenerates && topicMode === "custom"
    ? storyboardWorkflow
      ? customTopicTitlesFromItems(customTopicItems)
      : stringListFromLines(Array.isArray(workflow.customTopics) ? workflow.customTopics.join("\n") : "")
    : [];
  const topicAdaptations = topicMode === "custom" && storyboardWorkflow ? customTopicAdaptationsFromItems(customTopicItems) : {};
  const topicAdaptationBrief = topicMode === "custom" && storyboardWorkflow ? customTopicAdaptationBriefFromItems(customTopicItems) : "";
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    kind: "topic-seed",
    serial: randomRunSerial(),
    topic: inputScriptMode ? workflowInputScriptRunTitle(workflow) : workflow.topicInspiration || workflow.commentaryTrack || workflow.name,
    status: topicGenerates ? "running" : "waiting",
    createdAt: now,
    completedAt: topicGenerates ? "" : now,
    generatedTopics,
    selectedTopics: [],
    confirmedTopics: [],
    topicGenerationStatus: inputScriptMode ? "skipped" : waitsForVideo ? "pending" : topicGenerates ? "running" : "done",
    topicGenerationError: "",
    result: {
      workflowSnapshot: workflowSnapshotForRun(workflow),
      topicAdaptations,
      topicAdaptationBrief,
    },
    stages: Object.fromEntries(workflowStages.map((stage) => [stage.id, stage.id === "topic" ? (inputScriptMode ? "skipped" : waitsForVideo ? "pending" : topicGenerates ? "running" : "done") : "pending"])),
  };
}

function workflowGeneratesTopics(workflow = {}) {
  if (workflowUsesInputScript(workflow)) return false;
  return workflow.topicMode !== "custom" || isStoryboardWorkflow(workflow);
}

function workflowInputScriptRunTitle(workflow = {}) {
  return String(workflow.inputScriptTitle || "").trim() || "AI 生成剧本标题";
}

async function queueInputScriptWorkflowRun(runId, workflow = {}) {
  const confirmation = await confirmWorkflowTopics(runId, {
    topics: [workflowInputScriptRunTitle(workflow)],
    autoQueueScript: false,
  });
  const childIds = (confirmation.children || []).map((child) => child?.id).filter(Boolean);
  if (!childIds.length) throw new Error("完整剧本任务创建失败，请重试。");
  await executeWorkflowTopics(runId, { childIds });
}

function workflowTopicQueuePayload(workflow = {}) {
  return {
    topicIdea: workflow.topicInspiration || "",
    topicOriginality: workflow.topicOriginality ?? 50,
    niche: workflow.commentaryTrack || "",
    count: workflowTopicGenerationCount(workflow),
  };
}

function workflowTopicGenerationCount(workflow = {}) {
  if (isStoryboardWorkflow(workflow) && workflow.topicMode === "custom") {
    return customTopicItemsForSave(workflow.customTopics).length || 1;
  }
  return workflow.topicCount || 1;
}

function workflowSnapshotForRun(workflow = {}) {
  const {
    runs,
    children,
    userId,
    storedOnServer,
    ...snapshot
  } = workflow;
  return snapshot;
}

function workflowRunPayload(run) {
  const {
    children,
    storedOnServer,
    result: existingResult = {},
    scriptOutput,
    scriptError,
    scriptTranslation,
    scriptTranslationStatus,
    scriptTranslationError,
    scriptTranslationLanguage,
    shotOutput,
    shotError,
    shots,
    videoTimeline,
    videoPackage,
    backendJobs,
    ...base
  } = run;
  return {
    ...base,
    result: {
      ...existingResult,
      scriptOutput,
      scriptError,
      scriptTranslation,
      scriptTranslationStatus,
      scriptTranslationError,
      scriptTranslationLanguage,
      shotOutput,
      shotError,
      shots,
      videoTimeline,
      videoPackage,
      backendJobs,
    },
  };
}

function workflowHasLiveRun(workflow) {
  return (workflow.runs || []).some((run) => {
    const backendJobs = run.backendJobs && typeof run.backendJobs === "object" ? Object.values(run.backendJobs) : [];
    return (
      ["running", "queued"].includes(run.status)
      || run.topicGenerationStatus === "running"
      || Object.values(run.stages || {}).some((status) => ["running", "queued"].includes(status))
      || backendJobs.some((job) => ["running", "queued"].includes(job?.status))
    );
  });
}

function saveWorkflowReturnSnapshot(workflow) {
  if (typeof window === "undefined" || !workflow?.id) return;
  try {
    window.sessionStorage.setItem(workflowReturnSnapshotKey, JSON.stringify({
      workflowId: workflow.id,
      savedAt: Date.now(),
      workflow,
    }));
  } catch {
    // Returning still works through the regular loading path when storage is unavailable.
  }
}

function readWorkflowReturnSnapshot(workflowId) {
  if (typeof window === "undefined" || !workflowId) return null;
  try {
    const raw = window.sessionStorage.getItem(workflowReturnSnapshotKey);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    if (snapshot?.workflowId !== workflowId || snapshot?.workflow?.id !== workflowId) return null;
    if (!Number.isFinite(snapshot.savedAt) || Date.now() - snapshot.savedAt > workflowReturnSnapshotMaxAgeMs) return null;
    return snapshot.workflow;
  } catch {
    return null;
  }
}

function clearWorkflowReturnSnapshot() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(workflowReturnSnapshotKey);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function randomRunSerial() {
  return Math.floor(1000 + Math.random() * 9000);
}

async function loadWorkflowReferences() {
  const [apiResult, promptResult, writingResult, visualResult, scriptResult, roleResult, hookResult, elementResult, productResult] = await settleWorkflowReferenceTasks([
    () => listApiKeys(),
    () => listAssets("prompt"),
    () => listAssets("writing-style"),
    () => listAssets("visual-style"),
    () => listAssets("script"),
    () => listAssets("role"),
    () => listAssets("hook"),
    () => listAssets("element"),
    () => listAssets("product"),
  ]);

  return {
    apiKeys: apiResult.status === "fulfilled" && Array.isArray(apiResult.value?.apiKeys) ? apiResult.value.apiKeys : [],
    prompts: promptResult.status === "fulfilled" ? workflowPromptAssetsFromResult(promptResult.value) : [],
    writingStyles: writingResult.status === "fulfilled" && Array.isArray(writingResult.value?.assets) ? writingResult.value.assets : [],
    visualStyles: mergeWorkflowVisualStyles(visualResult.status === "fulfilled" && Array.isArray(visualResult.value?.assets) ? visualResult.value.assets : []),
    scripts: scriptResult.status === "fulfilled" ? workflowAssetsFromResult(scriptResult.value) : [],
    roles: roleResult.status === "fulfilled" ? workflowAssetsFromResult(roleResult.value) : [],
    hooks: hookResult.status === "fulfilled" ? workflowAssetsFromResult(hookResult.value) : [],
    elements: elementResult.status === "fulfilled" ? workflowAssetsFromResult(elementResult.value) : [],
    products: productResult.status === "fulfilled" ? workflowAssetsFromResult(productResult.value) : [],
  };
}

async function settleWorkflowReferenceTasks(tasks, concurrency = 3) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function MetricCard({ label, value }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function CreateWorkflowPanel({ form, referenceData, saving, message, messageState, onBack, onChange, onSubmit }) {
  const llmKeys = apiKeysForService(referenceData.apiKeys, "llm");
  const imageKeys = apiKeysForService(referenceData.apiKeys, "image");
  const audioKeys = apiKeysForService(referenceData.apiKeys, "audio");
  const llmModels = workflowLlmModelOptions(llmKeys.find((key) => key.id === form.llmKeyId));
  const topicModels = workflowLlmModelOptions(llmKeys.find((key) => key.id === form.topicLlmKeyId));
  const imageModels = workflowImageModelOptions(imageKeys.find((key) => key.id === form.imageKeyId));
  const audioModels = workflowAudioModelOptions(audioKeys.find((key) => key.id === form.audioKeyId));
  const activeImageModel = imageModels.find((model) => model.id === form.imageModelId) || imageModels[0];
  const imageResolutionOptions = activeImageModel?.resolutions || [];
  const imageRatioOptions = workflowImageRatioOptions(activeImageModel);
  const promptOptions = workflowPromptOptions(referenceData.prompts);
  const visualStyleOptions = workflowVisualStyleOptions(referenceData.visualStyles);
  const showScriptedWorkflow = ["explain", "ecommerce", "story"].includes(form.type);
  const isEcommerceWorkflow = form.type === "ecommerce";
  const storyboardWorkflow = isStoryboardWorkflow(form);
  const customTopicCount = storyboardWorkflow
    ? customTopicItemsForSave(form.customTopicItems, form.customTopicsText).length
    : stringListFromLines(form.customTopicsText).length;
  const topicModelFields = (
    <div className="workflow-control-row-next">
      <label>
        选题 LLM 渠道
        <select value={form.topicLlmKeyId} onChange={(event) => onChange("topicLlmKeyId", event.target.value)}>
          <WorkflowOptionPlaceholder label="请选择选题渠道..." />
          {llmKeys.map((key) => (
            <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
          ))}
        </select>
      </label>
      <label>
        生成模型
        <select value={form.topicModelId} onChange={(event) => onChange("topicModelId", event.target.value)}>
          <WorkflowModelOptions models={topicModels} emptyLabel="请先选择选题渠道" />
        </select>
      </label>
    </div>
  );

  return (
    <section className="workflow-panel-next workflow-create-panel-next">
      <div className="workflow-create-head-next">
        <button className="secondary-action compact" type="button" onClick={onBack}>
          ← 返回
        </button>
        <div>
          <h2>创建工作流</h2>
          <p>选择一种创作模式，开始你的 AI 视频创作之旅。</p>
        </div>
      </div>

      <form className="workflow-create-form-next legacy" onSubmit={onSubmit}>
        <div className="workflow-type-tabs-next" role="tablist" aria-label="工作流类型">
          {workflowTypes.map((type) => (
            <button className={form.type === type.id ? "selected" : ""} type="button" onClick={() => onChange("type", type.id)} key={type.id}>
              {type.label}
            </button>
          ))}
        </div>

        <section className="workflow-form-card-next">
          <h3>基础信息</h3>
          <div className="workflow-control-row-next">
            <label>
              工作流名称 *
              <input value={form.name} onChange={(event) => onChange("name", event.target.value)} placeholder="为你的创作起个名字..." />
            </label>
            <label>
              LLM 渠道 *
              <select value={form.llmKeyId} onChange={(event) => onChange("llmKeyId", event.target.value)}>
                <WorkflowOptionPlaceholder label="请选择 LLM 渠道..." />
                {llmKeys.map((key) => (
                  <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="workflow-form-card-next">
          <span className="workflow-step-index-next">01</span>
          <h3>选题配置</h3>
          <div className={`workflow-segmented-next ${isEcommerceWorkflow ? "three" : ""}`}>
            <button className={form.topicMode === "ai" ? "selected" : ""} type="button" onClick={() => onChange("topicMode", "ai")}>AI 生成</button>
            <button className={form.topicMode === "custom" ? "selected" : ""} type="button" onClick={() => onChange("topicMode", "custom")}>自定义</button>
            {isEcommerceWorkflow ? (
              <button className={form.topicMode === "script" ? "selected" : ""} type="button" onClick={() => onChange("topicMode", "script")}>输入剧本</button>
            ) : null}
          </div>
          {workflowUsesInputScript(form) ? (
            <WorkflowInputScriptEditor
              title={form.inputScriptTitle}
              value={form.inputScript}
              durationMode={form.inputScriptDurationMode}
              targetDurationSeconds={form.inputScriptTargetDurationSeconds}
              onTitleChange={(nextValue) => onChange("inputScriptTitle", nextValue)}
              onChange={(nextValue) => onChange("inputScript", nextValue)}
              onDurationModeChange={(nextValue) => onChange("inputScriptDurationMode", nextValue)}
              onTargetDurationChange={(nextValue) => onChange("inputScriptTargetDurationSeconds", nextValue)}
            />
          ) : form.topicMode === "custom" ? (
            <div className="workflow-topic-config-next">
              <div className="workflow-card-toolbar-next">
                <div>
                  <strong>{storyboardWorkflow ? "自定义改编思路" : "自定义选题"}</strong>
                  <p>{storyboardWorkflow ? "模型会读取这些改编思路生成选题大纲，保存后进入待确认选题流程。" : "每行一个选题，保存后会作为待确认选题进入工作流。"}</p>
                </div>
                <span>已添加 {customTopicCount} {storyboardWorkflow ? "条改编思路" : "个选题"}</span>
              </div>
              {storyboardWorkflow ? (
                <>
                  <CustomTopicItemsEditor value={form.customTopicItems} onChange={(items) => onChange("customTopicItems", items)} />
                  {topicModelFields}
                </>
              ) : (
                <textarea value={form.customTopicsText} onChange={(event) => onChange("customTopicsText", event.target.value)} rows={5} placeholder="输入一个选题标题..." />
              )}
            </div>
          ) : (
            <div className="workflow-topic-config-next">
              {storyboardWorkflow ? (
                <div className="workflow-topic-count-row-next">
                  <label>
                    原创度
                    <input type="range" min="0" max="100" value={form.topicOriginality ?? 50} onChange={(event) => onChange("topicOriginality", event.target.value)} />
                  </label>
                  <strong>{form.topicOriginality ?? 50}%</strong>
                </div>
              ) : (
                <label>
                  选题灵感
                  <textarea value={form.topicInspiration} onChange={(event) => onChange("topicInspiration", event.target.value)} rows={4} placeholder="输入爆款标题、热点方向、账号选题灵感或想拆解的内容角度..." />
                </label>
              )}
              {!storyboardWorkflow ? (
                <label>
                  解说赛道
                  <input value={form.commentaryTrack} onChange={(event) => onChange("commentaryTrack", event.target.value)} placeholder="例如：历史冷知识、商业案例、影视解说、科技科普" />
                </label>
              ) : null}
              <div className="workflow-topic-count-row-next">
                <label>
                  选题数量
                  <input type="range" min="1" max="20" value={form.topicCount} onChange={(event) => onChange("topicCount", event.target.value)} />
                </label>
                <strong>{form.topicCount}</strong>
              </div>
              {topicModelFields}
            </div>
          )}
        </section>

        {storyboardWorkflow ? (
          <>
            <EcommerceAssetConfig
              value={form}
              referenceData={referenceData}
              onChange={onChange}
              definitions={workflowAssetDefinitionsForType(form.type, form.topicMode)}
            />
            <WorkflowRoleReferenceConfig
              value={form}
              referenceData={referenceData}
              onChange={onChange}
            />
          </>
        ) : null}

        {showScriptedWorkflow ? (
          <>
            <section className="workflow-form-card-next">
              <span className="workflow-step-index-next">02</span>
              <h3>文案创意配置</h3>
              <label>
                第一步模型（文案创意）*
                <select value={form.storyModelId} onChange={(event) => onChange("storyModelId", event.target.value)}>
                  <WorkflowModelOptions models={llmModels} emptyLabel="请先选择支持的 LLM 渠道" />
                </select>
              </label>
              {storyboardWorkflow ? (
                <WorkflowStoryboardCopyConfig value={form} onChange={onChange} />
              ) : !isEcommerceWorkflow ? (
                <>
                  <div className="workflow-control-row-next">
                    <WorkflowLanguageSelect
                      label="文案语言 *"
                      placeholder="请选择文案语言"
                      value={form.language}
                      options={explainWorkflowLanguageOptions}
                      onChange={(value) => onChange("language", value)}
                    />
                    <label>
                      写作风格
                      <select value={form.writingStyleId} onChange={(event) => onChange("writingStyleId", event.target.value)}>
                        <option value="">不指定</option>
                        {referenceData.writingStyles.map((style) => (
                          <option value={style.id} key={style.id}>{style.name || style.title || "未命名文风"}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    从提示词库导入
                    <div className="workflow-inline-import-next">
                      <select value={form.scriptPromptAssetId} onChange={(event) => onChange("scriptPromptAssetId", event.target.value)}>
                        <WorkflowPromptOptions prompts={promptOptions} />
                      </select>
                      <button
                        className="secondary-action compact"
                        type="button"
                        disabled={!form.scriptPromptAssetId}
                        onClick={() => onChange("scriptPrompt", workflowPromptText(promptOptions, form.scriptPromptAssetId))}
                      >
                        导入
                      </button>
                    </div>
                  </label>
                  <label>
                    文案提示词
                    <textarea value={form.scriptPrompt} onChange={(event) => onChange("scriptPrompt", event.target.value)} rows={4} placeholder="可选：补充文案长度、结构、语气、禁用表达或账号要求..." />
                  </label>
                </>
              ) : null}
            </section>

            {!storyboardWorkflow ? (
              <section className="workflow-form-card-next">
                <span className="workflow-step-index-next">03</span>
                <h3>口播音频配置</h3>
                <WorkflowAudioConfigFields value={form} audioKeys={audioKeys} audioModels={audioModels} onChange={onChange} />
              </section>
            ) : null}

            <section className="workflow-form-card-next">
              <span className="workflow-step-index-next">04</span>
              <h3>分镜生成配置</h3>
              <label>
                第二步模型（分镜生成）*
                <select value={form.shotModelId} onChange={(event) => onChange("shotModelId", event.target.value)}>
                  <WorkflowModelOptions models={llmModels} emptyLabel="请先选择支持的 LLM 渠道" />
                </select>
              </label>
              <div>
                <div className="field-label">分镜风格预设</div>
                <div className="workflow-option-card-grid-next">
                  {visualStyleOptions.length ? visualStyleOptions.slice(0, 4).map((style) => (
                    <button className={form.visualStyleId === style.id ? "selected" : ""} type="button" onClick={() => onChange("visualStyleId", style.id)} key={style.id}>
                      <strong>{style.name || style.title || "未命名图风"}</strong>
                      <small>{style.desc || style.description || "使用该图风生成分镜视觉提示。"}</small>
                    </button>
                  )) : (
                    <span className="workflow-field-help-next">暂无图风库，可先保存基础工作流。</span>
                  )}
                </div>
              </div>
            </section>

            <section className="workflow-form-card-next">
              <span className="workflow-step-index-next">06</span>
              <h3>绘画生成配置</h3>
              <div className="workflow-control-row-next">
                <label>
                  图片渠道 *
                  <select value={form.imageKeyId} onChange={(event) => onChange("imageKeyId", event.target.value)}>
                    <WorkflowOptionPlaceholder label="请选择图片渠道..." />
                    {imageKeys.map((key) => (
                      <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  图片生成模型 *
                  <select value={form.imageModelId} onChange={(event) => onChange("imageModelId", event.target.value)}>
                    <WorkflowModelOptions models={imageModels} emptyLabel="请先选择图片渠道" />
                  </select>
                </label>
              </div>
              <div>
                <div className="field-label">图片分辨率 *</div>
                <div className="workflow-option-stepper-next">
                  {imageResolutionOptions.length ? imageResolutionOptions.map((resolution) => (
                    <button className={form.imageResolution === resolution ? "selected" : ""} type="button" onClick={() => onChange("imageResolution", resolution)} key={resolution}>{resolution}</button>
                  )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
                </div>
              </div>
              <div>
                <div className="field-label">图片比例 *</div>
                <div className="workflow-ratio-grid-next">
                  {imageRatioOptions.length ? imageRatioOptions.map((ratio) => (
                    <button className={form.ratio === ratio.value ? "selected" : ""} type="button" onClick={() => onChange("ratio", ratio.value)} key={ratio.value}>
                      {ratio.label}<small>{ratio.detail || ratio.value}</small>
                    </button>
                  )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
                </div>
              </div>
            </section>
          </>
        ) : null}

        <section className="workflow-form-card-next">
          <h3>创作配置</h3>
          <div className="workflow-option-card-grid-next three">
            {workflowExecutionOptions.map((option) => (
              <button className={form.executionStep === option.id ? "selected" : ""} type="button" onClick={() => onChange("executionStep", option.id)} key={option.id}>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="workflow-form-card-next">
          <h3>运行设置</h3>
          <WorkflowFormNotice state={messageState} message={message} />
          <div className="workflow-create-run-row-next">
            <span>将按选题配置创建工作流任务</span>
            <button className="primary-action compact" type="submit" disabled={saving}>
              {saving ? "保存中..." : "保存工作流"}
            </button>
          </div>
        </section>
      </form>
    </section>
  );
}

function WorkflowFormNotice({ state = "", message = "" }) {
  if (state !== "error" || !message) return null;
  return (
    <p className="workflow-form-notice-next error" role="alert">
      {message}
    </p>
  );
}

function CustomTopicItemsEditor({ value, onChange, compact = false }) {
  const items = editableCustomTopicItems(value);

  function updateItem(index, key, nextValue) {
    onChange(items.map((item, itemIndex) => (
      itemIndex === index ? { ...item, [key]: nextValue } : item
    )));
  }

  function addItem() {
    onChange([...items, emptyCustomTopicItem()]);
  }

  function removeItem(index) {
    const nextItems = items.filter((item, itemIndex) => itemIndex !== index);
    onChange(nextItems.length ? nextItems : [emptyCustomTopicItem()]);
  }

  return (
    <div className={`workflow-custom-topic-items-next ${compact ? "compact" : ""}`}>
      {items.map((item, index) => (
        <article className="workflow-custom-topic-item-next" key={`custom-topic-${index}`}>
          <div className="workflow-custom-topic-item-head-next">
            <span>{String(index + 1).padStart(2, "0")}</span>
            <button
              className="workflow-topic-remove-next"
              type="button"
              disabled={items.length <= 1 && !item.title && !item.adaptation}
              onClick={() => removeItem(index)}
              aria-label={`删除第 ${index + 1} 个自定义选题`}
            >
              ×
            </button>
          </div>
          <label>
            改编思路
            <textarea
              value={item.adaptation}
              onChange={(event) => updateItem(index, "adaptation", event.target.value)}
              rows={2}
              placeholder="例如：对标视频里的男女角色互换，情侣关系改成同事关系，保留误会-反转-种草结构。"
            />
          </label>
        </article>
      ))}
      <button className="secondary-action compact workflow-topic-add-next" type="button" onClick={addItem}>
        + 添加思路
      </button>
    </div>
  );
}

function WorkflowInputScriptEditor({
  title = "",
  value = "",
  durationMode = "smart",
  targetDurationSeconds = "",
  onTitleChange,
  onChange,
  onDurationModeChange,
  onTargetDurationChange,
  compact = false,
}) {
  const script = String(value || "");
  const normalizedDurationMode = normalizeInputScriptDurationMode(durationMode);
  const targetSeconds = normalizeInputScriptTargetDurationSeconds(targetDurationSeconds);
  const targetShotPlan = inputScriptTargetShotPlan(targetSeconds);
  return (
    <div className={`workflow-topic-config-next workflow-input-script-next ${compact ? "compact" : ""}`}>
      <div className="workflow-card-toolbar-next">
        <div>
          <strong>完整故事剧本</strong>
        </div>
        <span>{script.trim().length} 字</span>
      </div>
      <label>
        剧本标题
        <input
          value={title}
          onChange={(event) => onTitleChange?.(event.target.value)}
          placeholder="可选；留空时由 AI 根据剧本内容生成"
        />
      </label>
      <label>
        剧本内容 *
        <textarea
          value={script}
          onChange={(event) => onChange(event.target.value)}
          rows={compact ? 10 : 16}
          placeholder={`请粘贴完整剧本，例如：\n\n场景一：客厅 / 日\n妈妈端起已经凉掉的水杯。\n妈妈：怎么一会儿就凉了？\n\n……\n\n带货段落：角色自然引出商品、卖点和产品文案。`}
        />
      </label>
      <section className="workflow-input-duration-next">
        <div className="workflow-card-toolbar-next">
          <div>
            <strong>目标时长</strong>
            <p>故事主线、人物关系、关键冲突和结局会完整保留。</p>
          </div>
        </div>
        <div className="workflow-segmented-next">
          <button className={normalizedDurationMode === "smart" ? "selected" : ""} type="button" onClick={() => onDurationModeChange?.("smart")}>智能适配</button>
          <button className={normalizedDurationMode === "custom" ? "selected" : ""} type="button" onClick={() => onDurationModeChange?.("custom")}>指定时长</button>
        </div>
        {normalizedDurationMode === "custom" ? (
          <label>
            目标时长（秒）*
            <input
              type="number"
              min="4"
              step="1"
              inputMode="numeric"
              value={targetDurationSeconds}
              onChange={(event) => onTargetDurationChange?.(event.target.value)}
              placeholder="例如：600秒"
            />
            <span className="workflow-field-help-next">{targetShotPlan.recommended ? `预计约 ${targetShotPlan.recommended} 镜（可在 ${targetShotPlan.min}–${targetShotPlan.max} 镜内弹性规划）；AI 会根据目标容量精简或扩展表达，剧情完整性优先。` : "请输入不少于 4 秒的目标时长。"}</span>
          </label>
        ) : (
          <span className="workflow-field-help-next">AI 会根据信息量决定镜头数量；除商品适配必须改写的对白外，其余对白逐字保留。剧本越长，最终镜头和预计时长越多。</span>
        )}
      </section>
      <span className="workflow-field-help-next">所选商品是唯一带货主体；系统会保留故事主线，并把原剧本中的旧商品相关动作、对白和卖点适配为商品库资料。</span>
    </div>
  );
}

const workflowExecutionOptions = [
  { id: "story", label: "仅第一步", detail: "仅生成脚本" },
  { id: "shot", label: "到第二步", detail: "生成分镜" },
  { id: "all", label: "全部完成", detail: "生成图片" },
];

function WorkflowOptionPlaceholder({ label }) {
  return <option value="">{label}</option>;
}

function WorkflowLanguageSelect({ label, placeholder, value, options, onChange }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <WorkflowOptionPlaceholder label={placeholder} />
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function WorkflowOptionToggle({ checked, disabled = false, title, description, onChange }) {
  return (
    <label className="workflow-option-toggle-next">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{title}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}

function WorkflowStoryboardCopyConfig({ value, onChange }) {
  return (
    <>
      <div className="workflow-control-row-next">
        <WorkflowLanguageSelect
          label="对白语言 *"
          placeholder="请选择对白语言"
          value={value.language}
          options={workflowLanguageOptions}
          onChange={(language) => onChange("language", language)}
        />
        <label>
          用户画像
          <select value={normalizeWorkflowAudienceProfile(value.audienceProfile)} onChange={(event) => onChange("audienceProfile", event.target.value)}>
            {workflowAudienceProfileOptions.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        剧情环境
        <select value={normalizeWorkflowStoryEnvironment(value.storyEnvironment)} onChange={(event) => onChange("storyEnvironment", event.target.value)}>
          {workflowStoryEnvironmentOptions.map((option) => (
            <option value={option.value} key={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <WorkflowOptionToggle
        checked={Boolean(value.endingInteractionEnabled)}
        title="结尾互动"
        description="结尾加入正能量的向观众发问，引导用户在评论区打字评论。"
        onChange={(checked) => onChange("endingInteractionEnabled", checked)}
      />
    </>
  );
}

function validateWorkflowConfigForSave(config) {
  if (config.type === "explain" && !workflowLanguageOptionExists(config.language, explainWorkflowLanguageOptions)) {
    return "请选择文案语言。";
  }
  if (isStoryboardWorkflow(config) && !workflowLanguageOptionExists(config.language, workflowLanguageOptions)) {
    return "请选择对白语言。";
  }
  const storyboardWorkflow = isStoryboardWorkflow(config);
  const inputScriptMode = workflowUsesInputScript(config);
  const needsTopicModel = !inputScriptMode && (config.topicMode !== "custom" || storyboardWorkflow);
  const customTopicCount = storyboardWorkflow
    ? customTopicItemsForSave(config.customTopicItems, config.customTopicsText).length
    : stringListFromLines(config.customTopicsText).length;
  if (config.topicMode === "custom" && !customTopicCount) {
    return storyboardWorkflow ? "请至少添加一条自定义改编思路。" : "请至少添加一个自定义选题。";
  }
  if (inputScriptMode && !String(config.inputScript || "").trim()) {
    return "请粘贴完整故事剧本。";
  }
  if (inputScriptMode && !String(config.productAssetId || "").trim()) {
    return "请选择商品库中的带货产品。";
  }
  if (inputScriptMode && normalizeInputScriptDurationMode(config.inputScriptDurationMode) === "custom" && normalizeInputScriptTargetDurationSeconds(config.inputScriptTargetDurationSeconds) < 4) {
    return "请输入不少于 4 秒的目标时长。";
  }
  if (isEcommerceWorkflow(config) && config.purchaseGuidanceEnabled && !String(config.purchaseGuidanceText || "").trim()) {
    return "请填写购买引导内容。";
  }
  if (needsTopicModel && !String(config.topicLlmKeyId || "").trim()) {
    return "请选择选题 LLM 渠道。";
  }
  if (needsTopicModel && !String(config.topicModelId || "").trim()) {
    return "请选择选题生成模型。";
  }
  if (workflowUsesDirectVideo(config)) {
    const sourceMode = config.storyVideoSourceMode === "youtube" ? "youtube" : "upload";
    const hasExistingSource = Boolean(config.storyVideoSource?.sourceFile?.fileUrl);
    if (sourceMode === "youtube" && !normalizeYoutubeVideoUrl(config.storyVideoUrl || config.storyVideoSource?.sourceFile?.sourceUrl || config.storyVideoSource?.sourceFile?.fileUrl)) {
      return "请输入有效的公开 YouTube 视频链接。";
    }
    if (sourceMode === "upload" && !config.storyVideoFile && !hasExistingSource) {
      return "请选择要解析的本地视频。";
    }
    if (config.storyVideoFile?.size > storyVideoAnalysisMaxBytes) {
      return "请上传 20M 以内的视频。";
    }
    if (!String(config.storyVideoAnalysisLlmKeyId || config.llmKeyId || "").trim()) {
      return "请选择视频分析 LLM 渠道。";
    }
    if (String(config.storyVideoAnalysisModelId || "").trim() !== videoAnalysisModelId) {
      return `视频解析仅支持 ${videoAnalysisModelId} 模型。`;
    }
  }
  return "";
}

function WorkflowModelOptions({ models, emptyLabel }) {
  if (!models.length) return <option value="">{emptyLabel}</option>;
  return models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>);
}

function WorkflowAudioConfigFields({ value, audioKeys, audioModels, onChange }) {
  const references = normalizeWorkflowAudioReferences(value.audioReferences);
  const voiceMode = value.audioVoicePresetId || "default";

  async function handleReferenceFiles(files) {
    const slots = Math.max(0, 5 - references.length);
    const selected = Array.from(files || [])
      .filter((file) => file.type.startsWith("audio/"))
      .slice(0, slots);
    if (!selected.length) return;
    const nextReferences = [];
    for (const file of selected) {
      nextReferences.push({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        dataUrl: await fileToDataUrl(file),
        transcript: "",
      });
    }
    onChange("audioReferences", [...references, ...nextReferences]);
  }

  function updateReference(id, patch) {
    onChange("audioReferences", references.map((reference) => (
      reference.id === id ? { ...reference, ...patch } : reference
    )));
  }

  function removeReference(id) {
    onChange("audioReferences", references.filter((reference) => reference.id !== id));
  }

  return (
    <div className="workflow-audio-config-next">
      <div className="workflow-control-row-next">
        <label>
          音频渠道
          <select value={value.audioKeyId} onChange={(event) => onChange("audioKeyId", event.target.value)}>
            <WorkflowOptionPlaceholder label="请选择音频渠道..." />
            {audioKeys.map((key) => (
              <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
            ))}
          </select>
        </label>
        <label>
          音频模型
          <select value={value.audioModelId} onChange={(event) => onChange("audioModelId", event.target.value)} disabled={!value.audioKeyId}>
            <WorkflowModelOptions models={audioModels} emptyLabel="请先选择音频渠道" />
          </select>
        </label>
      </div>
      <div className="workflow-control-row-next">
        <label>
          输出格式
          <select value={value.audioFormat || "mp3"} onChange={(event) => onChange("audioFormat", event.target.value)}>
            {workflowAudioFormats.map((format) => (
              <option value={format} key={format}>{format.toUpperCase()}</option>
            ))}
          </select>
        </label>
        <label>
          情绪
          <select value={value.audioEmotion || "natural"} onChange={(event) => onChange("audioEmotion", event.target.value)}>
            {workflowAudioEmotions.map((emotion) => (
              <option value={emotion.value} key={emotion.value}>{emotion.label}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        语速
        <div className="workflow-slider-row-next">
          <input type="range" min="0.5" max="2" step="0.1" value={value.audioSpeed || 1} onChange={(event) => onChange("audioSpeed", Number(event.target.value))} />
          <span>{Number(value.audioSpeed || 1).toFixed(1)}x</span>
        </div>
      </label>
      <div className="workflow-control-row-next">
        <label>
          音色模式
          <select value={voiceMode} onChange={(event) => onChange("audioVoicePresetId", event.target.value)}>
            {workflowAudioVoiceModes.map((mode) => (
              <option value={mode.id} key={mode.id}>{mode.name}</option>
            ))}
          </select>
        </label>
        {voiceMode !== "saved" ? (
          <label>
            兼容音色
            <input value={value.audioVoice || ""} onChange={(event) => onChange("audioVoice", event.target.value)} placeholder="例如 alloy、nova，可留空" />
          </label>
        ) : null}
      </div>
      {voiceMode === "saved" ? (
        <SavedAudioVoicePicker
          value={value.audioReferenceId || ""}
          onChange={(referenceId) => onChange("audioReferenceId", referenceId)}
        />
      ) : null}
      <span className="workflow-field-help-next">
        {workflowAudioVoiceModes.find((mode) => mode.id === voiceMode)?.description || "配置口播音色。"}
      </span>
      {voiceMode === "clone" ? (
        <div className="workflow-audio-reference-next">
          <div className="workflow-card-toolbar-next">
            <div>
              <strong>参考音频</strong>
              <p>建议上传 10-30 秒清晰单人声，最多 5 条。</p>
            </div>
            <label className="secondary-action compact workflow-audio-upload-next">
              上传参考音频
              <input type="file" accept="audio/*,.mp3,.wav,.m4a,.opus" multiple onChange={(event) => handleReferenceFiles(event.target.files)} />
            </label>
          </div>
          {references.length ? (
            <div className="audio-reference-list-next">
              {references.map((reference) => (
                <article className="audio-reference-item-next" key={reference.id}>
                  <div>
                    <strong>{reference.name || "参考音频"}</strong>
                    <button type="button" onClick={() => removeReference(reference.id)}>删除</button>
                  </div>
                  <audio src={reference.dataUrl} controls />
                  <input value={reference.transcript || ""} onChange={(event) => updateReference(reference.id, { transcript: event.target.value })} placeholder="参考音频对应文字，可选但建议填写" />
                </article>
              ))}
            </div>
          ) : (
            <span className="workflow-field-help-next">选择克隆音色后，请上传至少 1 条参考音频。</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowPromptOptions({ prompts }) {
  if (!prompts.length) return <option value="">暂无可导入提示词</option>;
  return (
    <>
      <option value="">选择提示词</option>
      {prompts.map((prompt) => (
        <option value={prompt.id} key={prompt.id}>{prompt.name}</option>
      ))}
    </>
  );
}

function EcommerceAssetConfig({ value, referenceData, onChange, definitions = ecommerceAssetDefinitions }) {
  const storyboardWorkflow = isStoryboardWorkflow(value);
  const inputScriptMode = workflowUsesInputScript(value);
  return (
    <section className="workflow-form-card-next ecommerce-assets-config-next">
      <span className="workflow-step-index-next">02</span>
      <h3>资产组合</h3>
      <p className="workflow-field-help-next">
        {inputScriptMode
          ? "已使用完整剧本，脚本库会被跳过；角色库可选，商品库中的带货产品必选。"
          : storyboardWorkflow
          ? "脚本可以从创意资产中选择，也可以直接上传本地视频或粘贴 YouTube 链接；直接视频会在选题前自动解析。"
          : "从创意资产中选择本次视频要融合的脚本和其他素材。"}
      </p>
      <div className="ecommerce-asset-section-grid-next">
        {definitions.map((definition) => (
          storyboardWorkflow && definition.type === "script" ? (
            <WorkflowScriptSourcePicker
              value={value}
              referenceData={referenceData}
              onChange={onChange}
              key={definition.key}
            />
          ) : (
            <EcommerceAssetPicker
              definition={definition}
              value={value[definition.key]}
              mode={definition.modeKey ? value[definition.modeKey] : ""}
              assets={referenceData[definition.listKey] || []}
              onChange={(nextValue) => onChange(definition.key, nextValue)}
              onModeChange={definition.modeKey ? (nextMode) => {
                onChange(definition.modeKey, nextMode);
                if (nextMode !== "specific") onChange(definition.key, definition.multiple ? [] : "");
              } : null}
              footer={definition.type === "role" && storyboardWorkflow ? (
                <RoleLibraryCreativeOptions value={value} onChange={onChange} />
              ) : definition.type === "product" && isEcommerceWorkflow(value) ? (
                <EcommerceProductCreativeOptions value={value} onChange={onChange} />
              ) : null}
              key={definition.key}
            />
          )
        ))}
      </div>
    </section>
  );
}

function WorkflowScriptSourcePicker({ value, referenceData, onChange }) {
  const directMode = value.storyScriptSourceMode === "direct";
  const sourceMode = value.storyVideoSourceMode === "youtube" ? "youtube" : "upload";
  const llmKeys = apiKeysForService(referenceData.apiKeys, "llm").filter(apiKeySupportsVideoAnalysis);
  const analysisLlmKeyId = value.storyVideoAnalysisLlmKeyId || value.llmKeyId || "";
  const analysisKey = llmKeys.find((key) => key.id === analysisLlmKeyId) || null;
  const analysisModels = videoAnalysisModelsForApiKey(analysisKey);
  const analysisModelId = analysisModels.some((model) => model.id === value.storyVideoAnalysisModelId)
    ? value.storyVideoAnalysisModelId
    : analysisModels[0]?.id || "";
  const existingSourceName = value.storyVideoSource?.sourceFile?.name || value.storyVideoSource?.name || "";

  function setSourceMode(mode) {
    onChange("storyVideoSourceMode", mode);
    onChange("storyVideoError", "");
  }

  async function selectVideo(fileList) {
    const file = Array.from(fileList || []).find((item) => item.type.startsWith("video/")) || null;
    if (!file) return;
    if (file.size > storyVideoAnalysisMaxBytes) {
      onChange("storyVideoFile", null);
      onChange("storyVideoError", "请上传 20M 以内的视频。");
      return;
    }
    onChange("storyVideoSourceMode", "upload");
    onChange("storyVideoFile", file);
    onChange("storyVideoUrl", "");
    onChange("storyVideoDurationSeconds", 0);
    onChange("storyVideoError", "");
    onChange("storyVideoSource", null);
    onChange("storyVideoScriptAsset", null);
    if (!String(value.storyVideoName || "").trim()) onChange("storyVideoName", stripWorkflowFileExtension(file.name));
    const durationSeconds = await readWorkflowVideoDuration(file);
    onChange("storyVideoDurationSeconds", durationSeconds);
  }

  function updateAnalysisKey(keyId) {
    const key = llmKeys.find((item) => item.id === keyId) || null;
    const models = videoAnalysisModelsForApiKey(key);
    onChange("storyVideoAnalysisLlmKeyId", keyId);
    onChange("storyVideoAnalysisModelId", models[0]?.id || "");
    onChange("storyVideoAnalysisConfigChanged", true);
  }

  return (
    <div className="ecommerce-asset-picker-next workflow-story-script-source-next">
      <div className="workflow-card-toolbar-next">
        <div>
          <strong>脚本来源</strong>
          <p>{directMode ? "运行时先解析视频，再根据解析脚本生成选题。" : "选择 1 个已有脚本资产。"}</p>
        </div>
        <span>{directMode ? "视频导入" : "脚本库"}</span>
      </div>
      <div className="ecommerce-asset-mode-tabs-next" role="tablist" aria-label="脚本来源">
        <button type="button" className={!directMode ? "active" : ""} onClick={() => onChange("storyScriptSourceMode", "library")}>从脚本库选择</button>
        <button type="button" className={directMode ? "active" : ""} onClick={() => {
          onChange("storyScriptSourceMode", "direct");
          onChange("scriptAssetId", "");
        }}>直接导入视频</button>
      </div>
      {!directMode ? (
        <EcommerceAssetPicker
          definition={storyAssetDefinitions[0]}
          value={value.scriptAssetId}
          assets={referenceData.scripts || []}
          onChange={(nextValue) => onChange("scriptAssetId", nextValue)}
        />
      ) : (
        <div className="workflow-story-video-fields-next">
          <div className="asset-entry-mode-tabs-next" role="tablist" aria-label="视频来源">
            <button type="button" className={sourceMode === "upload" ? "active" : ""} onClick={() => setSourceMode("upload")}>本地上传</button>
            <button type="button" className={sourceMode === "youtube" ? "active" : ""} onClick={() => setSourceMode("youtube")}>YouTube 链接</button>
          </div>
          {sourceMode === "youtube" ? (
            <label className="youtube-video-url-field-next">
              <span>YouTube 视频链接</span>
              <input
                type="text"
                inputMode="url"
                value={value.storyVideoUrl || ""}
                onChange={(event) => {
                  onChange("storyVideoUrl", event.target.value);
                  onChange("storyVideoFile", null);
                  onChange("storyVideoError", "");
                  onChange("storyVideoSource", null);
                  onChange("storyVideoScriptAsset", null);
                }}
                placeholder="https://www.youtube.com/watch?v=..."
                autoComplete="off"
              />
              <small>支持公开的 watch、youtu.be、Shorts 和 Live 地址；YouTube 解析需选择 Gemini 模型。</small>
            </label>
          ) : (
            <label className="video-analysis-upload-field-next">
              <span>本地视频</span>
              <span className="video-analysis-upload-control-next">
                <strong>{value.storyVideoFile?.name || existingSourceName || "选择视频"}</strong>
                <small>{value.storyVideoFile
                  ? `${workflowFileSizeText(value.storyVideoFile.size)}${value.storyVideoDurationSeconds ? ` · ${workflowDurationText(value.storyVideoDurationSeconds)}` : ""}`
                  : existingSourceName ? "已上传，可重新选择" : "MP4 / MOV / WEBM，20M 以内"}</small>
              </span>
              <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v" onChange={(event) => {
                selectVideo(event.target.files);
                event.target.value = "";
              }} />
            </label>
          )}
          {value.storyVideoError ? <em className="workflow-story-video-error-next">{value.storyVideoError}</em> : null}
          <label>
            脚本名称
            <input value={value.storyVideoName || ""} onChange={(event) => onChange("storyVideoName", event.target.value)} placeholder="可选，默认使用视频文件名或工作流名称" />
          </label>
          <div className="workflow-control-row-next">
            <label>
              视频分析 LLM 渠道
              <select value={analysisLlmKeyId} onChange={(event) => updateAnalysisKey(event.target.value)}>
                <WorkflowOptionPlaceholder label="请选择视频分析渠道..." />
                {llmKeys.map((key) => <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>)}
              </select>
            </label>
            <label>
              视频分析模型
              <select value={analysisModelId} onChange={(event) => {
                onChange("storyVideoAnalysisModelId", event.target.value);
                onChange("storyVideoAnalysisConfigChanged", true);
              }}>
                <WorkflowModelOptions models={analysisModels} emptyLabel="请先选择视频分析渠道" />
              </select>
            </label>
          </div>
          <label className="workflow-story-video-save-next">
            <input type="checkbox" checked={Boolean(value.storyVideoSaveToLibrary)} onChange={(event) => onChange("storyVideoSaveToLibrary", event.target.checked)} />
            <span>
              <strong>同步保存到脚本库</strong>
              <small>解析完成后把同一份结构化脚本沉淀到创意资产，无需再次解析。</small>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function EcommerceAssetPicker({ definition, value, mode = "", assets, onChange, onModeChange, footer = null }) {
  const selectedIds = definition.multiple ? normalizeWorkflowIdList(value) : [String(value || "").trim()].filter(Boolean);
  const selectedSet = new Set(selectedIds);
  const selectionMode = definition.modeKey ? normalizeEcommerceAssetSelectionMode(mode, selectedIds.length > 0) : "specific";
  const cardsEnabled = selectionMode === "specific";

  function toggleAsset(assetId) {
    if (!cardsEnabled && onModeChange) onModeChange("specific");
    if (!definition.multiple) {
      onChange(selectedSet.has(assetId) ? "" : assetId);
      return;
    }
    const next = selectedSet.has(assetId)
      ? selectedIds.filter((id) => id !== assetId)
      : [...selectedIds, assetId].slice(0, definition.max || 99);
    onChange(next);
  }

  return (
    <div className="ecommerce-asset-picker-next">
      <div className="workflow-card-toolbar-next">
        <div>
          <strong>{definition.label}{definition.required ? " *" : ""}</strong>
          <p>{definition.modeKey ? ecommerceSelectionModeHelp(definition, selectionMode) : definition.multiple ? `最多选择 ${definition.max || 99} 个` : "选择 1 个资产"}</p>
        </div>
        <span>{selectionMode === "random" ? "随机" : `${selectedIds.length}/${definition.multiple ? definition.max || assets.length : 1}`}</span>
      </div>
      {definition.modeKey ? (
        <div className="ecommerce-asset-mode-tabs-next" role="tablist" aria-label={`${definition.label}选择方式`}>
          <button type="button" className={selectionMode === "none" ? "active" : ""} onClick={() => onModeChange?.("none")}>不选择</button>
          <button type="button" className={selectionMode === "random" ? "active" : ""} onClick={() => onModeChange?.("random")}>{definition.randomLabel || "随机"}</button>
          <button type="button" className={selectionMode === "specific" ? "active" : ""} onClick={() => onModeChange?.("specific")}>指定</button>
        </div>
      ) : null}
      {selectionMode === "none" ? (
        <div className="workflow-empty-next compact">
          <strong>{definition.emptyLabel}</strong>
          <span>本次工作流不会引用{definition.label}。</span>
        </div>
      ) : selectionMode === "random" ? (
        <div className="workflow-empty-next compact">
          <strong>{definition.randomLabel || "随机选择"}</strong>
          <span>{assets.length ? `保存工作流时会从 ${assets.length} 个${definition.label}中随机抽取${definition.multiple ? `不超过 ${definition.max || 99} 个` : "1 个"}。` : `请先到创意资产中添加${definition.label}。`}</span>
        </div>
      ) : null}
      {cardsEnabled && assets.length ? (
        <div className="ecommerce-asset-options-next">
          {assets.map((asset) => {
            const selected = selectedSet.has(asset.id);
            const productImage = definition.type === "product" ? ecommerceProductAssetImage(asset) : "";
            const productImageMissing = definition.type === "product" && !productImage;
            return (
              <button className={`${selected ? "selected" : ""} ${productImage ? "with-thumb" : ""} ${productImageMissing ? "missing-product-image" : ""}`.trim()} type="button" onClick={() => toggleAsset(asset.id)} key={asset.id}>
                {productImage ? (
                  <span className="ecommerce-product-thumb-next">
                    <img src={productImage} alt={asset.name || "带货产品"} loading="lazy" />
                  </span>
                ) : productImageMissing ? (
                  <span className="ecommerce-product-thumb-next missing">
                    缺图
                  </span>
                ) : null}
                <span className="ecommerce-asset-option-copy-next">
                  <strong>{asset.name}</strong>
                  <small>{productImageMissing ? "该资产未上传商品图" : asset.tag || asset.desc || "已保存资产"}</small>
                  {productImageMissing ? <em>请先到创意资产补充商品图</em> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : cardsEnabled ? (
        <div className="workflow-empty-next compact">
          <strong>{definition.emptyLabel}</strong>
          <span>请先到创意资产中添加{definition.label}。</span>
        </div>
      ) : null}
      {footer}
    </div>
  );
}

function EcommerceProductCreativeOptions({ value, onChange }) {
  return (
    <div className="workflow-product-creative-options-next">
      <WorkflowOptionToggle
        checked={Boolean(value.strengthenProduct)}
        title="强化塑品"
        description="强化需求铺垫、产品定位、核心卖点、使用动作和信任理由，不增加硬广式特写。"
        onChange={(checked) => onChange("strengthenProduct", checked)}
      />
      <WorkflowOptionToggle
        checked={Boolean(value.purchaseGuidanceEnabled)}
        title="购买引导"
        description="在产品出场后的带货段落中，加入指定的购买入口。"
        onChange={(checked) => onChange("purchaseGuidanceEnabled", checked)}
      />
      {value.purchaseGuidanceEnabled ? (
        <label className="workflow-product-guidance-field-next">
          购买引导内容 *
          <input
            value={value.purchaseGuidanceText || ""}
            onChange={(event) => onChange("purchaseGuidanceText", event.target.value)}
            maxLength={200}
            placeholder="例如：左下角头像进入直播间"
          />
          <small>也可填写“左下角链接下单”等实际购买路径。</small>
        </label>
      ) : null}
    </div>
  );
}

function RoleLibraryCreativeOptions({ value, onChange }) {
  const hasRoleLibrary = Boolean(String(value.roleAssetId || "").trim());
  return (
    <div className="workflow-product-creative-options-next">
      <WorkflowOptionToggle
        checked={hasRoleLibrary && Boolean(value.preferRoleLibraryNames)}
        disabled={!hasRoleLibrary}
        title="优先使用角色库姓名"
        description="生成选题时，匹配角色优先沿用角色库姓名；不会为套用姓名而改变角色设定。"
        onChange={(checked) => onChange("preferRoleLibraryNames", hasRoleLibrary && checked)}
      />
      {!hasRoleLibrary ? <small className="workflow-field-help-next">请先选择角色库，再开启姓名优先。</small> : null}
    </div>
  );
}

function WorkflowRoleReferenceConfig({ value, referenceData, onChange }) {
  const mode = normalizeRoleReferenceImageMode(value.roleReferenceImageMode, "random");
  const selectedRoleAsset = (referenceData.roles || []).find((asset) => asset.id === value.roleAssetId) || null;
  const roleProfiles = workflowRoleProfilesFromAsset(selectedRoleAsset);
  const selections = normalizeRoleReferenceImageSelections(value.roleReferenceImageSelections);
  const selectedManualCount = roleProfiles.filter((profile, index) => {
    const key = workflowRoleProfileKey(profile, index);
    return Boolean(selections[key]);
  }).length;
  const activeDescription = workflowRoleReferenceModes.find((item) => item.id === mode)?.description || "";

  function chooseMode(nextMode) {
    onChange("roleReferenceImageMode", nextMode);
  }

  function chooseRoleImage(profile, index, imageId) {
    const key = workflowRoleProfileKey(profile, index);
    onChange("roleReferenceImageSelections", {
      ...selections,
      [key]: imageId,
    });
  }

  return (
    <section className="workflow-form-card-next workflow-role-reference-config-next">
      <h3>参考图设定</h3>
      <div className="workflow-role-reference-mode-grid-next" role="tablist" aria-label="角色参考图选择策略">
        {workflowRoleReferenceModes.map((item) => (
          <button
            className={mode === item.id ? "selected" : ""}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            onClick={() => chooseMode(item.id)}
            key={item.id}
          >
            <strong>{item.label}</strong>
            <small>{item.description}</small>
          </button>
        ))}
      </div>
      <p className="workflow-field-help-next">{activeDescription}</p>
      {mode === "manual" ? (
        <div className="workflow-role-reference-manual-next">
          <div className="workflow-card-toolbar-next">
            <div>
              <strong>手动指定角色图</strong>
              <p>{selectedRoleAsset ? "点击缩略图，为每个角色固定一张参考图。" : "请先在资产组合里选择角色库。"}</p>
            </div>
            <span>{selectedManualCount}/{roleProfiles.length || 0}</span>
          </div>
          {selectedRoleAsset && roleProfiles.length ? (
            <div className="workflow-role-reference-list-next">
              {roleProfiles.map((profile, profileIndex) => {
                const profileKey = workflowRoleProfileKey(profile, profileIndex);
                const images = workflowRoleProfileImages(profile);
                const selectedImageId = selections[profileKey] || "";
                return (
                  <article className="workflow-role-reference-row-next" key={profileKey}>
                    <div className="workflow-role-reference-name-next">
                      <strong>{profile.name || profile["角色名字"] || selectedRoleAsset.name || `角色 ${profileIndex + 1}`}</strong>
                      <span>{selectedImageId ? "已指定" : "未指定"}</span>
                    </div>
                    {images.length ? (
                      <div className="workflow-role-reference-thumbs-next">
                        {images.map((image, imageIndex) => {
                          const selected = selectedImageId === image.id;
                          return (
                            <button
                              className={selected ? "selected" : ""}
                              type="button"
                              onClick={() => chooseRoleImage(profile, profileIndex, image.id)}
                              key={`${profileKey}-${image.id}`}
                            >
                              <img src={image.url} alt={`${profile.name || "角色"}参考图 ${imageIndex + 1}`} loading="lazy" />
                              <span>{image.isDefault ? "默认" : `图 ${imageIndex + 1}`}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="workflow-field-help-next">这个角色还没有可指定的参考图。</p>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="workflow-empty-next compact">
              <strong>{selectedRoleAsset ? "暂无角色图" : "未选择角色库"}</strong>
              <span>{selectedRoleAsset ? "所选角色库里没有可用的角色参考图。" : "选择角色库后，可在这里为每个角色指定参考图。"}</span>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ecommerceSelectionModeHelp(definition, mode) {
  if (mode === "none") return "本次不使用";
  if (mode === "random") return definition.multiple ? `随机选择不超过 ${definition.max || 99} 个` : "随机选择 1 个";
  return definition.multiple ? `指定选择，最多 ${definition.max || 99} 个` : "指定选择 1 个";
}

function ecommerceProductAssetImage(asset = {}) {
  const profile = asset.productProfile && typeof asset.productProfile === "object" ? asset.productProfile : {};
  return resolveFlowStudioFileUrl(
    asset.productImageThumbnailUrl ||
    profile.productImageThumbnailUrl ||
    asset.productImageUrl ||
    profile.productImageUrl ||
    ""
  );
}

function ecommerceProductAssetsMissingImages(value) {
  const products = Array.isArray(value) ? value : value ? [value] : [];
  return products.filter((asset) => asset && typeof asset === "object" && !ecommerceProductAssetImage(asset));
}

function workflowRoleProfilesFromAsset(asset = null) {
  if (!asset) return [];
  const payload = asset.payload && typeof asset.payload === "object" ? asset.payload : {};
  const profiles = [];
  const hasExplicitRoleCharacters = Array.isArray(asset.roleCharacters) || Array.isArray(payload.roleCharacters);
  if (Array.isArray(asset.roleCharacters)) profiles.push(...asset.roleCharacters);
  if (Array.isArray(payload.roleCharacters)) profiles.push(...payload.roleCharacters);
  if (asset.roleProfile && typeof asset.roleProfile === "object") profiles.push(asset.roleProfile);
  if (payload.roleProfile && typeof payload.roleProfile === "object") profiles.push(payload.roleProfile);
  if (!profiles.length && !hasExplicitRoleCharacters) profiles.push(payload.roleProfile ? payload : asset);
  const seen = new Set();
  return profiles
    .filter((profile) => profile && typeof profile === "object")
    .filter((profile, index) => {
      const key = workflowRoleProfileKey(profile, index);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function workflowRoleProfileImages(profile = {}) {
  const images = Array.isArray(profile.roleImages)
    ? profile.roleImages
    : Array.isArray(profile.images)
      ? profile.images
      : [];
  const defaultImageId = String(profile.defaultImageId || profile.defaultRoleImageId || profile.roleImageId || "").trim();
  const normalized = images
    .map((image, index) => workflowRoleProfileImageFromRecord(image, index, defaultImageId))
    .filter((image) => image.url);
  const legacyImage = workflowRoleProfileImageFromRecord({
    id: profile.imageId || "legacy",
    imageUrl: profile.imageUrl || profile.url || profile.fileUrl,
    thumbnailUrl: profile.thumbnailUrl || profile.imageThumbnailUrl || profile.thumbUrl,
    isDefault: !normalized.some((image) => image.isDefault),
  }, normalized.length, defaultImageId);
  if (legacyImage.url && !normalized.some((image) => image.id === legacyImage.id || image.url === legacyImage.url)) {
    normalized.push(legacyImage);
  }
  return normalized;
}

function workflowRoleProfileImageFromRecord(image = {}, index = 0, defaultImageId = "") {
  const rawUrl = image.thumbnailUrl || image.imageThumbnailUrl || image.thumbUrl || image.imageUrl || image.url || image.fileUrl || "";
  const imageUrl = image.imageUrl || image.url || image.fileUrl || rawUrl;
  const id = String(image.id || image.imageId || image.roleImageId || image.fileKey || imageUrl || `image-${index + 1}`).trim();
  return {
    id,
    url: resolveFlowStudioFileUrl(rawUrl),
    isDefault: Boolean(image.isDefault || (defaultImageId && id === defaultImageId)),
  };
}

function workflowRoleProfileKey(profile = {}, index = 0) {
  return String(
    profile.id ||
    profile.roleId ||
    profile.name ||
    profile["角色名字"] ||
    `role-${index + 1}`
  ).trim();
}

function normalizeRoleReferenceImageMode(value, fallback = "default") {
  const mode = String(value || "").trim();
  if (workflowRoleReferenceModes.some((item) => item.id === mode)) return mode;
  return workflowRoleReferenceModes.some((item) => item.id === fallback) ? fallback : "default";
}

function normalizeRoleReferenceImageSelections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((result, [key, imageId]) => {
    const safeKey = String(key || "").trim();
    const safeImageId = String(imageId || "").trim();
    if (safeKey && safeImageId) result[safeKey] = safeImageId;
    return result;
  }, {});
}

function normalizeWorkflowAudienceProfile(value = "") {
  const profile = String(value || "").trim();
  return workflowAudienceProfileOptions.some((option) => option.value === profile) ? profile : "50-plus";
}

function normalizeWorkflowStoryEnvironment(value = "") {
  const environment = String(value || "").trim();
  return workflowStoryEnvironmentOptions.some((option) => option.value === environment) ? environment : "unspecified";
}

function normalizeWorkflowCreateForm(nextForm, referenceData, changedKey = "") {
  const llmKeys = apiKeysForService(referenceData.apiKeys, "llm");
  const imageKeys = apiKeysForService(referenceData.apiKeys, "image");
  const audioKeys = apiKeysForService(referenceData.apiKeys, "audio");
  const baseLlmKey = llmKeys.find((key) => key.id === nextForm.llmKeyId);
  const topicLlmKey = llmKeys.find((key) => key.id === nextForm.topicLlmKeyId);
  const llmModels = workflowLlmModelOptions(baseLlmKey);
  const topicModels = workflowLlmModelOptions(topicLlmKey);
  const imageKey = imageKeys.find((key) => key.id === nextForm.imageKeyId);
  const imageModels = workflowImageModelOptions(imageKey);
  const audioKey = audioKeys.find((key) => key.id === nextForm.audioKeyId);
  const audioModels = workflowAudioModelOptions(audioKey);
  const form = { ...nextForm };
  form.topicMode = normalizeWorkflowTopicMode(form.topicMode, form.type);
  form.inputScriptTitle = String(form.inputScriptTitle || "");
  form.inputScript = String(form.inputScript || "");
  form.inputScriptDurationMode = normalizeInputScriptDurationMode(form.inputScriptDurationMode);
  form.inputScriptTargetDurationSeconds = String(form.inputScriptTargetDurationSeconds ?? "");
  form.inputScriptShotDurationSeconds = 4.5;
  form.audienceProfile = normalizeWorkflowAudienceProfile(form.audienceProfile);
  form.storyEnvironment = normalizeWorkflowStoryEnvironment(form.storyEnvironment);
  form.endingInteractionEnabled = isStoryboardWorkflow(form) && Boolean(form.endingInteractionEnabled);
  form.strengthenProduct = isEcommerceWorkflow(form) && Boolean(form.strengthenProduct);
  form.purchaseGuidanceEnabled = isEcommerceWorkflow(form) && Boolean(form.purchaseGuidanceEnabled);
  form.purchaseGuidanceText = String(form.purchaseGuidanceText || "");

  if (changedKey === "llmKeyId") {
    form.storyModelId = modelValueOrFirst(llmModels, form.storyModelId);
    form.shotModelId = modelValueOrFirst(llmModels, form.shotModelId);
  }
  if (changedKey === "topicLlmKeyId") {
    form.topicModelId = modelValueOrFirst(topicModels, form.topicModelId);
  }
  if (changedKey === "imageKeyId" || changedKey === "imageModelId") {
    form.imageModelId = modelValueOrFirst(imageModels, form.imageModelId);
    const selectedImageModel = imageModels.find((model) => model.id === form.imageModelId);
    form.imageResolution = optionValueOrFirst(selectedImageModel?.resolutions || [], form.imageResolution);
    const ratios = workflowImageRatioOptions(selectedImageModel);
    form.ratio = optionValueOrFirst(ratios.map((ratio) => ratio.value), form.ratio);
  }
  form.imageSize = workflowImageRequestSize(form.ratio);
  if (changedKey === "audioKeyId") {
    form.audioModelId = modelValueOrFirst(audioModels, form.audioModelId);
  }
  form.language = workflowLanguageValueForType(form.language, form.type);
  form.audioFormat = workflowAudioFormats.includes(form.audioFormat) ? form.audioFormat : "mp3";
  form.audioEmotion = workflowAudioEmotions.some((emotion) => emotion.value === form.audioEmotion) ? form.audioEmotion : "natural";
  form.audioSpeed = clampWorkflowNumber(form.audioSpeed, 0.5, 2, 1);
  form.audioBitrate = form.audioFormat === "opus" ? 64 : Number(form.audioBitrate || 128);
  form.audioVoicePresetId = workflowAudioVoiceModes.some((mode) => mode.id === form.audioVoicePresetId) ? form.audioVoicePresetId : "default";
  form.audioReferences = normalizeWorkflowAudioReferences(form.audioReferences);
  if (form.audioVoicePresetId !== "saved") form.audioReferenceId = "";
  if (form.audioVoicePresetId !== "clone") form.audioReferences = [];
  form.customTopicItems = changedKey === "customTopicsText"
    ? editableCustomTopicItems([], form.customTopicsText)
    : editableCustomTopicItems(form.customTopicItems, form.customTopicsText);
  form.storyScriptSourceMode = isStoryboardWorkflow(form) && !workflowUsesInputScript(form) && form.storyScriptSourceMode === "direct" ? "direct" : "library";
  form.storyVideoSourceMode = form.storyVideoSourceMode === "youtube" ? "youtube" : "upload";
  form.storyVideoDurationSeconds = Math.max(0, Number(form.storyVideoDurationSeconds || 0));
  form.storyVideoName = String(form.storyVideoName || "");
  form.storyVideoError = String(form.storyVideoError || "");
  form.storyVideoSaveToLibrary = Boolean(form.storyVideoSaveToLibrary);
  form.storyVideoAnalysisLlmKeyId = String(form.storyVideoAnalysisLlmKeyId || "");
  const storyVideoAnalysisKey = llmKeys.find((key) => key.id === (form.storyVideoAnalysisLlmKeyId || form.llmKeyId));
  const storyVideoAnalysisModels = videoAnalysisModelsForApiKey(storyVideoAnalysisKey);
  if (changedKey === "storyVideoAnalysisLlmKeyId") {
    form.storyVideoAnalysisModelId = modelValueOrFirst(storyVideoAnalysisModels, form.storyVideoAnalysisModelId);
  }
  form.storyVideoAnalysisModelId = modelValueOrFirst(storyVideoAnalysisModels, form.storyVideoAnalysisModelId);
  form.storyVideoAnalysisConfigChanged = Boolean(form.storyVideoAnalysisConfigChanged);
  form.scriptAssetId = String(form.scriptAssetId || "");
  if (form.storyScriptSourceMode === "direct" || workflowUsesInputScript(form)) form.scriptAssetId = "";
  form.roleAssetId = String(form.roleAssetId || "");
  form.preferRoleLibraryNames = isStoryboardWorkflow(form) && Boolean(form.roleAssetId) && Boolean(form.preferRoleLibraryNames);
  form.roleReferenceImageMode = normalizeRoleReferenceImageMode(form.roleReferenceImageMode, "random");
  form.roleReferenceImageSelections = normalizeRoleReferenceImageSelections(form.roleReferenceImageSelections);
  if (changedKey === "roleAssetId") form.roleReferenceImageSelections = {};
  form.hookAssetId = String(form.hookAssetId || "");
  form.productAssetId = String(form.productAssetId || "");
  form.elementAssetIds = normalizeWorkflowIdList(form.elementAssetIds).slice(0, 3);
  form.hookSelectionMode = normalizeEcommerceAssetSelectionMode(form.hookSelectionMode, Boolean(form.hookAssetId));
  form.elementSelectionMode = normalizeEcommerceAssetSelectionMode(form.elementSelectionMode, form.elementAssetIds.length > 0);
  if (changedKey === "hookSelectionMode" && form.hookSelectionMode !== "specific") form.hookAssetId = "";
  if (changedKey === "elementSelectionMode" && form.elementSelectionMode !== "specific") form.elementAssetIds = [];

  return form;
}

function workflowLlmModelOptions(apiKey) {
  if (!apiKey) return [];
  const knownModels = llmModelsForApiKey(apiKey);
  if (knownModels.length) return knownModels;
  return workflowCustomModelOptions(apiKey.model);
}

function workflowPromptOptions(prompts = []) {
  return prompts
    .map((prompt) => ({
      id: prompt.id,
      name: prompt.name || prompt.title || "未命名提示词",
      prompt: prompt.prompt || prompt.content || prompt.text || prompt.payload?.prompt || prompt.payload?.content || prompt.payload?.text || "",
    }))
    .filter((prompt) => prompt.id && prompt.prompt);
}

function workflowPromptAssetsFromResult(result = {}) {
  const assets = Array.isArray(result.assets) ? result.assets : [];
  const groupAssets = Array.isArray(result.groups)
    ? result.groups.flatMap((group) => [
      ...(Array.isArray(group.assets) ? group.assets : []),
      ...(Array.isArray(group.items) ? group.items : []),
      ...(Array.isArray(group.prompts) ? group.prompts : []),
    ])
    : [];
  return [...assets, ...groupAssets];
}

function workflowAssetsFromResult(result = {}) {
  const assets = Array.isArray(result.assets) ? result.assets : [];
  return assets.map(normalizeWorkflowAsset).filter((asset) => asset.id);
}

const workflowScriptFallbackSecondsPerShot = 5;

function workflowPositiveInteger(value) {
  const number = Math.round(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function workflowScriptAnalysisText(...items) {
  return items.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
}

function workflowLabeledPositiveIntegerFromText(text = "", labels = []) {
  const body = String(text || "");
  if (!body.trim()) return 0;
  for (const label of labels) {
    const escapedLabel = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`["']?${escapedLabel}["']?\\s*[:：=]\\s*["']?(\\d{1,5})`, "i"),
      new RegExp(`${escapedLabel}[^\\d\\n]{0,20}(\\d{1,5})\\s*(?:镜|个|人|位)?`, "i"),
    ];
    for (const pattern of patterns) {
      const value = workflowPositiveInteger(body.match(pattern)?.[1]);
      if (value) return value;
    }
  }
  return 0;
}

function workflowEstimateSourceShotCount(sourceDurationSeconds = 0) {
  const seconds = Number(sourceDurationSeconds || 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds / workflowScriptFallbackSecondsPerShot)) : 0;
}

function workflowEstimateTargetShotCount(sourceShotCount = 0, sourceDurationSeconds = 0, targetDurationMode = "source", targetDurationSeconds = 0) {
  const sourceCount = workflowPositiveInteger(sourceShotCount);
  const sourceSeconds = Number(sourceDurationSeconds || 0);
  const targetSeconds = Number(targetDurationSeconds || 0);
  if (!sourceCount) return Number.isFinite(targetSeconds) && targetSeconds > 0 ? Math.max(1, Math.round(targetSeconds / workflowScriptFallbackSecondsPerShot)) : 0;
  if (targetDurationMode !== "custom") return sourceCount;
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return sourceCount;
  if (!Number.isFinite(sourceSeconds) || sourceSeconds <= 0) return Math.max(1, Math.round(targetSeconds / workflowScriptFallbackSecondsPerShot));
  return Math.max(1, Math.round(sourceCount * (targetSeconds / sourceSeconds)));
}

function normalizeWorkflowAsset(asset = {}) {
  const payload = asset.payload && typeof asset.payload === "object" ? asset.payload : {};
  const prompt = payload.prompt || payload.report || payload.content || payload.text || asset.prompt || "";
  const sourceFile = payload.sourceFile || asset.sourceFile || null;
  const targetDurationSeconds = Number(payload.targetDurationSeconds || asset.targetDurationSeconds || 0);
  const durationSeconds = Number(payload.durationSeconds || asset.durationSeconds || payload.targetDurationSeconds || asset.targetDurationSeconds || sourceFile?.durationSeconds || 0);
  const sourceDurationSeconds = Number(sourceFile?.durationSeconds || 0);
  const targetDurationMode = payload.targetDurationMode || asset.targetDurationMode || (durationSeconds && sourceDurationSeconds && durationSeconds !== sourceDurationSeconds ? "custom" : "");
  const scriptText = workflowScriptAnalysisText(payload.rawAnalysis, prompt, payload.desc, asset.desc);
  const sourceShotCount = Number(
    payload.sourceShotCount ||
    asset.sourceShotCount ||
    payload.scriptProfile?.sourceShotCount ||
    asset.scriptProfile?.sourceShotCount ||
    payload.scriptProfile?.estimatedShotCount ||
    asset.scriptProfile?.estimatedShotCount ||
    workflowLabeledPositiveIntegerFromText(scriptText, ["sourceShotCount", "originalShotCount", "原镜头", "原视频镜头数", "分镜数量", "estimatedShotCount"]) ||
    workflowEstimateSourceShotCount(sourceDurationSeconds) ||
    1,
  );
  const targetShotCount = Number(
    payload.targetShotCount ||
    asset.targetShotCount ||
    payload.scriptProfile?.targetShotCount ||
    asset.scriptProfile?.targetShotCount ||
    workflowLabeledPositiveIntegerFromText(scriptText, ["targetShotCount", "目标镜头", "目标镜头数量"]) ||
    workflowEstimateTargetShotCount(sourceShotCount, sourceDurationSeconds, targetDurationMode || "source", targetDurationSeconds || durationSeconds),
  );
  return {
    ...payload,
    id: asset.id || payload.id || "",
    type: asset.type || payload.type || "",
    groupId: asset.groupId || payload.groupId || "",
    name: asset.name || payload.name || "未命名资产",
    desc: payload.desc || asset.desc || "",
    tag: payload.tag || asset.tag || "",
    prompt,
    sourceFile,
    targetDurationMode,
    targetDurationSeconds,
    durationSeconds,
    scriptProfile: payload.scriptProfile || asset.scriptProfile || null,
    sourceShotCount,
    targetShotCount,
    estimatedShotCount: Number(payload.estimatedShotCount || asset.estimatedShotCount || payload.scriptProfile?.estimatedShotCount || asset.scriptProfile?.estimatedShotCount || 0),
    roleProfile: payload.roleProfile || asset.roleProfile || null,
    roleCharacters: Array.isArray(payload.roleCharacters) ? payload.roleCharacters : Array.isArray(asset.roleCharacters) ? asset.roleCharacters : [],
    productProfile: payload.productProfile || null,
    productImageUrl: payload.productImageUrl || payload.productProfile?.productImageUrl || "",
    productImageThumbnailUrl: payload.productImageThumbnailUrl || payload.productProfile?.productImageThumbnailUrl || "",
    createdAt: asset.createdAt || payload.createdAt || "",
    updatedAt: asset.updatedAt || payload.updatedAt || "",
  };
}

function workflowAssetSnapshot(asset = {}) {
  if (!asset?.id) return null;
  const sourceDurationSeconds = Number(asset.sourceFile?.durationSeconds || 0);
  const durationSeconds = Number(asset.durationSeconds || asset.targetDurationSeconds || sourceDurationSeconds || 0);
  const targetDurationMode = asset.targetDurationMode || (durationSeconds && sourceDurationSeconds && durationSeconds !== sourceDurationSeconds ? "custom" : "");
  const sourceShotCount = Number(asset.sourceShotCount || asset.scriptProfile?.sourceShotCount || asset.scriptProfile?.estimatedShotCount || workflowEstimateSourceShotCount(sourceDurationSeconds) || 1);
  const targetShotCount = Number(asset.targetShotCount || asset.scriptProfile?.targetShotCount || workflowEstimateTargetShotCount(sourceShotCount, sourceDurationSeconds, targetDurationMode || "source", asset.targetDurationSeconds || durationSeconds));
  return {
    id: asset.id,
    type: asset.type || "",
    name: asset.name || "未命名资产",
    desc: asset.desc || "",
    tag: asset.tag || "",
    prompt: asset.prompt || "",
    sourceFile: asset.sourceFile || null,
    targetDurationMode,
    targetDurationSeconds: Number(asset.targetDurationSeconds || 0),
    durationSeconds,
    scriptProfile: asset.scriptProfile || null,
    sourceShotCount,
    targetShotCount,
    estimatedShotCount: Number(asset.estimatedShotCount || asset.scriptProfile?.estimatedShotCount || 0),
    roleProfile: asset.roleProfile || null,
    roleCharacters: Array.isArray(asset.roleCharacters) ? asset.roleCharacters : [],
    productProfile: asset.productProfile || null,
    productImageUrl: asset.productImageUrl || asset.productProfile?.productImageUrl || "",
    productImageThumbnailUrl: asset.productImageThumbnailUrl || asset.productProfile?.productImageThumbnailUrl || "",
    updatedAt: asset.updatedAt || asset.createdAt || "",
  };
}

function workflowEcommerceAssetSnapshot(referenceData = emptyWorkflowReferences, form = {}) {
  return workflowAssetDefinitionsForType(form.type, form.topicMode).reduce((result, definition) => {
    if (definition.type === "script" && workflowUsesDirectVideo(form)) {
      result[definition.listKey] = form.storyVideoScriptAsset?.id
        ? workflowAssetSnapshot(form.storyVideoScriptAsset)
        : null;
      return result;
    }
    const assets = referenceData[definition.listKey] || [];
    const mode = definition.modeKey
      ? normalizeEcommerceAssetSelectionMode(form[definition.modeKey], definition.multiple ? normalizeWorkflowIdList(form[definition.key]).length > 0 : Boolean(form[definition.key]))
      : "specific";
    if (mode === "none") {
      result[definition.listKey] = definition.multiple ? [] : null;
      return result;
    }
    if (mode === "random") {
      const picked = pickRandomWorkflowAssets(assets, definition.multiple ? definition.max || 99 : 1);
      result[definition.listKey] = definition.multiple
        ? picked.map((asset) => workflowAssetSnapshot(asset)).filter(Boolean)
        : workflowAssetSnapshot(picked[0]);
      return result;
    }
    if (definition.multiple) {
      result[definition.listKey] = normalizeWorkflowIdList(form[definition.key])
        .slice(0, definition.max || 99)
        .map((id) => workflowAssetSnapshot(assets.find((asset) => asset.id === id) || { id, type: definition.type, name: id }))
        .filter(Boolean);
    } else {
      const id = String(form[definition.key] || "").trim();
      result[definition.listKey] = id ? workflowAssetSnapshot(assets.find((asset) => asset.id === id) || { id, type: definition.type, name: id }) : null;
    }
    return result;
  }, {});
}

function workflowUsesDirectVideo(workflow = {}) {
  return isStoryboardWorkflow(workflow) && !workflowUsesInputScript(workflow) && workflow.storyScriptSourceMode === "direct";
}

function workflowRequiresVideoAnalysis(workflow = {}) {
  if (!workflowUsesDirectVideo(workflow)) return false;
  const source = workflow.storyVideoSource && typeof workflow.storyVideoSource === "object" ? workflow.storyVideoSource : {};
  const sourceFile = source.sourceFile && typeof source.sourceFile === "object" ? source.sourceFile : {};
  if (!String(sourceFile.fileUrl || "").trim()) return false;
  const scriptAsset = workflow.storyVideoScriptAsset || workflow.ecommerceAssets?.scripts;
  return source.analysisStatus !== "done" || !String(scriptAsset?.prompt || "").trim();
}

async function prepareWorkflowVideoSource(form = {}, referenceData = emptyWorkflowReferences) {
  if (!workflowUsesDirectVideo(form)) return { source: null, scriptAsset: null };
  const sourceMode = form.storyVideoSourceMode === "youtube" ? "youtube" : "upload";
  const llmKeyId = String(form.storyVideoAnalysisLlmKeyId || form.llmKeyId || "").trim();
  const modelId = String(form.storyVideoAnalysisModelId || "").trim();
  const llmKey = apiKeysForService(referenceData.apiKeys, "llm").find((key) => key.id === llmKeyId) || null;

  const existingSource = form.storyVideoSource && typeof form.storyVideoSource === "object" ? form.storyVideoSource : {};
  const existingSourceFile = existingSource.sourceFile && typeof existingSource.sourceFile === "object" ? existingSource.sourceFile : {};
  let sourceFile;
  if (sourceMode === "youtube") {
    const youtubeUrl = normalizeYoutubeVideoUrl(form.storyVideoUrl || existingSourceFile.sourceUrl || existingSourceFile.fileUrl || "");
    if (!youtubeUrl) throw new Error("请输入有效的公开 YouTube 视频链接。");
    sourceFile = {
      name: String(form.storyVideoName || existingSource.name || "YouTube 视频").trim() || "YouTube 视频",
      fileUrl: youtubeUrl,
      fileKey: "",
      mimeType: "video/*",
      sizeBytes: 0,
      durationSeconds: 0,
      sourceType: "youtube",
      sourceUrl: youtubeUrl,
    };
  } else if (form.storyVideoFile) {
    if (form.storyVideoFile.size > storyVideoAnalysisMaxBytes) throw new Error("请上传 20M 以内的视频。");
    const uploadResult = await uploadAssetFiles([form.storyVideoFile]);
    const uploaded = Array.isArray(uploadResult.files) ? uploadResult.files[0] : null;
    const fileUrl = String(uploaded?.url || "").trim();
    if (!fileUrl) throw new Error("视频已上传，但没有返回可用于分析的文件地址。");
    sourceFile = {
      name: uploaded.originalName || form.storyVideoFile.name || "工作流视频",
      fileUrl,
      fileKey: uploaded.key || "",
      mimeType: uploaded.mimeType || form.storyVideoFile.type || "video/mp4",
      sizeBytes: Number(uploaded.sizeBytes || form.storyVideoFile.size || 0),
      durationSeconds: Number(form.storyVideoDurationSeconds || 0),
      sourceType: "upload",
      sourceUrl: "",
    };
  } else if (existingSourceFile.fileUrl) {
    sourceFile = {
      ...existingSourceFile,
      sourceType: "upload",
      sourceUrl: "",
    };
  } else {
    throw new Error("请选择要解析的本地视频。");
  }

  const name = String(form.storyVideoName || existingSource.name || stripWorkflowFileExtension(sourceFile.name) || form.name || "工作流视频").trim();
  const saveToScriptLibrary = Boolean(form.storyVideoSaveToLibrary);
  const canReuseAnalysis = canReuseWorkflowVideoAnalysis({
    existingSource,
    nextSource: { sourceType: sourceMode, sourceFile },
    scriptAsset: form.storyVideoScriptAsset,
    analysisConfigChanged: Boolean(form.storyVideoAnalysisConfigChanged),
    saveToScriptLibrary,
  });
  if (!canReuseAnalysis) {
    if (!llmKeyId) throw new Error("请选择视频分析 LLM 渠道。");
    if (modelId !== videoAnalysisModelId) throw new Error(`视频解析仅支持 ${videoAnalysisModelId} 模型。`);
    if (!apiKeySupportsVideoAnalysis(llmKey)) throw new Error("当前渠道不支持视频解析模型。");
  }
  const now = new Date().toISOString();
  const source = {
    name,
    sourceType: sourceMode,
    sourceFile,
    saveToScriptLibrary,
    scriptAssetId: canReuseAnalysis && saveToScriptLibrary ? existingSource.scriptAssetId || "" : "",
    analysisStatus: canReuseAnalysis ? "done" : "pending",
    analysisError: "",
    analysisLlmKeyId: canReuseAnalysis ? existingSource.analysisLlmKeyId || "" : llmKeyId,
    analysisModelId: canReuseAnalysis ? existingSource.analysisModelId || "" : modelId,
    analyzedAt: canReuseAnalysis ? existingSource.analyzedAt || "" : "",
    createdAt: existingSource.createdAt || now,
  };
  return {
    source,
    scriptAsset: canReuseAnalysis ? form.storyVideoScriptAsset : null,
  };
}

function stripWorkflowFileExtension(value = "") {
  return String(value || "").replace(/\.[^.]+$/, "").trim();
}

function workflowFileSizeText(value = 0) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function workflowDurationText(value = 0) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function readWorkflowVideoDuration(file) {
  if (typeof document === "undefined" || !file) return Promise.resolve(0);
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute("src");
      video.load();
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      cleanup();
      resolve(duration);
    };
    video.onerror = () => {
      cleanup();
      resolve(0);
    };
    video.src = objectUrl;
  });
}

function normalizeEcommerceAssetSelectionMode(value, hasSpecificSelection = false) {
  const mode = String(value || "").trim();
  if (["none", "random", "specific"].includes(mode)) return mode;
  return hasSpecificSelection ? "specific" : "none";
}

function pickRandomWorkflowAssets(assets = [], count = 1) {
  const safeAssets = Array.isArray(assets) ? assets.filter((asset) => asset?.id) : [];
  return [...safeAssets].sort(() => Math.random() - 0.5).slice(0, Math.max(0, Math.min(Number(count || 1), safeAssets.length)));
}

function workflowSnapshotAssetIds(value) {
  if (Array.isArray(value)) return value.map((asset) => asset?.id).filter(Boolean);
  return value?.id ? [value.id] : [];
}

function workflowSnapshotSingleAssetId(value) {
  return Array.isArray(value) ? value[0]?.id || "" : value?.id || "";
}

function normalizeWorkflowIdList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function workflowPromptText(prompts, id) {
  return prompts.find((prompt) => prompt.id === id)?.prompt || "";
}

function workflowVisualStyleOptions(visualStyles = []) {
  return mergeWorkflowVisualStyles(visualStyles);
}

function mergeWorkflowVisualStyles(visualStyles = []) {
  const seen = new Set();
  const normalized = visualStyles.map((style) => {
    const payload = style?.payload && typeof style.payload === "object" ? style.payload : {};
    return {
      ...payload,
      ...style,
      id: style?.id || payload.id || "",
      name: style?.name || payload.name || "未命名图风",
      desc: style?.desc || payload.desc || payload.description || "",
      prompt: style?.prompt || payload.prompt || payload.content || payload.text || "",
    };
  });
  return [...defaultWorkflowVisualStyles, ...normalized].filter((style) => {
    const id = style.id || style.name || style.title;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function workflowVisualStyleSnapshot(visualStyles = [], visualStyleId = "") {
  const style = mergeWorkflowVisualStyles(visualStyles).find((item) => item.id === visualStyleId || item.name === visualStyleId);
  return {
    name: style?.name || "",
    prompt: style?.prompt || "",
  };
}

function workflowImageModelOptions(apiKey) {
  if (!apiKey) return [];
  const knownModels = imageModelsForApiKey(apiKey, { workflow: true });
  if (knownModels.length) return knownModels;
  return workflowCustomModelOptions(apiKey.model).map((model) => ({
    ...model,
    resolutions: ["默认"],
    ratios: defaultWorkflowImageRatios(),
  }));
}

function workflowAudioModelOptions(apiKey) {
  return (apiKey?.modelOptions || []).map(model => ({ ...model, name: model.name || model.id }));
}

function workflowCustomModelOptions(value = "") {
  return String(value)
    .split(/[,，;\n]/)
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => ({ id: model, name: model }));
}

function workflowAudioVoiceModeName(value = "default") {
  return workflowAudioVoiceModes.find((mode) => mode.id === value)?.name || "默认音色";
}

function normalizeWorkflowAudioReferences(references) {
  if (!Array.isArray(references)) return [];
  return references
    .map((reference) => ({
      id: String(reference?.id || crypto.randomUUID()),
      name: String(reference?.name || "参考音频"),
      type: String(reference?.type || "audio/mpeg"),
      dataUrl: String(reference?.dataUrl || reference?.audio || reference?.url || ""),
      transcript: String(reference?.transcript || reference?.text || ""),
    }))
    .filter((reference) => reference.dataUrl)
    .slice(0, 5);
}

function clampWorkflowNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Number(number.toFixed(1))));
}

function workflowImageRatioOptions(model) {
  const ratios = model?.ratios?.length ? model.ratios : defaultWorkflowImageRatios();
  return ratios.map((ratio) => ({
    value: ratio.value || ratio.id || ratio,
    label: ratio.label || ratio.name || ratio.value || ratio,
    detail: ratio.detail || ratio.value || ratio.id || ratio,
  }));
}

function workflowImageRequestSize(ratio = "") {
  const value = String(ratio || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[×*]/g, "x");
  return /^\d{3,4}x\d{3,4}$/.test(value) ? value : "";
}

function defaultWorkflowImageRatios() {
  return [
    { value: "1:1", label: "正方形", detail: "1:1" },
    { value: "9:16", label: "竖屏", detail: "9:16" },
    { value: "16:9", label: "横屏", detail: "16:9" },
    { value: "21:9", label: "超宽屏", detail: "21:9" },
  ];
}

function modelValueOrFirst(models, value) {
  if (models.some((model) => model.id === value)) return value;
  return models[0]?.id || "";
}

function optionValueOrFirst(options, value) {
  if (options.includes(value)) return value;
  return options[0] || "";
}

function stringListFromLines(value = "") {
  return String(value)
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyCustomTopicItem() {
  return { title: "", adaptation: "" };
}

function customTopicItemsFromValue(value, fallbackText = "", options = {}) {
  const trim = options.trim !== false;
  const includeEmpty = Boolean(options.includeEmpty);
  const toText = (item) => (trim ? String(item || "").trim() : String(item ?? ""));
  const sourceItems = Array.isArray(value) ? value : [];
  const items = sourceItems.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const title = toText(item.title || item.topic || item.name || item.text || item.content);
      const adaptation = toText(item.adaptation || item.adaptationIdea || item.rewriteIdea || item.direction || item.prompt || item.note);
      return {
        title: adaptation ? title : "",
        adaptation: adaptation || title,
      };
    }
    return {
      title: "",
      adaptation: toText(item),
    };
  });
  const fallbackItems = items.length ? [] : stringListFromLines(fallbackText).map((adaptation) => ({ title: "", adaptation }));
  return [...items, ...fallbackItems].filter((item) => includeEmpty || item.title || item.adaptation);
}

function editableCustomTopicItems(value, fallbackText = "") {
  const items = customTopicItemsFromValue(value, fallbackText, { trim: false, includeEmpty: true });
  return items.length ? items : [emptyCustomTopicItem()];
}

function customTopicItemsForSave(value, fallbackText = "") {
  return customTopicItemsFromValue(value, fallbackText)
    .filter((item) => item.title || item.adaptation)
    .map((item) => ({
      title: item.title,
      adaptation: item.adaptation,
    }));
}

function customTopicTitlesFromItems(value) {
  return customTopicItemsForSave(value).map((item) => item.title);
}

function customTopicAdaptationsFromItems(value) {
  return customTopicItemsForSave(value).reduce((adaptations, item, index) => {
    if (item.adaptation) adaptations[item.title || `改编思路 ${index + 1}`] = item.adaptation;
    return adaptations;
  }, {});
}

function customTopicAdaptationBriefFromItems(value) {
  return customTopicItemsForSave(value)
    .map((item, index) => {
      const title = item.title ? `${item.title}：` : "";
      return `${index + 1}. ${title}${item.adaptation || item.title}`;
    })
    .filter(Boolean)
    .join("\n");
}

function apiKeyDisplayName(apiKey) {
  return apiKey.name || formatApiChannelName(apiKey.channel) || apiKey.serviceType || "未命名渠道";
}

function formatApiChannelName(channel = "") {
  const value = String(channel || "").trim();
  if (/^canvas$/i.test(value)) return "Canvas";
  return value;
}

function WorkflowCard({ workflow, deleting, onOpen, onDelete }) {
  const runs = workflow.runs || [];
  const completed = runs.filter((run) => ["done", "completed"].includes(run.status)).length;
  const running = runs.filter((run) => run.status === "running").length;
  const waiting = runs.filter((run) => run.status === "waiting").length;
  const progress = runs.length ? Math.round((completed / runs.length) * 100) : 0;
  const status = running ? "运行中" : waiting ? "待确认" : runs.length && completed === runs.length ? "已完成" : "待运行";

  return (
    <article className="workflow-list-card-next">
      <div className="workflow-card-main-next">
        <div className="workflow-title-row-next">
          <h3>{workflow.name}</h3>
          <span>{workflowTypeLabel(workflow.type)}</span>
        </div>
        <p>{workflowCreativeDirectionText(workflow)}</p>
        <div className="workflow-card-meta-next">
          <span>{status}</span>
          <span>{runs.length} 个任务</span>
          <span>创建：{formatWorkflowDate(workflow.createdAt)}</span>
        </div>
        <div className="workflow-progress-next">
          <i style={{ width: `${progress}%` }}></i>
        </div>
      </div>
      <div className="workflow-card-actions-next">
        <button type="button" onClick={onOpen}>
          进入任务
        </button>
        <button className="danger" type="button" onClick={onDelete} disabled={deleting}>
          {deleting ? "删除中" : "×"}
        </button>
      </div>
    </article>
  );
}

function workflowCreativeDirectionText(workflow = {}) {
  if (workflow.type === "ecommerce") {
    const assets = workflow.ecommerceAssets || {};
    const productName = assets.products?.name || workflow.productAssetName || "";
    return workflowUsesInputScript(workflow)
      ? `${productName || "带货产品"} · 输入完整剧本`
      : productName || workflow.topicInspiration || workflow.commentaryTrack || "带货资产组合";
  }
  if (workflow.type === "story") {
    const assets = workflow.ecommerceAssets || {};
    return assets.scripts?.name || assets.roles?.name || workflow.topicInspiration || "故事资产组合";
  }
  return workflow.commentaryTrack || workflow.topicInspiration || (workflow.topicMode === "custom" ? "自定义创意方向" : "未填写创意方向");
}

function workflowTypeLabel(type = "") {
  return workflowTypes.find((item) => item.id === type)?.label || "工作流";
}

function WorkflowDetailShell({ workflow, referenceData, saving, rerunning, refreshing, deletingRunId, retryingRunId, onRefresh, onSave, onRerun, onDeleteRun, onRetryRun, onBack }) {
  const [showConfig, setShowConfig] = useState(false);
  const runs = workflow.runs || [];
  const runGroups = useMemo(() => workflowRunGroups(workflow), [workflow]);
  const runRollup = workflowRunRollup(runs);

  async function handleSaveConfig(nextConfig) {
    const saved = await onSave(nextConfig);
    if (saved) setShowConfig(false);
  }

  return (
    <section className="workflow-panel-next workflow-task-panel-next">
      <article className="workflow-task-card-next">
        <div className="workflow-task-card-head-next">
          <div className="workflow-task-heading-next">
            <button className="secondary-action compact workflow-task-back-next" type="button" onClick={onBack}>
              ← 返回列表
            </button>
            <div className="workflow-task-title-block-next">
              <div className="workflow-title-row-next">
                <h3>{workflow.name}</h3>
                <span>{workflowTypeLabel(workflow.type)}</span>
              </div>
              <p>{workflowCreativeDirectionText(workflow)}</p>
            </div>
          </div>
          <div className="workflow-task-actions-next">
            <button className={`secondary-action compact ${refreshing ? "loading" : ""}`} type="button" disabled={refreshing} onClick={onRefresh}>
              {refreshing ? <span className="workflow-refresh-spinner-next" aria-hidden="true"></span> : "↻"} 刷新状态
            </button>
            <button className="secondary-action compact" type="button" onClick={() => setShowConfig(true)}>
              查看配置
            </button>
            <button className="primary-action compact" type="button" disabled={rerunning} onClick={onRerun}>
              {rerunning ? "运行中" : "再次运行"}
            </button>
          </div>
        </div>

        <div className="workflow-run-tabs-next" role="tablist" aria-label="工作流任务类型">
          <button className="active" type="button">选题任务记录</button>
          <button type="button" disabled>视频制作任务</button>
        </div>

        <WorkflowRunOverview rollup={runRollup} />

        {showConfig ? (
          <WorkflowConfigDialog onClose={() => setShowConfig(false)}>
            <WorkflowConfigEditor workflow={workflow} referenceData={referenceData} saving={saving} onSave={handleSaveConfig} />
          </WorkflowConfigDialog>
        ) : null}

        {refreshing ? (
          <WorkflowPageLoading label="正在刷新任务状态" />
        ) : (
          <WorkflowRunTable
            workflow={workflow}
            runGroups={runGroups}
            deletingRunId={deletingRunId}
            retryingRunId={retryingRunId}
            onDeleteRun={onDeleteRun}
            onRetryRun={onRetryRun}
          />
        )}
      </article>
    </section>
  );
}

function WorkflowPageLoading({ label }) {
  return (
    <div className="workflow-page-loading-next" role="status" aria-live="polite">
      <span className="workflow-refresh-spinner-next" aria-hidden="true"></span>
      <strong>{label}</strong>
    </div>
  );
}

function WorkflowDialogPortal({ children }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

function WorkflowActionDialog({ dialog, busy, onClose, onConfirm }) {
  const tone = dialog.tone || "notice";
  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={busy ? undefined : onClose}>
        <section className="workflow-image-retry-dialog-next workflow-action-dialog-next" role="dialog" aria-modal="true" aria-label={dialog.title} onClick={(event) => event.stopPropagation()}>
          <button className="workflow-dialog-close-next" type="button" disabled={busy} onClick={onClose} aria-label="关闭">×</button>
          <div className="workflow-dialog-title-next">
            <span>{tone === "danger" ? "Delete" : "Confirm"}</span>
            <h3>{dialog.title}</h3>
            <p>{dialog.summary}</p>
          </div>
          <article className={`workflow-dialog-step-next ${tone}`}>
            <span>{dialog.label || "操作对象"}</span>
            <strong>{dialog.target}</strong>
            <p>{dialog.hint || "确认后会立即执行。"}</p>
          </article>
          <div className="workflow-dialog-actions-next">
            <button className="secondary-action compact" type="button" disabled={busy} onClick={onClose}>取消</button>
            <button className={`primary-action compact ${tone === "danger" ? "danger-confirm-next" : ""}`} type="button" disabled={busy} onClick={onConfirm}>
              {busy ? "处理中..." : dialog.confirmText || "确认"}
            </button>
          </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function WorkflowRetryDialog({ dialog, referenceData, busy, onChange, onClose, onConfirm }) {
  const keys = apiKeysForService(referenceData.apiKeys, dialog.apiType);
  const selectedKey = keys.find((key) => key.id === dialog.apiId) || null;
  const models = workflowRetryModelOptions(dialog.apiType, selectedKey);
  const modelValue = models.some((model) => model.id === dialog.modelId) ? dialog.modelId : models[0]?.id || "";
  const audioRetry = dialog.stageId === "audio";
  const audioReferences = audioRetry ? normalizeWorkflowAudioReferences(dialog.audioReferences) : [];
  const audioVoiceMode = dialog.audioVoicePresetId || "default";
  const audioConfigurationReady = !audioRetry
    || audioVoiceMode === "default"
    || (audioVoiceMode === "clone" && audioReferences.length > 0)
    || (audioVoiceMode === "saved" && Boolean(String(dialog.audioReferenceId || "").trim()));
  const audioDialogValue = audioRetry ? {
    audioKeyId: dialog.apiId || "",
    audioModelId: modelValue,
    audioVoice: dialog.audioVoice || "",
    audioFormat: dialog.audioFormat || "mp3",
    audioEmotion: dialog.audioEmotion || "natural",
    audioBitrate: Number(dialog.audioBitrate || 128),
    audioSpeed: Number(dialog.audioSpeed || 1),
    audioVoicePresetId: audioVoiceMode,
    audioReferenceId: dialog.audioReferenceId || "",
    audioReferences,
  } : null;

  useEffect(() => {
    if (!dialog.apiId) return;
    if (dialog.modelId === modelValue) return;
    onChange((current) => current ? { ...current, modelId: modelValue } : current);
  }, [dialog.apiId, dialog.modelId, modelValue]);

  function updateApi(apiId) {
    const key = keys.find((item) => item.id === apiId) || null;
    const nextModels = workflowRetryModelOptions(dialog.apiType, key);
    onChange((current) => current ? {
      ...current,
      apiId,
      modelId: nextModels[0]?.id || "",
    } : current);
  }

  function updateAudioConfig(field, value) {
    if (field === "audioKeyId") {
      updateApi(value);
      return;
    }
    const dialogField = field === "audioModelId" ? "modelId" : field;
    onChange((current) => current ? { ...current, [dialogField]: value } : current);
  }

  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={busy ? undefined : onClose}>
        <section className="workflow-image-retry-dialog-next" role="dialog" aria-modal="true" aria-label={dialog.title} onClick={(event) => event.stopPropagation()}>
          <button className="workflow-dialog-close-next" type="button" disabled={busy} onClick={onClose}>×</button>
          <div className="workflow-dialog-title-next">
            <span>Retry</span>
            <h3>{dialog.title}</h3>
            <p>{dialog.summary}</p>
          </div>
          <article className="workflow-dialog-step-next">
            <span>重试步骤</span>
            <strong>{workflowStageName(dialog.stageId)}</strong>
            <p>{dialog.hint}</p>
            {dialog.stageId === "image" && dialog.missingImageCount ? (
              <p>本次只提交缺失的 {dialog.missingImageCount} 张图片，已成功生成的图片会保留。</p>
            ) : null}
          </article>
          <div className={`workflow-dialog-fields-next ${audioRetry ? "workflow-audio-retry-fields-next" : ""}`}>
            {audioRetry ? (
              <>
                <p className="workflow-audio-retry-note-next">以下配置继承自当前工作流，可以在确认重试前调整。</p>
                <WorkflowAudioConfigFields
                  value={audioDialogValue}
                  audioKeys={keys}
                  audioModels={models}
                  onChange={updateAudioConfig}
                />
              </>
            ) : (
              <>
                <label>
                  渠道
                  <select value={dialog.apiId || ""} onChange={(event) => updateApi(event.target.value)}>
                    <option value="">请选择{workflowRetryTypeName(dialog.apiType)}渠道</option>
                    {keys.map((key) => (
                      <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  模型
                  <select value={modelValue} onChange={(event) => onChange((current) => current ? { ...current, modelId: event.target.value } : current)} disabled={!dialog.apiId}>
                    {models.length ? models.map((model) => (
                      <option value={model.id} key={model.id}>{model.name}</option>
                    )) : <option value="">请先选择渠道</option>}
                  </select>
                </label>
              </>
            )}
          </div>
          <div className="workflow-dialog-actions-next">
            <button className="secondary-action compact" type="button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-action compact" type="button" disabled={busy || !dialog.apiId || !modelValue || !audioConfigurationReady} onClick={() => onConfirm({ ...dialog, modelId: modelValue })}>
              {busy ? "提交中" : "确认重试"}
            </button>
          </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function WorkflowConfigDialog({ children, onClose }) {
  return (
    <WorkflowDialogPortal>
      <div className="workflow-config-dialog-backdrop-next" role="presentation" onClick={onClose}>
        <section className="workflow-config-dialog-next" role="dialog" aria-modal="true" aria-label="工作流配置" onClick={(event) => event.stopPropagation()}>
          <div className="workflow-config-dialog-head-next">
            <div>
              <span>Workflow Config</span>
              <h3>工作流配置</h3>
            </div>
            <button className="workflow-dialog-close-next" type="button" onClick={onClose} aria-label="关闭配置">
              ×
            </button>
          </div>
          {children}
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function WorkflowOverviewPanel({ workflow }) {
  return (
    <div className="workflow-overview-panel-next">
      <div className="workflow-section-head-next">
        <div>
          <p className="eyebrow">Overview</p>
          <h3>工作流基本信息</h3>
        </div>
        <span>只读任务查看</span>
      </div>
      <div className="workflow-detail-grid">
        <DetailItem label="类型" value={workflowTypeLabel(workflow.type)} />
        <DetailItem label="语言" value={workflowLanguageLabel(workflow.language)} />
        <DetailItem label="画幅" value={workflow.ratio || "9:16"} />
        <DetailItem label="选题数量" value={`${Number(workflow.topicCount || 0) || "未设置"}`} />
        <DetailItem label="赛道" value={workflow.commentaryTrack || "未填写"} />
        <DetailItem label="创建时间" value={formatWorkflowDate(workflow.createdAt)} />
      </div>
    </div>
  );
}

function WorkflowPreflightCheck({ preflight }) {
  return (
    <section className={`workflow-preflight-next ${preflight.tone}`}>
      <div className="workflow-preflight-head-next">
        <div>
          <p className="eyebrow">Preflight</p>
          <h3>执行前检查</h3>
          <p>{preflight.summary}</p>
        </div>
        <div className="workflow-preflight-counts-next">
          <span>{preflight.ready} 项就绪</span>
          <span>{preflight.warning} 项建议</span>
          <span>{preflight.missing} 项缺失</span>
        </div>
      </div>
      <div className="workflow-preflight-list-next">
        {preflight.items.map((item) => (
          <article className={item.status} key={item.label}>
            <span>{preflightStatusLabel(item.status)}</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function WorkflowRunRecords({ runGroups, rollup, workflow = null }) {
  return (
    <section className="workflow-run-section">
      <div className="workflow-section-head-next">
        <div>
          <p className="eyebrow">Runs</p>
          <h3>选题任务记录</h3>
        </div>
        <span>{rollup.total} 条记录 · {rollup.children} 个子任务</span>
      </div>
      {rollup.total ? <WorkflowRunOverview rollup={rollup} /> : null}
      <div className="workflow-run-list-next">
        {runGroups.length ? (
          runGroups.map((group) => <WorkflowRunGroup group={group} workflow={workflow} key={group.parent?.id || group.id} />)
        ) : (
          <article className="workflow-empty-next">
            <strong>暂无运行记录</strong>
            <span>当前只读迁移页会在这里展示选题主任务、子任务结果和结果查看入口。</span>
          </article>
        )}
      </div>
    </section>
  );
}

function WorkflowRunOverview({ rollup }) {
  return (
    <div className="workflow-run-overview-next">
      <DetailItem label="运行记录" value={`${rollup.total} 条`} />
      <DetailItem label="主任务" value={`${rollup.main} 条`} />
      <DetailItem label="子任务" value={`${rollup.children} 条`} />
      <DetailItem label="执行中" value={`${rollup.running} 条`} />
      <DetailItem label="已完成" value={`${rollup.done} 条`} />
      <DetailItem label="异常" value={`${rollup.error} 条`} />
    </div>
  );
}

function WorkflowRunTable({ workflow, runGroups, deletingRunId, retryingRunId, onDeleteRun, onRetryRun }) {
  if (!runGroups.length) {
    return (
      <article className="workflow-empty-next">
        <strong>暂无运行记录</strong>
        <span>当前只读迁移页会在这里展示选题主任务、子任务结果和结果查看入口。</span>
      </article>
    );
  }

  const stageCount = workflowStagesForWorkflow(workflow).length;

  return (
    <div className="workflow-run-table-next">
      <div className="workflow-run-row-next workflow-run-header-next">
        <span>选题任务</span>
        <span className="workflow-run-pipeline-heading-next" style={{ "--workflow-stage-count": stageCount }}>
          <b>运行状态流水线</b>
        </span>
        <span>时间</span>
        <span>操作</span>
      </div>
      {runGroups.map((group, groupIndex) => (
        <WorkflowRunTableGroup
          group={group}
          workflow={workflow}
          groupIndex={groupIndex}
          deletingRunId={deletingRunId}
          retryingRunId={retryingRunId}
          onDeleteRun={onDeleteRun}
          onRetryRun={onRetryRun}
          key={group.parent?.id || group.id}
        />
      ))}
    </div>
  );
}

function WorkflowRunTableGroup({ group, workflow, groupIndex, deletingRunId, retryingRunId, onDeleteRun, onRetryRun }) {
  const [childrenOpen, setChildrenOpen] = useState(true);
  const parent = group.parent;

  if (!parent) {
    return group.children.map((run, index) => (
      <WorkflowRunTableRow
        run={run}
        child
        workflow={workflow}
        index={index}
        deleting={deletingRunId === run.id}
        retrying={retryingRunId === run.id}
        onDeleteRun={onDeleteRun}
        onRetryRun={onRetryRun}
        key={run.id || `${group.id}-${index}`}
      />
    ));
  }

  return (
    <>
      <WorkflowRunTableRow
        run={parent}
        workflow={workflow}
        index={groupIndex}
        childCount={group.children.length}
        childrenOpen={childrenOpen}
        onToggleChildren={() => setChildrenOpen((current) => !current)}
        deleting={deletingRunId === parent.id}
        retrying={retryingRunId === parent.id}
        onDeleteRun={onDeleteRun}
        onRetryRun={onRetryRun}
      />
      {childrenOpen ? group.children.map((child, index) => (
        <WorkflowRunTableRow
          run={child}
          child
          workflow={workflow}
          index={index}
          deleting={deletingRunId === child.id}
          retrying={retryingRunId === child.id}
          onDeleteRun={onDeleteRun}
          onRetryRun={onRetryRun}
          key={child.id || `${parent.id}-${index}`}
        />
      )) : null}
    </>
  );
}

function WorkflowRunTableRow({ run, workflow, index, child = false, childCount = 0, childrenOpen = false, deleting = false, retrying = false, onToggleChildren, onDeleteRun, onRetryRun }) {
  const isTopicSeed = run.kind === "topic-seed" || run.kind === "main";
  const serial = run.serial || (child ? index + 1 : index + 1);
  const actionLabel = isTopicSeed ? "查看选题" : "查看结果";
  const title = isTopicSeed ? `运行 #${serial}` : `子任务 #${serial}`;
  const rawTopic = run.topic || (isTopicSeed ? workflow.commentaryTrack || "未命名选题任务" : "未命名子任务");
  const topic = child && isStoryboardWorkflow(workflow) ? workflowTopicTitleOnly(rawTopic) : rawTopic;
  const topicDisplay = child ? splitWorkflowTopicTranslation(topic) : { title: topic, translation: "" };
  const translationTooltipId = topicDisplay.translation ? `workflow-run-topic-translation-${run.id || serial}` : undefined;
  const failedStage = failedWorkflowStage(run, workflow);

  return (
    <div className={`workflow-run-row-next ${child ? "child" : ""}`}>
      <div className="workflow-run-topic-cell-next">
        <strong>{title}</strong>
        {childCount ? (
          <button type="button" onClick={onToggleChildren}>
            {childrenOpen ? "收起" : "展开"} · {childCount} 个子任务
          </button>
        ) : null}
        {topicDisplay.translation ? (
          <span
            className="workflow-topic-translation-trigger-next workflow-run-topic-translation-trigger-next"
            tabIndex={0}
            aria-describedby={translationTooltipId}
          >
            {topicDisplay.title}
            <span id={translationTooltipId} className="workflow-topic-translation-tooltip-next" role="tooltip">
              <b>中文释义</b>
              {topicDisplay.translation}
            </span>
          </span>
        ) : (
          <span>{topicDisplay.title}</span>
        )}
      </div>
      <WorkflowNodeTrack run={run} workflow={workflow} />
      <div className="workflow-run-date-cell-next">
        <time>创建 {formatWorkflowDate(run.createdAt)}</time>
        <time>完成 {run.completedAt ? formatWorkflowDate(run.completedAt) : "-"}</time>
      </div>
      <div className="workflow-run-table-actions-next">
        {failedStage ? (
          <button className="workflow-run-table-link-next retry" type="button" disabled={retrying} onClick={() => onRetryRun(run)}>
            {retrying ? "重试中" : "重试"}
          </button>
        ) : null}
        {run.id ? (
          <Link className="workflow-run-table-link-next" href={`/workflows/run?runId=${encodeURIComponent(run.id)}`} onClick={() => saveWorkflowReturnSnapshot(workflow)}>
            {actionLabel}
          </Link>
        ) : null}
        {run.id ? (
          <button className="workflow-run-delete-next" type="button" disabled={deleting} onClick={() => onDeleteRun(run)} aria-label={`删除${title}`}>
            {deleting ? "…" : "×"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WorkflowConfigEditor({ workflow, referenceData, saving, onSave }) {
  const [draft, setDraft] = useState(() => workflowDraftFrom(workflow));
  const [draftWorkflowId, setDraftWorkflowId] = useState(workflow.id || "");
  const [draftDirty, setDraftDirty] = useState(false);
  const [formError, setFormError] = useState("");
  const llmKeys = apiKeysForService(referenceData.apiKeys, "llm");
  const imageKeys = apiKeysForService(referenceData.apiKeys, "image");
  const audioKeys = apiKeysForService(referenceData.apiKeys, "audio");
  const llmModels = workflowLlmModelOptions(llmKeys.find((key) => key.id === draft.llmKeyId));
  const topicModels = workflowLlmModelOptions(llmKeys.find((key) => key.id === draft.topicLlmKeyId));
  const imageModels = workflowImageModelOptions(imageKeys.find((key) => key.id === draft.imageKeyId));
  const audioModels = workflowAudioModelOptions(audioKeys.find((key) => key.id === draft.audioKeyId));
  const activeImageModel = imageModels.find((model) => model.id === draft.imageModelId) || imageModels[0];
  const imageResolutionOptions = activeImageModel?.resolutions || [];
  const imageRatioOptions = workflowImageRatioOptions(activeImageModel);
  const promptOptions = workflowPromptOptions(referenceData.prompts);
  const visualStyleOptions = workflowVisualStyleOptions(referenceData.visualStyles);
  const ecommerceWorkflow = draft.type === "ecommerce";
  const storyboardWorkflow = isStoryboardWorkflow(draft);
  const customTopicCount = storyboardWorkflow
    ? customTopicItemsForSave(draft.customTopicItems, draft.customTopicsText).length
    : stringListFromLines(draft.customTopicsText).length;
  const topicModelFields = (
    <div className="workflow-control-row-next">
      <label>
        选题 LLM 渠道
        <select value={draft.topicLlmKeyId} onChange={(event) => updateDraft("topicLlmKeyId", event.target.value)}>
          <WorkflowOptionPlaceholder label="请选择选题渠道..." />
          {llmKeys.map((key) => (
            <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
          ))}
        </select>
      </label>
      <label>
        生成模型
        <select value={draft.topicModelId} onChange={(event) => updateDraft("topicModelId", event.target.value)}>
          <WorkflowModelOptions models={topicModels} emptyLabel="请先选择选题渠道" />
        </select>
      </label>
    </div>
  );

  // Silent run polling replaces the workflow object; keep unsaved config edits for the open editor.
  useEffect(() => {
    const nextWorkflowId = workflow.id || "";
    if (draftDirty && draftWorkflowId === nextWorkflowId) return;
    setDraft(workflowDraftFrom(workflow));
    setDraftWorkflowId(nextWorkflowId);
    setDraftDirty(false);
    setFormError("");
  }, [workflow, draftDirty, draftWorkflowId]);

  function updateDraft(key, value) {
    setDraftDirty(true);
    setFormError("");
    setDraft((current) => normalizeWorkflowCreateForm({ ...current, [key]: value }, referenceData, key));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const error = workflowConfigEditorValidationMessage(draft, referenceData);
    if (error) {
      setFormError(error);
      return;
    }
    const saved = await onSave(draft);
    if (!saved) setFormError("工作流配置保存失败，请检查上方配置。");
  }

  return (
    <form className="workflow-config-form-next legacy" onSubmit={handleSubmit}>
      <section className="workflow-form-card-next">
        <h3>基础信息</h3>
        <div className="workflow-control-row-next">
          <label>
            工作流名称
            <input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} />
          </label>
          <label>
            LLM 渠道
            <select value={draft.llmKeyId} onChange={(event) => updateDraft("llmKeyId", event.target.value)}>
              <WorkflowOptionPlaceholder label="请选择 LLM 渠道..." />
              {llmKeys.map((key) => (
                <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="workflow-form-card-next">
        <h3>选题配置</h3>
        <label>
          选题方式
          <select value={draft.topicMode} onChange={(event) => updateDraft("topicMode", event.target.value)}>
            <option value="ai">AI 生成</option>
            <option value="custom">自定义</option>
            {isEcommerceWorkflow(draft) ? <option value="script">输入剧本</option> : null}
          </select>
        </label>
        {workflowUsesInputScript(draft) ? (
          <WorkflowInputScriptEditor
            title={draft.inputScriptTitle}
            value={draft.inputScript}
            durationMode={draft.inputScriptDurationMode}
            targetDurationSeconds={draft.inputScriptTargetDurationSeconds}
            onTitleChange={(nextValue) => updateDraft("inputScriptTitle", nextValue)}
            onChange={(nextValue) => updateDraft("inputScript", nextValue)}
            onDurationModeChange={(nextValue) => updateDraft("inputScriptDurationMode", nextValue)}
            onTargetDurationChange={(nextValue) => updateDraft("inputScriptTargetDurationSeconds", nextValue)}
            compact
          />
        ) : draft.topicMode === "custom" ? (
          storyboardWorkflow ? (
            <div className="workflow-topic-config-next compact">
              <div className="workflow-card-toolbar-next">
                <div>
                  <strong>自定义改编思路</strong>
                  <p>模型会读取这些改编思路生成选题大纲。</p>
                </div>
                <span>已添加 {customTopicCount} 条改编思路</span>
              </div>
              <CustomTopicItemsEditor value={draft.customTopicItems} onChange={(items) => updateDraft("customTopicItems", items)} compact />
              {topicModelFields}
            </div>
          ) : (
            <label>
              自定义选题
              <textarea value={draft.customTopicsText} onChange={(event) => updateDraft("customTopicsText", event.target.value)} rows={4} placeholder="每行一个选题" />
              <span className="workflow-field-help-next">已添加 {customTopicCount} 个选题</span>
            </label>
          )
        ) : (
          <>
            {storyboardWorkflow ? (
              <div className="workflow-topic-count-row-next">
                <label>
                  原创度
                  <input type="range" min="0" max="100" value={draft.topicOriginality ?? 50} onChange={(event) => updateDraft("topicOriginality", event.target.value)} />
                </label>
                <strong>{draft.topicOriginality ?? 50}%</strong>
              </div>
            ) : (
              <label>
                选题灵感
                <textarea value={draft.topicInspiration} onChange={(event) => updateDraft("topicInspiration", event.target.value)} rows={4} />
              </label>
            )}
            {!storyboardWorkflow ? (
              <label>
                解说赛道
                <input value={draft.commentaryTrack} onChange={(event) => updateDraft("commentaryTrack", event.target.value)} />
              </label>
            ) : null}
            <label>
              选题数量
              <input type={storyboardWorkflow ? "range" : "number"} min="1" max="20" value={draft.topicCount} onChange={(event) => updateDraft("topicCount", event.target.value)} />
              {storyboardWorkflow ? <span className="workflow-field-help-next">{draft.topicCount} 个</span> : null}
            </label>
            {topicModelFields}
          </>
        )}
      </section>

      {storyboardWorkflow ? (
        <>
          <EcommerceAssetConfig value={draft} referenceData={referenceData} onChange={updateDraft} definitions={workflowAssetDefinitionsForType(draft.type, draft.topicMode)} />
          <WorkflowRoleReferenceConfig value={draft} referenceData={referenceData} onChange={updateDraft} />
        </>
      ) : null}

      <section className="workflow-form-card-next">
        <h3>文案创意配置</h3>
        <label>
          第一步模型（文案创意）*
          <select value={draft.storyModelId} onChange={(event) => updateDraft("storyModelId", event.target.value)}>
            <WorkflowModelOptions models={llmModels} emptyLabel="请先选择支持的 LLM 渠道" />
          </select>
        </label>
        {storyboardWorkflow ? (
          <WorkflowStoryboardCopyConfig value={draft} onChange={updateDraft} />
        ) : !ecommerceWorkflow ? (
          <>
            <div className="workflow-control-row-next">
              <WorkflowLanguageSelect
                label="文案语言 *"
                placeholder="请选择文案语言"
                value={draft.language}
                options={explainWorkflowLanguageOptions}
                onChange={(value) => updateDraft("language", value)}
              />
              <label>
                写作风格
                <select value={draft.writingStyleId} onChange={(event) => updateDraft("writingStyleId", event.target.value)}>
                  <option value="">不指定</option>
                  {referenceData.writingStyles.map((style) => (
                    <option value={style.id} key={style.id}>{style.name || style.title || "未命名文风"}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              从提示词库导入
              <div className="workflow-inline-import-next">
                <select value={draft.scriptPromptAssetId} onChange={(event) => updateDraft("scriptPromptAssetId", event.target.value)}>
                  <WorkflowPromptOptions prompts={promptOptions} />
                </select>
                <button
                  className="secondary-action compact"
                  type="button"
                  disabled={!draft.scriptPromptAssetId}
                  onClick={() => updateDraft("scriptPrompt", workflowPromptText(promptOptions, draft.scriptPromptAssetId))}
                >
                  导入
                </button>
              </div>
            </label>
            <label>
              文案提示词
              <textarea value={draft.scriptPrompt} onChange={(event) => updateDraft("scriptPrompt", event.target.value)} rows={4} placeholder="可选：补充文案长度、结构、语气、禁用表达或账号要求..." />
            </label>
          </>
        ) : null}
      </section>

      {!storyboardWorkflow ? (
        <section className="workflow-form-card-next">
          <h3>口播音频</h3>
          <WorkflowAudioConfigFields value={draft} audioKeys={audioKeys} audioModels={audioModels} onChange={updateDraft} />
        </section>
      ) : null}

      <section className="workflow-form-card-next">
        <h3>分镜与绘画</h3>
        <label>
          第二步模型（分镜生成）*
          <select value={draft.shotModelId} onChange={(event) => updateDraft("shotModelId", event.target.value)}>
            <WorkflowModelOptions models={llmModels} emptyLabel="请先选择支持的 LLM 渠道" />
          </select>
        </label>
        <div>
          <div className="field-label">分镜风格预设</div>
          <div className="workflow-option-card-grid-next">
            {visualStyleOptions.slice(0, 4).map((style) => (
              <button className={draft.visualStyleId === style.id ? "selected" : ""} type="button" onClick={() => updateDraft("visualStyleId", style.id)} key={style.id}>
                <strong>{style.name || style.title || "未命名图风"}</strong>
                <small>{style.desc || style.description || "使用该图风生成分镜视觉提示。"}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="workflow-control-row-next">
          <label>
            图片渠道
            <select value={draft.imageKeyId} onChange={(event) => updateDraft("imageKeyId", event.target.value)}>
              <WorkflowOptionPlaceholder label="请选择图片渠道..." />
              {imageKeys.map((key) => (
                <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
              ))}
            </select>
          </label>
          <label>
            图片模型
            <select value={draft.imageModelId} onChange={(event) => updateDraft("imageModelId", event.target.value)}>
              <WorkflowModelOptions models={imageModels} emptyLabel="请先选择图片渠道" />
            </select>
          </label>
        </div>
        <div>
          <div className="field-label">图片分辨率 *</div>
          <div className="workflow-option-stepper-next">
            {imageResolutionOptions.length ? imageResolutionOptions.map((resolution) => (
              <button className={draft.imageResolution === resolution ? "selected" : ""} type="button" onClick={() => updateDraft("imageResolution", resolution)} key={resolution}>{resolution}</button>
            )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
          </div>
        </div>
        <div>
          <div className="field-label">图片比例 *</div>
          <div className="workflow-ratio-grid-next">
            {imageRatioOptions.length ? imageRatioOptions.map((ratio) => (
              <button className={draft.ratio === ratio.value ? "selected" : ""} type="button" onClick={() => updateDraft("ratio", ratio.value)} key={ratio.value}>
                {ratio.label}<small>{ratio.detail || ratio.value}</small>
              </button>
            )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
          </div>
        </div>
      </section>

      <div className="workflow-config-savebar-next">
        <span>保存后，再次运行会基于这份配置新建一条主任务。</span>
        <WorkflowFormNotice state={formError ? "error" : ""} message={formError} />
        <button className="primary-action compact" type="submit" disabled={saving}>
          {saving ? "保存中..." : "保存修改"}
        </button>
      </div>
    </form>
  );
}

function workflowConfigEditorValidationMessage(draft = {}, referenceData = emptyWorkflowReferences) {
  const name = String(draft.name || "").trim();
  if (!name) return "请填写工作流名称。";
  const validationMessage = validateWorkflowConfigForSave({ ...draft, name });
  if (validationMessage) return validationMessage;
  if (draft.type === "ecommerce") {
    const ecommerceAssets = workflowEcommerceAssetSnapshot(referenceData, draft);
    if (ecommerceProductAssetsMissingImages(ecommerceAssets.products).length) {
      return "商品库缺少商品图，请先上传商品图后再保存工作流配置。";
    }
  }
  return "";
}

function WorkflowAdvancedConfig({ groups }) {
  return (
    <section className="workflow-advanced-config-next">
      <div className="workflow-config-form-head">
        <p className="eyebrow">Advanced</p>
        <h3>高级配置</h3>
      </div>
      <div className="workflow-advanced-grid-next">
        {groups.map((group) => (
          <article className="workflow-advanced-card-next" key={group.title}>
            <h4>{group.title}</h4>
            <div>
              {group.items.map((item) => (
                <dl key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value || "未设置"}</dd>
                </dl>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DetailItem({ label, value }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function WorkflowRunCard({ run, childRuns = [], workflow = null }) {
  const [expanded, setExpanded] = useState(run.kind === "topic-seed" || run.kind === "main");
  const summary = workflowRunSummary(run);
  const progress = workflowRunStageProgress(run, workflow);
  const inputScriptMode = workflowUsesInputScript(workflow);
  const topicSummary = inputScriptMode ? emptyTopicSummary() : workflowTopicSummary(run, childRuns);
  const resultItems = workflowResultItems(summary, topicSummary);
  const isTopicSeed = run.kind === "topic-seed" || run.kind === "main";
  const inputScriptChild = inputScriptMode && isTopicSeed
    ? childRuns.find((child) => !workflowTopicChildPendingExecution(child))
    : null;
  const detailRunId = inputScriptChild?.id || run.id;

  return (
    <article className={`workflow-run-card-next ${expanded ? "expanded" : ""} ${run.kind === "topic-child" ? "child" : ""}`}>
      <div className="workflow-run-top-next">
        <div>
          <div className="workflow-run-title-line-next">
            <span>{workflowKindLabel(run.kind)}</span>
          <h4>{run.kind === "topic-child" && isStoryboardWorkflow(workflow) ? workflowTopicTitleOnly(run.topic) : run.topic || "未命名任务"}</h4>
          </div>
          <p>创建 {formatWorkflowDate(run.createdAt)}{run.completedAt ? ` · 完成 ${formatWorkflowDate(run.completedAt)}` : ""}</p>
        </div>
        <div className="workflow-run-actions-next">
          <span className={`workflow-run-status ${run.status || "waiting"}`}>{workflowStatusLabel(run.status)}</span>
          {detailRunId ? (
            <Link className="secondary-action compact workflow-run-link-next" href={`/workflows/run?runId=${encodeURIComponent(detailRunId)}`}>
              {isTopicSeed && !inputScriptMode ? "查看选题" : inputScriptMode && !inputScriptChild ? "继续转换" : "查看结果"}
            </Link>
          ) : null}
          <button className="secondary-action compact" type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "收起" : "展开"}
          </button>
        </div>
      </div>
      <div className="workflow-run-stage-summary-next">
        <strong>{progress.done}/{progress.total} 个节点已完成</strong>
        <span>{progress.activeLabel}</span>
      </div>
      <WorkflowNodeTrack run={run} workflow={workflow} />
      <div className="workflow-run-result-entry-next">
        <span>结果摘要</span>
        <strong>{resultItems.length ? resultItems.join(" · ") : "暂无可展示结果"}</strong>
      </div>
      {expanded ? <WorkflowRunDetail summary={summary} topicSummary={topicSummary} /> : null}
    </article>
  );
}

function WorkflowRunGroup({ group, workflow = null }) {
  const [childrenOpen, setChildrenOpen] = useState(true);
  const parent = group.parent;

  if (!parent) {
    return (
      <section className="workflow-run-group-next">
        {group.children.map((run) => <WorkflowRunCard run={run} workflow={workflow} key={run.id} />)}
      </section>
    );
  }

  return (
    <section className={`workflow-run-group-next ${group.children.length ? "has-children" : ""}`}>
      <div className="workflow-run-group-head-next">
        <div>
          <span>{workflowUsesInputScript(workflow) ? "剧本任务" : "选题任务"}</span>
          <strong>{parent.topic || "未命名任务"}</strong>
        </div>
        {group.children.length ? (
          <button className="secondary-action compact" type="button" onClick={() => setChildrenOpen((current) => !current)}>
            {childrenOpen ? "收起子任务" : `展开 ${group.children.length} 个子任务`}
          </button>
        ) : null}
      </div>
      <WorkflowRunCard run={parent} childRuns={group.children} workflow={workflow} />
      {group.children.length && childrenOpen ? (
        <div className="workflow-run-children-next">
          <div className="workflow-run-children-label-next">子任务结果</div>
          {group.children.map((child) => <WorkflowRunCard run={child} workflow={workflow} key={child.id} />)}
        </div>
      ) : null}
    </section>
  );
}

function WorkflowNodeTrack({ run, workflow = null }) {
  const stages = workflowStagesForWorkflow(workflow);
  return (
    <div className="workflow-node-track-next" aria-label="节点进度" style={{ "--workflow-stage-count": stages.length }}>
      {stages.map((stage) => {
        const status = workflowStageStatus(run, stage.id, workflow);
        const stageName = stage.id === "topic" && ["queued", "running"].includes(run.backendJobs?.source?.status)
          ? "视频解析"
          : stage.name;
        return (
          <span className={status} title={`${stageName}：${workflowStatusLabel(status)}`} key={stage.id}>
            <i>{workflowStageMark(status)}</i>
            <b>{stageName}</b>
          </span>
        );
      })}
    </div>
  );
}

function WorkflowRunCompactSummary({ summary }) {
  if (!summary.hasResult) {
    return <p className="workflow-run-empty-next compact">暂无可展示结果</p>;
  }

  const items = [
    summary.topics.length ? `选题 ${summary.topics.length}` : "",
    summary.script ? `文案 ${summary.scriptCharCount || countWorkflowChars(summary.script)} 字` : "",
    summary.audioUrl || summary.audioSegmentCount ? `音频 ${summary.audioSegmentCount || 0} 句` : "",
    summary.shots.length ? `分镜 ${summary.shots.length}` : "",
    summary.imageShots.length ? `图片 ${summary.imageShots.length}` : "",
    summary.timelineCount ? `时间线 ${summary.timelineCount}` : "",
    summary.videoCount ? `视频 ${summary.videoCount}` : "",
  ].filter(Boolean);

  return (
    <div className="workflow-run-compact-summary-next">
      {items.map((item) => <span key={item}>{item}</span>)}
    </div>
  );
}

function workflowResultItems(summary, topicSummary) {
  return [
    topicSummary.hasTopics ? `选题 ${topicSummary.total}` : "",
    summary.script ? `文案 ${summary.scriptCharCount || countWorkflowChars(summary.script)} 字` : "",
    summary.audioUrl || summary.audioSegmentCount ? `音频 ${summary.audioSegmentCount || 0} 句` : "",
    summary.shots.length ? `分镜 ${summary.shots.length}` : "",
    summary.imageShots.length ? `图片 ${summary.imageShots.length}` : "",
    summary.timelineCount ? `时间线 ${summary.timelineCount}` : "",
    summary.videoCount ? `视频 ${summary.videoCount}` : "",
  ].filter(Boolean);
}

function WorkflowTopicCompactSummary({ summary }) {
  return (
    <div className="workflow-topic-compact-next">
      <span>选题 {summary.total}</span>
      {summary.selected ? <span>已选 {summary.selected}</span> : null}
      {summary.confirmed ? <span>已确认 {summary.confirmed}</span> : null}
      {summary.executed ? <span>已执行 {summary.executed}</span> : null}
      {summary.available ? <span>待处理 {summary.available}</span> : null}
    </div>
  );
}

function WorkflowRunDetail({ summary, topicSummary }) {
  if (!summary.hasResult && !topicSummary.hasTopics) {
    return <p className="workflow-run-empty-next">这条运行记录还没有可展示的生成结果。</p>;
  }

  return (
    <div className="workflow-run-detail-next">
      {topicSummary.hasTopics ? <WorkflowTopicResultBlock summary={topicSummary} /> : null}
      {summary.topics.length ? (
        <section className="workflow-result-block-next">
          <h5>选题</h5>
          <div className="workflow-topic-list-next">
            {summary.topics.slice(0, 6).map((topic) => (
              <span key={topic}>{topic}</span>
            ))}
          </div>
        </section>
      ) : null}
      {summary.script ? (
        <section className="workflow-result-block-next">
          <h5>文案</h5>
          <p className="workflow-script-preview-next">{compactWorkflowText(summary.script, 260)}</p>
        </section>
      ) : null}
      {summary.shots.length || summary.shotOutput ? (
        <section className="workflow-result-block-next">
          <h5>分镜</h5>
          <p>{summary.shots.length ? `已生成 ${summary.shots.length} 个分镜。` : compactWorkflowText(summary.shotOutput, 180)}</p>
          {summary.shots.length ? (
            <div className="workflow-shot-list-next">
              {summary.shots.slice(0, 4).map((shot, index) => (
                <article key={shot.id || shot.shotId || `${shot.title || "shot"}-${index}`}>
                  <strong>{shot.title || shot.name || `分镜 ${index + 1}`}</strong>
                  <span>{compactWorkflowText(shot.imagePrompt || shot.prompt || shot.description || shot.text || "", 120) || "暂无分镜描述"}</span>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {summary.imageShots.length ? (
        <section className="workflow-result-block-next">
          <h5>图片</h5>
          <p>已生成 {summary.imageShots.length} 张图片。</p>
          <div className="workflow-image-strip-next">
            {summary.imageShots.slice(0, 6).map((shot, index) => (
              <img src={workflowShotImageUrl(shot)} alt={shot.title || `生成图片 ${index + 1}`} key={shot.id || shot.shotId || workflowShotImageUrl(shot) || index} />
            ))}
          </div>
        </section>
      ) : null}
      {summary.videoCount || summary.timelineCount || summary.videoStatus ? (
        <section className="workflow-result-block-next">
          <h5>视频</h5>
          <p>
            {summary.videoCount ? `视频片段 ${summary.videoCount} 个。` : ""}
            {summary.timelineCount ? `时间线 ${summary.timelineCount} 段。` : ""}
            {summary.videoStatus ? `状态：${workflowStatusLabel(summary.videoStatus)}。` : ""}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function WorkflowTopicResultBlock({ summary }) {
  return (
    <section className="workflow-result-block-next workflow-topic-result-block-next">
      <div className="workflow-topic-result-head-next">
        <div>
          <h5>选题结果</h5>
          <p>{topicGenerationLabel(summary.status)}{summary.error ? `：${summary.error}` : ""}</p>
        </div>
        <span>{summary.total} 个选题</span>
      </div>
      {summary.topics.length ? (
        <div className="workflow-topic-result-list-next">
          {summary.topics.map((item) => (
            <article className={item.state} key={`${item.index}-${item.topic}`}>
              <span>{String(item.index + 1).padStart(2, "0")}</span>
              <strong>{item.topic}</strong>
              <b>{topicStateLabel(item.state)}</b>
            </article>
          ))}
        </div>
      ) : (
        <p className="workflow-run-empty-next compact">还没有可展示的选题。</p>
      )}
    </section>
  );
}

function normalizeWorkflow(workflow, pendingScriptRunIds = new Set()) {
  const config = workflow.config && typeof workflow.config === "object" ? workflow.config : {};
  return {
    ...config,
    id: workflow.id,
    name: workflow.name || config.name || "未命名工作流",
    type: workflow.type || config.type || "explain",
    runs: Array.isArray(workflow.runs)
      ? workflow.runs
        .flatMap((run) => [normalizeWorkflowRun(run, pendingScriptRunIds), ...(run.children || []).map((child) => normalizeWorkflowRun(child, pendingScriptRunIds))])
        .filter((run) => run.status !== "deleted")
      : [],
    createdAt: workflow.createdAt || config.createdAt || "",
    updatedAt: workflow.updatedAt || config.updatedAt || "",
    storedOnServer: true,
  };
}

function normalizeWorkflowRun(run, pendingScriptRunIds = new Set()) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  const kind = run.kind === "main" ? "topic-seed" : run.kind === "child" ? "topic-child" : run.kind;
  const videoPackage = result.videoPackage && typeof result.videoPackage === "object"
    ? result.videoPackage
    : run.videoPackage && typeof run.videoPackage === "object"
      ? run.videoPackage
      : {};
  const normalizedRun = {
    ...run,
    ...result,
    id: run.id,
    workflowId: run.workflowId || result.workflowId || "",
    parentRunId: run.parentRunId || result.parentRunId || "",
    kind: kind || result.kind || "",
    status: run.status || result.status || "waiting",
    stages: run.stages || result.stages || {},
    shots: Array.isArray(result.shots) ? result.shots : Array.isArray(run.shots) ? run.shots : [],
    generatedTopics: Array.isArray(result.generatedTopics) ? result.generatedTopics : Array.isArray(run.generatedTopics) ? run.generatedTopics : [],
    selectedTopics: Array.isArray(result.selectedTopics) ? result.selectedTopics : Array.isArray(run.selectedTopics) ? run.selectedTopics : [],
    confirmedTopics: Array.isArray(result.confirmedTopics) ? result.confirmedTopics : Array.isArray(run.confirmedTopics) ? run.confirmedTopics : [],
    confirmedTopicIndexes: Array.isArray(result.confirmedTopicIndexes) ? result.confirmedTopicIndexes : Array.isArray(run.confirmedTopicIndexes) ? run.confirmedTopicIndexes : [],
    topicAdaptations: result.topicAdaptations && typeof result.topicAdaptations === "object" && !Array.isArray(result.topicAdaptations)
      ? result.topicAdaptations
      : run.topicAdaptations && typeof run.topicAdaptations === "object" && !Array.isArray(run.topicAdaptations)
        ? run.topicAdaptations
        : {},
    topicAdaptation: result.topicAdaptation || run.topicAdaptation || "",
    topicAdaptationBrief: result.topicAdaptationBrief || run.topicAdaptationBrief || "",
    topicGenerationStatus: result.topicGenerationStatus || run.topicGenerationStatus || "",
    topicGenerationError: result.topicGenerationError || run.topicGenerationError || "",
    audio: result.audio && typeof result.audio === "object" ? result.audio : run.audio && typeof run.audio === "object" ? run.audio : {},
    audioUrl: result.audioUrl || result.audio?.audio_url || run.audioUrl || "",
    audioDuration: result.audioDuration || result.audio?.duration || run.audioDuration || 0,
    audioSegments: Array.isArray(result.audioSegments) ? result.audioSegments : Array.isArray(result.audio?.segments) ? result.audio.segments : [],
    subtitleSrt: result.subtitleSrt || result.audio?.subtitle_srt || run.subtitleSrt || "",
    timeline: result.timeline && typeof result.timeline === "object" ? result.timeline : {},
    videoTimeline: Array.isArray(result.videoTimeline) ? result.videoTimeline : Array.isArray(run.videoTimeline) ? run.videoTimeline : [],
    videoResults: Array.isArray(result.videoResults) ? result.videoResults : Array.isArray(run.videoResults) ? run.videoResults : [],
    videoPackage,
    videoPackageStatus: result.videoPackageStatus || run.videoPackageStatus || videoPackage.status || "",
    draft: result.draft && typeof result.draft === "object" ? result.draft : {},
    draftStatus: result.draftStatus || run.draftStatus || result.draft?.status || "",
    draftUrl: result.draftUrl || result.draft?.draft_url || result.draft?.url || run.draftUrl || "",
    draftError: result.draftError || run.draftError || "",
    createdAt: run.createdAt || result.createdAt || "",
    updatedAt: run.updatedAt || result.updatedAt || "",
    completedAt: run.completedAt || result.completedAt || "",
    storedOnServer: true,
    children: undefined,
  };
  return applyPendingWorkflowScriptRun(normalizedRun, pendingScriptRunIds);
}

function applyPendingWorkflowScriptRun(run, pendingScriptRunIds = new Set()) {
  if (!pendingScriptRunIds.has(run.id) || run.kind !== "topic-child") return run;
  const scriptStatus = run.stages?.script || run.backendJobs?.script?.status || "";
  if (["running", "queued", "done", "completed", "error", "failed"].includes(scriptStatus)) return run;
  if (stringFromWorkflowValue(run.scriptOutput || run.script || run.content)) return run;
  return {
    ...run,
    status: ["done", "completed", "error", "failed"].includes(run.status) ? run.status : "running",
    stages: {
      ...(run.stages || {}),
      script: "running",
    },
  };
}

function readPendingWorkflowScriptRunIds() {
  if (typeof window === "undefined") return new Set();
  const now = Date.now();
  try {
    const entries = JSON.parse(window.sessionStorage.getItem(pendingWorkflowScriptRunsKey) || "[]");
    if (!Array.isArray(entries)) return new Set();
    const activeEntries = entries.filter((entry) => Number(entry?.expiresAt || 0) > now);
    if (activeEntries.length !== entries.length) {
      window.sessionStorage.setItem(pendingWorkflowScriptRunsKey, JSON.stringify(activeEntries));
    }
    return new Set(activeEntries.flatMap((entry) => Array.isArray(entry?.childIds) ? entry.childIds : []).filter(Boolean));
  } catch {
    return new Set();
  }
}

function workflowDraftFrom(workflow) {
  const isEcommerceWorkflow = workflow.type === "ecommerce";
  const storyboardWorkflow = isStoryboardWorkflow(workflow);
  const customTopicItems = storyboardWorkflow ? editableCustomTopicItems(workflow.customTopics) : [emptyCustomTopicItem()];
  const customTopicsText = storyboardWorkflow
    ? customTopicTitlesFromItems(customTopicItems).join("\n")
    : Array.isArray(workflow.customTopics)
      ? workflow.customTopics.map((topic) => String(topic || "").trim()).filter(Boolean).join("\n")
      : "";
  const storyVideoSource = workflow.storyVideoSource && typeof workflow.storyVideoSource === "object" ? workflow.storyVideoSource : null;
  const storyVideoSourceFile = storyVideoSource?.sourceFile && typeof storyVideoSource.sourceFile === "object" ? storyVideoSource.sourceFile : null;
  const storyYoutubeUrl = normalizeYoutubeVideoUrl(storyVideoSourceFile?.sourceUrl || storyVideoSourceFile?.fileUrl || "");
  return {
    name: workflow.name || "",
    type: workflow.type || "explain",
    llmKeyId: workflow.llmKeyId || "",
    topicLlmKeyId: workflow.topicLlmKeyId || "",
    topicModelId: workflow.topicModelId || "",
    storyModelId: workflow.storyModelId || "",
    shotModelId: workflow.shotModelId || "",
    imageKeyId: workflow.imageKeyId || "",
    imageModelId: workflow.imageModelId || "",
    imageResolution: workflow.imageResolution || "1k",
    imageSize: workflow.imageSize || workflowImageRequestSize(workflow.ratio),
    audioKeyId: workflow.audioKeyId || "",
    audioModelId: workflow.audioModelId || "",
    audioVoice: workflow.audioVoice || "alloy",
    audioFormat: workflow.audioFormat || "mp3",
    audioEmotion: workflow.audioEmotion || "natural",
    audioBitrate: Number(workflow.audioBitrate || 128),
    audioSpeed: Number(workflow.audioSpeed || 1),
    audioVoicePresetId: workflow.audioVoicePresetId || "default",
    audioReferenceId: workflow.audioReferenceId || "",
    audioReferences: normalizeWorkflowAudioReferences(workflow.audioReferences),
    topicMode: normalizeWorkflowTopicMode(workflow.topicMode, workflow.type),
    inputScriptTitle: workflow.inputScriptTitle || "",
    inputScript: workflow.inputScript || "",
    inputScriptDurationMode: normalizeInputScriptDurationMode(workflow.inputScriptDurationMode),
    inputScriptTargetDurationSeconds: workflow.inputScriptTargetDurationSeconds || "",
    inputScriptShotDurationSeconds: 4.5,
    topicInspiration: workflow.topicInspiration || "",
    topicOriginality: Number(workflow.topicOriginality ?? workflow.config?.topicOriginality ?? 50),
    commentaryTrack: workflow.commentaryTrack || "",
    customTopicsText,
    customTopicItems,
    language: workflowLanguageValueForType(workflow.language, workflow.type),
    audienceProfile: normalizeWorkflowAudienceProfile(workflow.audienceProfile),
    storyEnvironment: normalizeWorkflowStoryEnvironment(workflow.storyEnvironment),
    endingInteractionEnabled: Boolean(workflow.endingInteractionEnabled),
    scriptPrompt: workflow.scriptPrompt || "",
    scriptPromptAssetId: "",
    writingStyleId: workflow.writingStyleId || "",
    visualStyleId: workflow.visualStyleId || "system-real-photo",
    visualStyleName: workflow.visualStyleName || "",
    visualStylePrompt: workflow.visualStylePrompt || "",
    topicCount: Number(workflow.topicCount || 5),
    ratio: workflow.ratio || "9:16",
    shotMode: workflow.shotMode || "standard",
    executionStep: workflow.executionStep || "story",
    storyScriptSourceMode: workflowUsesInputScript(workflow) ? "library" : workflow.storyScriptSourceMode === "direct" ? "direct" : "library",
    storyVideoSourceMode: storyYoutubeUrl ? "youtube" : "upload",
    storyVideoUrl: storyYoutubeUrl,
    storyVideoFile: null,
    storyVideoDurationSeconds: Number(storyVideoSourceFile?.durationSeconds || 0),
    storyVideoName: storyVideoSource?.name || "",
    storyVideoError: "",
    storyVideoSaveToLibrary: Boolean(storyVideoSource?.saveToScriptLibrary),
    storyVideoAnalysisLlmKeyId: storyVideoSource?.analysisLlmKeyId || "",
    storyVideoAnalysisModelId: storyVideoSource?.analysisModelId || "",
    storyVideoAnalysisConfigChanged: false,
    storyVideoSource,
    storyVideoScriptAsset: workflow.storyScriptSourceMode === "direct" ? workflow.ecommerceAssets?.scripts || null : null,
    scriptAssetId: workflowUsesInputScript(workflow) ? "" : workflow.scriptAssetId || workflow.ecommerceAssets?.scripts?.id || "",
    roleAssetId: workflow.roleAssetId || workflow.ecommerceAssets?.roles?.id || "",
    preferRoleLibraryNames: Boolean(workflow.preferRoleLibraryNames),
    roleReferenceImageMode: normalizeRoleReferenceImageMode(workflow.roleReferenceImageMode || workflow.ecommerceAssets?.roleReferenceImageMode, "default"),
    roleReferenceImageSelections: normalizeRoleReferenceImageSelections(workflow.roleReferenceImageSelections || workflow.ecommerceAssets?.roleReferenceImageSelections),
    hookSelectionMode: normalizeEcommerceAssetSelectionMode(workflow.hookSelectionMode, Boolean(workflow.hookAssetId || workflow.ecommerceAssets?.hooks?.id)),
    hookAssetId: normalizeEcommerceAssetSelectionMode(workflow.hookSelectionMode, Boolean(workflow.hookAssetId || workflow.ecommerceAssets?.hooks?.id)) === "specific" ? workflow.hookAssetId || workflow.ecommerceAssets?.hooks?.id || "" : "",
    elementSelectionMode: normalizeEcommerceAssetSelectionMode(workflow.elementSelectionMode, normalizeWorkflowIdList(workflow.elementAssetIds || (workflow.ecommerceAssets?.elements || []).map((asset) => asset.id)).length > 0),
    elementAssetIds: normalizeEcommerceAssetSelectionMode(workflow.elementSelectionMode, normalizeWorkflowIdList(workflow.elementAssetIds || (workflow.ecommerceAssets?.elements || []).map((asset) => asset.id)).length > 0) === "specific"
      ? normalizeWorkflowIdList(workflow.elementAssetIds || (workflow.ecommerceAssets?.elements || []).map((asset) => asset.id)).slice(0, 3)
      : [],
    productAssetId: isEcommerceWorkflow ? workflow.productAssetId || workflow.ecommerceAssets?.products?.id || "" : "",
    strengthenProduct: isEcommerceWorkflow && Boolean(workflow.strengthenProduct),
    purchaseGuidanceEnabled: isEcommerceWorkflow && Boolean(workflow.purchaseGuidanceEnabled),
    purchaseGuidanceText: isEcommerceWorkflow ? String(workflow.purchaseGuidanceText || "") : "",
  };
}

function workflowConfigForSave(workflow, nextConfig) {
  const {
    runs,
    storedOnServer,
    userId,
    ...config
  } = workflow;
  return {
    ...config,
    ...nextConfig,
    id: workflow.id,
  };
}

function workflowAdvancedConfigGroups(workflow, references = emptyWorkflowReferences) {
  const inputScriptMode = workflowUsesInputScript(workflow);
  const topicMode = inputScriptMode ? "输入剧本" : workflow.topicMode === "custom" ? "自定义选题" : "AI 生成";
  const isEcommerce = workflow.type === "ecommerce";
  const storyboardWorkflow = isStoryboardWorkflow(workflow);
  const customTopicCount = storyboardWorkflow
    ? customTopicItemsForSave(workflow.customTopics).length
    : Array.isArray(workflow.customTopics) ? workflow.customTopics.filter(Boolean).length : 0;
  return [
    {
      title: "基础执行",
      items: [
        { label: "默认 LLM 渠道", value: apiKeyName(references.apiKeys, workflow.llmKeyId, "llm") },
        { label: "文案创意模型", value: workflow.storyModelId },
        ...(!storyboardWorkflow ? [
          { label: "口播音频渠道", value: apiKeyName(references.apiKeys, workflow.audioKeyId, "audio") },
          { label: "口播音频模型", value: workflow.audioModelId },
          { label: "音频语速", value: `${Number(workflow.audioSpeed || 1).toFixed(1)}x` },
        ] : []),
        { label: "分镜模型", value: workflow.shotModelId },
      ],
    },
    {
      title: "选题配置",
      items: [
        { label: "选题方式", value: topicMode },
        ...(inputScriptMode ? [
          { label: "剧本标题", value: workflow.inputScriptTitle || "由 AI 根据内容生成" },
          { label: "剧本内容", value: `${String(workflow.inputScript || "").trim().length} 字` },
          { label: "目标时长", value: inputScriptDurationLabel(workflow) },
          { label: "选题节点", value: "跳过" },
        ] : [
          { label: "选题 LLM 渠道", value: apiKeyName(references.apiKeys, workflow.topicLlmKeyId, "llm") },
          { label: "选题模型", value: workflow.topicModelId },
          ...(storyboardWorkflow ? [{ label: "原创度", value: `${Number(workflow.topicOriginality ?? 50)}%` }] : []),
          { label: "选题数量", value: workflow.topicMode === "custom" ? `${customTopicCount} 个自定义选题` : `${Number(workflow.topicCount || 0) || "未设置"} 个` },
        ]),
      ],
    },
    ...(!storyboardWorkflow ? [{
      title: "文案创意",
      items: [
        { label: "文案语言", value: workflowLanguageLabel(workflow.language) },
        { label: "写作风格", value: assetName(references.writingStyles, workflow.writingStyleId) },
        { label: "文案提示词", value: compactWorkflowText(workflow.scriptPrompt || "", 120) },
        { label: "创意方向", value: compactWorkflowText(workflow.topicInspiration || workflow.commentaryTrack || "", 120) },
      ],
    }] : storyboardWorkflow ? [{
      title: isEcommerce ? "带货文案" : "故事文案",
      items: [
        { label: "对白语言", value: workflowLanguageLabel(workflow.language) },
        { label: "用户画像", value: workflowAudienceProfileOptions.find((option) => option.value === normalizeWorkflowAudienceProfile(workflow.audienceProfile))?.label },
        { label: "剧情环境", value: workflowStoryEnvironmentOptions.find((option) => option.value === normalizeWorkflowStoryEnvironment(workflow.storyEnvironment))?.label },
        { label: "角色库姓名", value: workflow.preferRoleLibraryNames ? "优先使用" : "按原逻辑" },
        { label: "结尾互动", value: workflow.endingInteractionEnabled ? "已开启" : "未开启" },
        ...(isEcommerce ? [
          { label: "强化塑品", value: workflow.strengthenProduct ? "已开启" : "未开启" },
          { label: "购买引导", value: workflow.purchaseGuidanceEnabled ? compactWorkflowText(workflow.purchaseGuidanceText || "", 120) : "未开启" },
        ] : []),
        { label: inputScriptMode ? "输入剧本" : "创意方向", value: compactWorkflowText(inputScriptMode ? workflow.inputScript : workflow.topicInspiration || "", 120) },
      ],
    }] : []),
    ...(!storyboardWorkflow ? [{
      title: "口播音频",
      items: [
        { label: "音频渠道", value: apiKeyName(references.apiKeys, workflow.audioKeyId, "audio") },
        { label: "音频模型", value: workflow.audioModelId },
        { label: "输出格式", value: String(workflow.audioFormat || "mp3").toUpperCase() },
        { label: "音色模式", value: workflowAudioVoiceModeName(workflow.audioVoicePresetId) },
        { label: "音色", value: workflow.audioReferenceId || workflow.audioVoice },
      ],
    }] : []),
    {
      title: "分镜与绘画",
      items: [
        { label: "图风库", value: assetName(references.visualStyles, workflow.visualStyleId) },
        { label: "图片渠道", value: apiKeyName(references.apiKeys, workflow.imageKeyId, "image") },
        { label: "图片模型", value: workflow.imageModelId },
        { label: "图片分辨率", value: workflow.imageResolution },
        { label: "图片比例", value: workflow.ratio },
        { label: "分镜模式", value: shotModeLabel(workflow.shotMode) },
        ...(storyboardWorkflow ? [{ label: "角色参考图", value: roleReferenceImageModeLabel(workflow.roleReferenceImageMode) }] : []),
      ],
    },
  ];
}

function workflowPreflightChecks(workflow, references = emptyWorkflowReferences) {
  const hasReferences = Boolean(references.apiKeys.length || references.writingStyles.length || references.visualStyles.length);
  const llmKey = referenceLookup(references.apiKeys, workflow.llmKeyId, "llm");
  const topicKey = referenceLookup(references.apiKeys, workflow.topicLlmKeyId, "llm");
  const imageKey = referenceLookup(references.apiKeys, workflow.imageKeyId, "image");
  const writingStyle = referenceLookup(references.writingStyles, workflow.writingStyleId);
  const visualStyle = referenceLookup(references.visualStyles, workflow.visualStyleId);
  const customTopicMode = workflow.topicMode === "custom";
  const inputScriptMode = workflowUsesInputScript(workflow);
  const storyboardWorkflow = isStoryboardWorkflow(workflow);
  const customTopicCount = storyboardWorkflow
    ? customTopicItemsForSave(workflow.customTopics).length
    : Array.isArray(workflow.customTopics) ? workflow.customTopics.filter(Boolean).length : 0;

  const items = [
    checkRequiredReference("默认 LLM 渠道", workflow.llmKeyId, llmKey, hasReferences, "文案、分镜和优化节点会使用这个渠道。"),
    checkRequiredText("文案创意模型", workflow.storyModelId, "文案节点需要模型 ID。"),
    checkRequiredText(storyboardWorkflow ? "对白语言" : "文案语言", workflowLanguageLabel(workflow.language, ""), storyboardWorkflow ? `${workflowTypeLabel(workflow.type)}需要选择对白语言。` : "口播视频需要选择文案语言。"),
    checkRequiredText("分镜模型", workflow.shotModelId || workflow.storyModelId, "分镜和视频提示词节点需要可用模型。"),
    inputScriptMode
      ? checkRequiredText("完整剧本", workflow.inputScript, "输入剧本模式需要粘贴完整故事剧本。")
      : customTopicMode
      ? checkRequiredCount(storyboardWorkflow ? "自定义改编思路" : "自定义选题", customTopicCount, storyboardWorkflow ? "自定义模式下至少需要 1 条改编思路。" : "自定义选题模式下至少需要 1 个选题。")
      : storyboardWorkflow
        ? checkRequiredCount("原创度", Number(workflow.topicOriginality ?? 50) + 1, `${workflowTypeLabel(workflow.type)}需要设置原创度。`)
        : checkRequiredText("选题方向", workflow.topicInspiration || workflow.commentaryTrack, "AI 选题需要选题灵感或解说赛道。"),
    ...(inputScriptMode || (customTopicMode && !storyboardWorkflow) ? [] : [
      checkRequiredReference("选题 LLM 渠道", workflow.topicLlmKeyId, topicKey, hasReferences, "选题节点需要单独选择选题渠道。"),
      checkRequiredText("选题模型", workflow.topicModelId, "选题生成需要模型 ID。"),
    ]),
    ...(inputScriptMode ? [
      checkRequiredText("商品库", workflow.productAssetId || workflow.ecommerceAssets?.products?.id, "输入剧本模式必须选择带货产品。"),
      normalizeInputScriptDurationMode(workflow.inputScriptDurationMode) === "custom"
        ? checkRequiredMinimumNumber("目标时长", normalizeInputScriptTargetDurationSeconds(workflow.inputScriptTargetDurationSeconds), 4, "指定时长模式需要填写不少于 4 秒的目标时长。")
        : { label: "目标时长", status: "ready", detail: "智能适配 · AI 根据信息量决定镜头数" },
    ] : []),
    checkRequiredReference("图片渠道", workflow.imageKeyId, imageKey, hasReferences, "图片节点需要图片生成渠道。"),
    checkRequiredText("图片模型", workflow.imageModelId, "图片节点需要模型 ID。"),
    checkRequiredText("图片分辨率", workflow.imageResolution, "图片生成需要分辨率或质量参数。"),
    checkRequiredText("图片比例", workflow.ratio, "图片和视频素材需要明确画幅。"),
    ...(!storyboardWorkflow ? [
      checkRecommendedReference("写作风格", workflow.writingStyleId, writingStyle, hasReferences, "未设置时会使用通用文案风格。"),
      checkRecommendedText("文案提示词", workflow.scriptPrompt, "可补充账号语气、结构和禁用表达。"),
    ] : []),
    checkRecommendedReference("图风库", workflow.visualStyleId, visualStyle, hasReferences, "未设置时图片提示词缺少统一视觉风格。"),
    checkRecommendedText("分镜模式", workflow.shotMode, "未设置时默认使用标准分镜。"),
  ];

  const counts = items.reduce((result, item) => ({
    ...result,
    [item.status]: result[item.status] + 1,
  }), { ready: 0, warning: 0, missing: 0 });
  const tone = counts.missing ? "missing" : counts.warning ? "warning" : "ready";
  return {
    ...counts,
    tone,
    summary: preflightSummary(tone, counts),
    items,
  };
}

function checkRequiredReference(label, id, record, hasReferences, readyDetail) {
  if (!id) return { label, status: "missing", detail: "尚未选择。" };
  if (!hasReferences || record) return { label, status: "ready", detail: record?.name || formatApiChannelName(record?.channel) || id || readyDetail };
  return { label, status: "warning", detail: "已保存配置 ID，但当前未在引用数据中读取到对应项。" };
}

function checkRecommendedReference(label, id, record, hasReferences, fallback) {
  if (!id) return { label, status: "warning", detail: fallback };
  if (!hasReferences || record) return { label, status: "ready", detail: record?.name || formatApiChannelName(record?.channel) || id };
  return { label, status: "warning", detail: "已保存配置 ID，但当前未在引用数据中读取到对应项。" };
}

function checkRequiredText(label, value, missingDetail) {
  return stringFromWorkflowValue(value).trim()
    ? { label, status: "ready", detail: stringFromWorkflowValue(value).trim() }
    : { label, status: "missing", detail: missingDetail };
}

function checkRequiredCount(label, count, missingDetail) {
  return count > 0
    ? { label, status: "ready", detail: `${count} 个` }
    : { label, status: "missing", detail: missingDetail };
}

function checkRequiredMinimumNumber(label, value, minimum, missingDetail) {
  return Number(value) >= Number(minimum)
    ? { label, status: "ready", detail: `${Math.round(Number(value))} 秒` }
    : { label, status: "missing", detail: missingDetail };
}

function checkRecommendedText(label, value, fallback) {
  return stringFromWorkflowValue(value).trim()
    ? { label, status: "ready", detail: compactWorkflowText(value, 90) }
    : { label, status: "warning", detail: fallback };
}

function workflowLanguageLabel(language, fallback = "未选择") {
  return workflowLanguageOptions.find((option) => option.value === language)?.label || fallback;
}

function workflowLanguageOptionExists(language, options = workflowLanguageOptions) {
  return options.some((option) => option.value === language);
}

function workflowLanguageValueForType(language, type = "") {
  const options = ["ecommerce", "story"].includes(type) ? workflowLanguageOptions : explainWorkflowLanguageOptions;
  return workflowLanguageOptionExists(language, options) ? language : "";
}

function roleReferenceImageModeLabel(mode) {
  return workflowRoleReferenceModes.find((item) => item.id === normalizeRoleReferenceImageMode(mode))?.label || "使用默认";
}

function referenceLookup(items = [], id, serviceType) {
  if (!id) return null;
  return items.find((item) => item.id === id && (!serviceType || item.serviceType === serviceType)) || null;
}

function preflightSummary(tone, counts) {
  if (tone === "missing") return `有 ${counts.missing} 项关键配置缺失，暂不建议进入执行链路。`;
  if (tone === "warning") return `关键配置基本齐备，还有 ${counts.warning} 项建议补充。`;
  return "关键配置已齐备，可以作为后续执行迁移的检查基础。";
}

function preflightStatusLabel(status) {
  return {
    ready: "就绪",
    warning: "建议",
    missing: "缺失",
  }[status] || "检查";
}

function apiKeyName(apiKeys = [], id, serviceType) {
  if (!id) return "";
  const key = apiKeys.find((item) => item.id === id && (!serviceType || item.serviceType === serviceType));
  if (!key) return id;
  const modelHint = key.model ? ` · ${compactWorkflowText(key.model, 48)}` : "";
  return `${formatApiChannelName(key.channel || id)}${modelHint}`;
}

function assetName(assets = [], id) {
  if (!id) return "";
  return assets.find((item) => item.id === id)?.name || id;
}

function shotModeLabel(mode) {
  return {
    standard: "标准分镜",
    fast: "快速分镜",
    detailed: "精细分镜",
  }[mode] || mode || "";
}

function workflowStats(workflows) {
  const runs = workflows.flatMap((workflow) => workflow.runs || []);
  return {
    total: workflows.length,
    running: workflows.filter((workflow) => (workflow.runs || []).some((run) => run.status === "running")).length,
    completed: workflows.filter((workflow) => {
      const workflowRuns = workflow.runs || [];
      return workflowRuns.length > 0 && workflowRuns.every((run) => ["done", "completed"].includes(run.status));
    }).length,
    runs: runs.length,
  };
}

function workflowRunGroups(workflow) {
  const runs = workflow.runs || [];
  const childrenByParent = runs.reduce((groups, run) => {
    if (run.kind === "topic-child" && run.parentRunId) {
      groups[run.parentRunId] = [...(groups[run.parentRunId] || []), run];
    }
    return groups;
  }, {});
  const groupedChildIds = new Set(Object.values(childrenByParent).flat().map((run) => run.id));
  const mainRuns = runs.filter((run) => run.kind !== "topic-child" || !run.parentRunId);
  const groups = mainRuns.map((run) => ({
    id: run.id || `group-${run.topic || "run"}`,
    parent: run,
    children: childrenByParent[run.id] || [],
  }));
  const orphanChildren = runs.filter((run) => run.kind === "topic-child" && !groupedChildIds.has(run.id) && !mainRuns.some((item) => item.id === run.id));
  if (orphanChildren.length) {
    groups.push({
      id: "orphan-children",
      parent: null,
      children: orphanChildren,
    });
  }
  return groups;
}

function workflowRunRollup(runs) {
  return (runs || []).reduce((rollup, run) => {
    const status = run.status || "waiting";
    return {
      total: rollup.total + 1,
      main: rollup.main + (run.kind === "topic-child" ? 0 : 1),
      children: rollup.children + (run.kind === "topic-child" ? 1 : 0),
      running: rollup.running + (["running", "queued"].includes(status) ? 1 : 0),
      done: rollup.done + (["done", "completed"].includes(status) ? 1 : 0),
      error: rollup.error + (["error", "failed"].includes(status) ? 1 : 0),
    };
  }, { total: 0, main: 0, children: 0, running: 0, done: 0, error: 0 });
}

function workflowRunStageProgress(run, workflow = null) {
  const stages = workflowStagesForWorkflow(workflow);
  const statuses = stages.map((stage) => workflowStageStatus(run, stage.id, workflow));
  const done = statuses.filter((status) => ["done", "completed", "skipped"].includes(status)).length;
  const activeIndex = statuses.findIndex((status) => ["running", "queued", "error", "failed"].includes(status));
  const pendingIndex = statuses.findIndex((status) => ["pending", "waiting", "partial"].includes(status));
  const index = activeIndex >= 0 ? activeIndex : pendingIndex >= 0 ? pendingIndex : statuses.length - 1;
  const activeStage = stages[index];
  const activeStatus = statuses[index] || "pending";
  return {
    total: stages.length,
    done,
    activeLabel: activeStage ? `${activeStage.name} · ${workflowStatusLabel(activeStatus)}` : "未开始",
  };
}

function workflowStageStatus(run, stageId, workflow = null) {
  const status = run.stages?.[stageId] || run.stages?.[stageAlias(stageId)] || "";
  if (stageId === "topic") {
    const sourceStatus = run.backendJobs?.source?.status || run.stages?.source || "";
    if (["running", "queued"].includes(sourceStatus)) return "running";
    if (["error", "failed"].includes(sourceStatus)) return "error";
  }
  if (stageId === "audio") {
    const activeStatus = workflowNodeActiveStatus(run, stageId);
    if (activeStatus) return activeStatus;
  }
  if (stageId === "video") {
    const videoStatus = workflowVideoStageFromResults(run.videoResults, run.videoTimeline);
    if (videoStatus !== "pending") return videoStatus;
    if (Array.isArray(run.videoTimeline) && run.videoTimeline.length) {
      if (["running", "queued", "error", "failed", "partial"].includes(run.videoStatus)) return run.videoStatus;
      if (["running", "queued", "error", "failed", "partial"].includes(status)) return status;
      return "pending";
    }
    if (["running", "queued", "error", "failed", "partial"].includes(run.videoStatus)) return run.videoStatus;
    if (["running", "queued", "error", "failed", "partial"].includes(status)) return status;
    return "pending";
  }
  if (stageId === "image") {
    const shots = (Array.isArray(run.shots) ? run.shots : []).filter(workflowShotRequiresGeneratedImage);
    const hasRunningShot = shots.some((shot) => !workflowShotImageUrl(shot) && ["running", "queued"].includes(shot.imageStatus));
    const imageJobStatus = run.backendJobs?.image?.status || "";
    const missingCount = shots.filter((shot) => !workflowShotImageUrl(shot)).length;
    if (hasRunningShot || (["running", "queued"].includes(run.status) && ["running", "queued"].includes(imageJobStatus))) return "running";
    if (shots.length && !missingCount) return "done";
    if (shots.length && missingCount && ["done", "error", "running", "queued"].includes(status)) return "error";
  }
  if (stageId === "script" && run.scriptOutput) return "done";
  if (stageId === "optimize" && (run.scriptTranslation || run.optimizedScript || run.optimizedOutput)) return "done";
  if (stageId === "optimize" && ["running", "queued", "done", "completed"].includes(workflowStageStatus(run, "audio", workflow))) return "skipped";
  if (stageId === "audio" && (run.audioUrl || run.audio?.audio_url || run.audioSegments?.length || run.audioTracks?.length)) return "done";
  if (stageId === "shot" && (run.shotOutput || run.shots?.length)) return "done";
  if (stageId === "image") {
    const shots = (Array.isArray(run.shots) ? run.shots : []).filter(workflowShotRequiresGeneratedImage);
    if (shots.some((shot) => shot.imageStatus === "running")) return "running";
    if (shots.some((shot) => shot.imageError || shot.imageStatus === "error")) return "error";
    if (shots.length && shots.every((shot) => workflowShotImageUrl(shot))) return "done";
  }
  if (stageId === "videoPrompt" && workflowVideoPromptStageHasOutput(run, workflow)) return "done";
  if (stageId === "draft" && (run.draftUrl || run.draft?.draft_url || run.draftStatus === "done")) return "done";
  if (status) return status;
  return "pending";
}

function workflowTimelineHasVideoPrompts(timeline = []) {
  return Array.isArray(timeline) && timeline.some((item) => stringFromWorkflowValue(item?.videoPrompt).trim());
}

function workflowVideoPromptStageHasOutput(run = {}, workflow = null) {
  const storyboard = isStoryboardWorkflow(workflow || run.workflowSnapshot || run.workflowConfig || run.result?.workflowSnapshot || run.result?.workflowConfig || run);
  if (storyboard) return workflowTimelineHasVideoPrompts(run.videoTimeline);
  return Array.isArray(run.videoTimeline) && run.videoTimeline.length > 0;
}

function workflowVideoStageFromResults(results = [], timeline = []) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return "pending";
  const statuses = list.map(workflowVideoResultStatus);
  if (statuses.some(workflowVideoStatusIsRunning)) return "running";
  if (statuses.some(workflowVideoStatusIsQueued)) return "queued";

  const targets = (Array.isArray(timeline) ? timeline : []).map((item, index) => workflowVideoTargetFromTimelineItem(item, index));
  if (targets.length) {
    const completedTargets = targets.filter((target) =>
      list.some((video) => workflowVideoResultMatchesTarget(video, target) && workflowVideoStatusIsDone(workflowVideoResultStatus(video))));
    if (completedTargets.length === targets.length) return "done";
    if (completedTargets.length || statuses.some(workflowVideoStatusIsDone)) return "partial";
    if (statuses.some(workflowVideoStatusIsFailed)) return "error";
    return "pending";
  }

  if (statuses.every(workflowVideoStatusIsDone)) return "done";
  if (statuses.some(workflowVideoStatusIsDone)) return "partial";
  if (statuses.some(workflowVideoStatusIsFailed)) return "error";
  return "pending";
}

function workflowVideoResultStatus(video = {}) {
  if (workflowVideoUrl(video)) return "done";
  return stringFromWorkflowValue(video?.status).toLowerCase() || "pending";
}

function workflowVideoUrl(video) {
  if (!video) return "";
  if (typeof video === "string") return resolveFlowStudioFileUrl(video);
  return resolveFlowStudioFileUrl(video.videoUrl || video.url || video.fileUrl || video.outputUrl || video.downloadUrl || video.result?.url || "");
}

function workflowVideoStatusIsDone(status = "") {
  return ["done", "completed"].includes(status);
}

function workflowVideoStatusIsQueued(status = "") {
  return ["queued", "pending"].includes(status);
}

function workflowVideoStatusIsRunning(status = "") {
  return ["running", "processing"].includes(status);
}

function workflowVideoStatusIsFailed(status = "") {
  return ["error", "failed", "cancelled", "canceled"].includes(status);
}

function workflowVideoTargetFromTimelineItem(item = {}, index = 0) {
  return {
    timelineItemId: workflowTimelineItemId(item, index),
    title: workflowVideoSegmentLabel(item, index),
  };
}

function workflowTimelineItemId(item = {}, index = 0) {
  return String(item.id || item.segmentId || `${item.shotId || "segment"}-${index}`);
}

function workflowVideoSegmentLabel(item = {}, index = 0) {
  if (item.ecommerceStoryboard && item.title) return item.title;
  const shotIds = Array.isArray(item.shotIds)
    ? item.shotIds.map((shotId) => Number(shotId)).filter((shotId) => Number.isFinite(shotId) && shotId > 0)
    : [];
  const firstIndex = Number(item.startIndex || shotIds[0] || item.index || index + 1) || index + 1;
  const lastIndex = Number(item.endIndex || shotIds[shotIds.length - 1] || firstIndex) || firstIndex;
  const first = String(firstIndex).padStart(2, "0");
  const last = String(lastIndex).padStart(2, "0");
  return first === last ? `分镜 ${first}` : `分镜 ${first}-${last}`;
}

function workflowVideoResultMatchesTarget(video = {}, target = {}) {
  const targetId = stringFromWorkflowValue(target.timelineItemId);
  const videoTimelineId = stringFromWorkflowValue(video?.timelineItemId);
  if (targetId && videoTimelineId && targetId === videoTimelineId) return true;
  const title = stringFromWorkflowValue(target.title);
  return Boolean(title && stringFromWorkflowValue(video?.title) === title);
}

function failedWorkflowStage(run, workflow = null) {
  const sourceStatus = String(run?.backendJobs?.source?.status || run?.storyVideoAnalysis?.status || "").trim().toLowerCase();
  if (["error", "failed"].includes(sourceStatus) || ["error", "failed"].includes(run?.stages?.source)) {
    return { id: "source", name: "视频解析" };
  }
  return workflowStagesForWorkflow(workflow).find((stage) => workflowStageStatus(run, stage.id, workflow) === "error")
    || (["error", "failed"].includes(run?.status) ? workflowStages.find((stage) => stage.id === "topic") : null);
}

function workflowStageName(stageId) {
  return workflowStages.find((stage) => stage.id === stageId)?.name || stageId || "节点";
}

function workflowStagesForWorkflow(workflow = null) {
  const type = workflow?.type || workflow?.workflowType || workflow?.config?.type || "";
  const stages = ["ecommerce", "story"].includes(type) ? workflowStages.filter((stage) => stage.id !== "audio") : workflowStages;
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  return orderWorkflowStageIds(stages.map((stage) => stage.id), workflow).map((stageId) => stageById.get(stageId)).filter(Boolean);
}

function isEcommerceWorkflow(workflow = null) {
  return String(workflow?.type || workflow?.workflowType || workflow?.config?.type || "").trim() === "ecommerce";
}

function isStoryWorkflow(workflow = null) {
  return String(workflow?.type || workflow?.workflowType || workflow?.config?.type || "").trim() === "story";
}

function isStoryboardWorkflow(workflow = null) {
  return isEcommerceWorkflow(workflow) || isStoryWorkflow(workflow);
}

function workflowAssetDefinitionsForType(type = "", topicMode = "") {
  const definitions = type === "story" ? storyAssetDefinitions : ecommerceAssetDefinitions;
  if (type !== "ecommerce" || topicMode !== "script") return definitions;
  return definitions
    .filter((definition) => definition.type !== "script")
    .map((definition) => definition.type === "product"
      ? { ...definition, required: true, emptyLabel: "请选择带货产品" }
      : definition);
}

function normalizeWorkflowTopicMode(value = "", type = "") {
  if (type === "ecommerce" && value === "script") return "script";
  return value === "custom" ? "custom" : "ai";
}

function workflowUsesInputScript(workflow = {}) {
  return isEcommerceWorkflow(workflow) && workflow.topicMode === "script";
}

function normalizeInputScriptDurationMode(value = "") {
  return value === "custom" ? "custom" : "smart";
}

function normalizeInputScriptTargetDurationSeconds(value = 0) {
  const seconds = Math.round(Number(value || 0));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function inputScriptDurationLabel(workflow = {}) {
  if (normalizeInputScriptDurationMode(workflow.inputScriptDurationMode) !== "custom") return "智能适配";
  const seconds = normalizeInputScriptTargetDurationSeconds(workflow.inputScriptTargetDurationSeconds);
  const plan = inputScriptTargetShotPlan(seconds);
  return seconds ? `${seconds} 秒 · 约 ${plan.recommended} 镜（${plan.min}–${plan.max} 镜）` : "指定时长未填写";
}

function inputScriptTargetShotPlan(targetSeconds = 0) {
  const seconds = normalizeInputScriptTargetDurationSeconds(targetSeconds);
  if (!seconds) return { recommended: 0, min: 0, max: 0 };
  const min = Math.max(1, Math.ceil(seconds / 5));
  const max = Math.max(min, Math.ceil(seconds / 4));
  const recommended = Math.max(min, Math.min(max, Math.round(seconds / 4.5)));
  return { recommended, min, max };
}

function workflowRetryType(stageId) {
  if (stageId === "audio") return "audio";
  if (stageId === "image") return "image";
  if (stageId === "video" || stageId === "draft") return "video";
  return "llm";
}

function workflowRetryTypeName(type) {
  return { llm: "LLM", image: "图片生成", video: "视频生成", audio: "音频生成" }[type] || "模型";
}

function workflowRetryApiId(workflow, stageId) {
  if (stageId === "image") return workflow.imageKeyId || "";
  if (stageId === "audio") return workflow.audioKeyId || "";
  if (stageId === "video") return workflow.videoKeyId || workflow.imageKeyId || "";
  if (stageId === "source") return workflow.storyVideoSource?.analysisLlmKeyId || workflow.llmKeyId || "";
  if (stageId === "topic") return workflow.topicLlmKeyId || "";
  return workflow.llmKeyId || "";
}

function workflowRetryModelId(workflow, stageId, models = []) {
  const fallback = models[0]?.id || "";
  if (stageId === "source") return workflow.storyVideoSource?.analysisModelId || fallback;
  if (stageId === "topic") return workflow.topicModelId || fallback;
  if (stageId === "script" || stageId === "optimize") return workflow.storyModelId || fallback;
  if (stageId === "shot" || stageId === "videoPrompt") return workflow.shotModelId || workflow.storyModelId || fallback;
  if (stageId === "image") return workflow.imageModelId || fallback;
  if (stageId === "audio") return workflow.audioModelId || fallback;
  if (stageId === "video") return workflow.videoModelId || fallback;
  return fallback;
}

function workflowRetryModelOptions(type, apiKey) {
  if (type === "image") return workflowImageModelOptions(apiKey);
  if (type === "audio") return workflowAudioModelOptions(apiKey);
  return workflowLlmModelOptions(apiKey);
}

function workflowRetryHint(stageId) {
  return {
    source: "会重新解析原视频，成功后再自动生成选题；不会跳过解析。",
    topic: "会重新生成选题结果。",
    outline: "会从大纲节点开始重新执行后续步骤。",
    script: "会从文案节点开始重新执行后续步骤。",
    optimize: "会重新执行文案优化节点。",
    audio: "会重新生成口播音频和时间戳。",
    shot: "会从分镜节点开始重新执行后续步骤。",
    image: "会只补生成缺失或失败的图片，已成功图片会保留。",
    videoPrompt: "会从视频提示词节点开始重新执行后续步骤。",
    video: "会重新执行视频生成节点。",
    draft: "会重新装配剪映/剪辑草稿。",
  }[stageId] || "本次配置会用于重新执行该节点。";
}

function workflowRetryPayload(workflow, dialog) {
  const payload = {
    retry: true,
    source: "manual-retry",
  };
  if (dialog.apiType === "image") {
    payload.imageKeyId = dialog.apiId;
    payload.imageModelId = dialog.modelId;
    payload.visualStyleId = workflow.visualStyleId || "";
    payload.imageResolution = workflow.imageResolution || "";
    payload.ratio = workflow.ratio || "";
    payload.imageSize = workflow.imageSize || workflowImageRequestSize(workflow.ratio);
    payload.shotIds = Array.isArray(dialog.shotIds) ? dialog.shotIds.filter(Boolean) : [];
    payload.forceRegenerate = false;
    payload.missingOnly = true;
    payload.promptMode = "create-compatible";
    payload.source = "manual-retry-missing-images";
  } else if (dialog.stageId === "source") {
    payload.llmKeyId = dialog.apiId;
    payload.modelId = dialog.modelId;
    payload.topicPayload = workflowTopicQueuePayload(workflow);
  } else if (dialog.stageId === "topic") {
    payload.llmKeyId = dialog.apiId;
    payload.topicModelId = dialog.modelId;
    payload.topicIdea = workflow.topicInspiration || "";
    payload.topicOriginality = workflow.topicOriginality ?? 50;
    payload.niche = workflow.commentaryTrack || "";
    payload.count = workflowTopicGenerationCount(workflow);
  } else if (dialog.stageId === "script" || dialog.stageId === "optimize") {
    payload.llmKeyId = dialog.apiId;
    payload.storyModelId = dialog.modelId;
    payload.modelId = dialog.modelId;
    payload.forceRegenerate = true;
  } else if (dialog.stageId === "audio") {
    payload.audioKeyId = dialog.apiId;
    payload.audioModelId = dialog.modelId;
    payload.modelId = dialog.modelId;
    payload.voice = dialog.audioVoice || "";
    payload.format = dialog.audioFormat || "mp3";
    payload.emotion = dialog.audioEmotion || "natural";
    payload.bitrate = Number(dialog.audioBitrate || 128);
    payload.speed = Number(dialog.audioSpeed || 1);
    payload.voicePresetId = dialog.audioVoicePresetId || "default";
    payload.referenceId = payload.voicePresetId === "saved" ? String(dialog.audioReferenceId || "").trim() : "";
    payload.references = payload.voicePresetId === "clone" ? normalizeWorkflowAudioReferences(dialog.audioReferences) : [];
  } else if (dialog.stageId === "draft") {
    payload.source = "manual-retry-draft";
  } else {
    payload.llmKeyId = dialog.apiId;
    payload.shotModelId = dialog.modelId;
    payload.modelId = dialog.modelId;
    payload.autoImages = dialog.stageId === "shot";
    if (dialog.stageId === "shot") {
      payload.imageKeyId = workflow.imageKeyId || "";
      payload.imageModelId = workflow.imageModelId || "";
      payload.visualStyleId = workflow.visualStyleId || "";
      payload.imageResolution = workflow.imageResolution || "";
      payload.ratio = workflow.ratio || "";
      payload.imageSize = workflow.imageSize || workflowImageRequestSize(workflow.ratio);
    }
  }
  return payload;
}

function workflowStagesAfterRetry(run, stageId, workflow = null) {
  const nextStages = { ...(run.stages || {}) };
  if (stageId === "source") {
    nextStages.source = "running";
    workflowStagesForWorkflow(workflow).forEach((stage) => {
      nextStages[stage.id] = "pending";
    });
    return nextStages;
  }
  let reached = false;
  workflowStagesForWorkflow(workflow).forEach((stage) => {
    if (stage.id === stageId) reached = true;
    if (!reached) return;
    nextStages[stage.id] = stage.id === stageId ? "running" : "pending";
  });
  if (stageId === "script" || stageId === "shot" || stageId === "image") {
    nextStages.topic = run.kind === "topic-child" ? "skipped" : nextStages.topic || "done";
    nextStages.outline = "skipped";
  }
  if (stageId === "shot" || stageId === "image") {
    nextStages.script = "done";
  }
  if (stageId === "image") {
    nextStages.shot = "done";
  }
  return nextStages;
}

function stageAlias(stageId) {
  return {
    shot: "shots",
    image: "images",
    videoPrompt: "video_prompt",
  }[stageId] || stageId;
}

function workflowStageMark(status) {
  if (["done", "completed"].includes(status)) return "✓";
  if (["error", "failed"].includes(status)) return "!";
  if (status === "skipped") return "-";
  if (status === "partial") return "•";
  if (["running", "queued"].includes(status)) return "•";
  return "";
}

function workflowStatusLabel(status) {
  return {
    done: "已完成",
    completed: "已完成",
    running: "执行中",
    error: "有问题",
    failed: "失败",
    partial: "部分完成",
    waiting: "待确认",
    pending: "未开始",
    skipped: "已跳过",
    queued: "排队中",
  }[status] || "未开始";
}

function workflowStageLabel(stage) {
  return {
    topic: "选题",
    topics: "选题",
    outline: "大纲",
    script: "文案",
    optimize: "优化",
    shot: "分镜",
    shots: "分镜",
    image: "图片",
    images: "图片",
    videoPrompt: "视频提示",
    video: "视频",
  }[stage] || stage;
}

function workflowKindLabel(kind) {
  return {
    "topic-seed": "选题任务",
    "topic-child": "子任务",
    main: "主任务",
    child: "子任务",
  }[kind] || "工作流任务";
}

function workflowTopicSummary(run, childRuns = []) {
  if (run.kind !== "topic-seed" && run.kind !== "main") {
    return emptyTopicSummary();
  }

  const generatedTopics = Array.isArray(run.generatedTopics) ? run.generatedTopics.map(stringFromWorkflowValue).filter(Boolean) : [];
  const confirmedTopics = Array.isArray(run.confirmedTopics) ? run.confirmedTopics.map(stringFromWorkflowValue).filter(Boolean) : [];
  const selectedIndexes = numberSet(run.selectedTopics);
  const confirmedIndexes = numberSet(run.confirmedTopicIndexes);
  const childTopicSet = new Set((childRuns || []).map((child) => stringFromWorkflowValue(child.topic)).filter(Boolean));
  const confirmedTopicSet = new Set([...confirmedTopics, ...childTopicSet]);

  const topics = generatedTopics.map((topic, index) => {
    const executed = childTopicSet.has(topic);
    const confirmed = confirmedIndexes.has(index) || confirmedTopicSet.has(topic);
    const selected = selectedIndexes.has(index);
    return {
      index,
      topic,
      state: executed ? "executed" : confirmed ? "confirmed" : selected ? "selected" : "available",
    };
  });

  confirmedTopics.forEach((topic) => {
    if (topics.some((item) => item.topic === topic)) return;
    topics.push({
      index: topics.length,
      topic,
      state: childTopicSet.has(topic) ? "executed" : "confirmed",
    });
  });

  return {
    hasTopics: Boolean(topics.length || run.topicGenerationStatus || run.topicGenerationError),
    status: run.topicGenerationStatus || (topics.length ? "ready" : ""),
    error: run.topicGenerationError || "",
    total: topics.length,
    selected: topics.filter((item) => item.state === "selected").length,
    confirmed: topics.filter((item) => item.state === "confirmed").length,
    executed: topics.filter((item) => item.state === "executed").length,
    available: topics.filter((item) => item.state === "available").length,
    topics,
  };
}

function emptyTopicSummary() {
  return {
    hasTopics: false,
    status: "",
    error: "",
    total: 0,
    selected: 0,
    confirmed: 0,
    executed: 0,
    available: 0,
    topics: [],
  };
}

function numberSet(values) {
  return new Set((Array.isArray(values) ? values : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0));
}

function topicGenerationLabel(status) {
  return {
    running: "选题生成中",
    error: "选题生成失败",
    confirmed: "选题已确认",
    done: "选题已生成",
    ready: "选题已生成",
    waiting: "等待选题确认",
  }[status] || "选题结果";
}

function topicStateLabel(state) {
  return {
    executed: "已执行",
    confirmed: "已确认",
    selected: "已选择",
    available: "待处理",
  }[state] || "待处理";
}

function workflowRunSummary(run) {
  const shots = Array.isArray(run.shots) ? run.shots : [];
  const imageShots = shots.filter((shot) => workflowShotImageUrl(shot));
  const videoResults = Array.isArray(run.videoResults) ? run.videoResults : [];
  const videoTimeline = Array.isArray(run.videoTimeline) ? run.videoTimeline : [];
  const topics = uniqueWorkflowTextList([
    ...(Array.isArray(run.confirmedTopics) ? run.confirmedTopics : []),
    ...(Array.isArray(run.selectedTopics) ? run.selectedTopics.filter((topic) => typeof topic === "string") : []),
    ...(Array.isArray(run.generatedTopics) ? run.generatedTopics : []),
  ]);
  const script = stringFromWorkflowValue(run.scriptOutput || run.script || run.optimizedScript);
  const shotOutput = stringFromWorkflowValue(run.shotOutput);
  const audioUrl = run.audioUrl || run.audio?.audio_url || "";
  const audioSegments = Array.isArray(run.audioSegments) ? run.audioSegments : Array.isArray(run.audio?.segments) ? run.audio.segments : [];
  const draftUrl = run.draftUrl || run.draft?.draft_url || run.draft?.url || "";
  const computedVideoStatus = workflowVideoStageFromResults(videoResults, videoTimeline);
  let videoStatus = run.videoPackageStatus || run.videoPackage?.status || "";
  if (!videoStatus && computedVideoStatus !== "pending") videoStatus = computedVideoStatus;
  if (!videoStatus && !videoTimeline.length) videoStatus = run.videoStatus || "";

  return {
    topics,
    script,
    scriptCharCount: Number(run.scriptCharCount || script.length),
    shots,
    shotOutput,
    imageShots,
    audioUrl,
    audioSegments,
    audioSegmentCount: Number(run.audioSegmentCount || audioSegments.length),
    draftUrl,
    videoCount: Number(run.videoCount || videoResults.length),
    timelineCount: Number(run.timelineCount || videoTimeline.length),
    videoStatus,
    hasResult: Boolean(topics.length || script || audioUrl || audioSegments.length || shots.length || shotOutput || imageShots.length || videoResults.length || videoTimeline.length || draftUrl || videoStatus),
  };
}

function workflowRunFinalScript(run = {}, workflow = {}) {
  if (isTalkingVideoWorkflow(workflow)) {
    return stringFromWorkflowValue(run.scriptOutput || run.script || run.content).trim();
  }
  return stringFromWorkflowValue(run.optimizedScript || run.optimizedOutput || run.scriptTranslation || run.scriptOutput || run.script || run.content).trim();
}

function workflowResultSnapshot(run = {}, patch = {}) {
  const result = run.result && typeof run.result === "object" ? run.result : {};
  return {
    ...result,
    scriptOutput: run.scriptOutput || result.scriptOutput || "",
    optimizedScript: run.optimizedScript || result.optimizedScript || "",
    optimizedOutput: run.optimizedOutput || result.optimizedOutput || "",
    scriptTranslation: run.scriptTranslation || result.scriptTranslation || "",
    scriptTranslationLanguage: run.scriptTranslationLanguage || result.scriptTranslationLanguage || "",
    shots: Array.isArray(run.shots) ? run.shots : Array.isArray(result.shots) ? result.shots : [],
    ...patch,
  };
}

function buildWorkflowAudioFromGeneratedResult(result = {}, script = "") {
  const rawSegments = workflowArrayFrom(result.segments, result.timestamps, result.data?.segments, result.result?.segments);
  const duration = Number(result.duration || result.audioDuration || result.data?.duration || result.result?.duration || 0);
  const sentenceCount = splitWorkflowSentences(script).length;
  const shouldEstimateSegments = !rawSegments.length || (sentenceCount > rawSegments.length && rawSegments.length <= 1);
  const segments = shouldEstimateSegments ? estimateWorkflowAudioSegments(script, duration) : normalizeWorkflowAudioSegments(rawSegments, script, duration);
  return {
    audio_url: resolveFlowStudioFileUrl(result.audioUrl || result.audio_url || result.url || result.fileUrl || ""),
    duration: duration > 0 ? duration : Number(segments.at(-1)?.end || 0),
    segments,
    subtitle_srt: stringFromWorkflowValue(result.subtitleSrt || result.subtitle_srt || result.srt || result.data?.subtitle_srt || result.result?.subtitle_srt) || workflowSegmentsToSrt(segments),
    source: "generated",
  };
}

function workflowTimelineFromAudio(run = {}, audio = {}) {
  const shots = Array.isArray(run.shots) ? run.shots : [];
  return {
    audio: {
      url: audio.audio_url,
      duration: audio.duration,
    },
    segments: (audio.segments || []).map((segment, index) => {
      const shot = shots[index] || {};
      return {
        ...segment,
        image_url: workflowShotImageUrl(shot),
        video_url: shot.videoUrl || "",
      };
    }),
    subtitle_srt: audio.subtitle_srt,
  };
}

function normalizeWorkflowAudioSegments(segments = [], script = "", totalDuration = 0) {
  const fallbackTexts = splitWorkflowSentences(script);
  let cursor = 0;
  return segments.map((segment, index) => {
    const text = stringFromWorkflowValue(segment.text || segment.sentence || fallbackTexts[index] || "").trim();
    if (!text) return null;
    const start = Number.isFinite(Number(segment.start)) ? Number(segment.start) : cursor;
    const fallbackEnd = index === segments.length - 1 && totalDuration > 0 ? totalDuration : start + estimateWorkflowSentenceDuration(text);
    const end = Math.max(start, Number.isFinite(Number(segment.end)) ? Number(segment.end) : fallbackEnd);
    cursor = end;
    return {
      index: Number(segment.index || index + 1),
      text,
      start: roundWorkflowTime(start),
      end: roundWorkflowTime(end),
    };
  }).filter(Boolean);
}

function estimateWorkflowAudioSegments(script = "", requestedDuration = 0) {
  const sentences = splitWorkflowSentences(script);
  const durations = sentences.map(estimateWorkflowSentenceDuration);
  const rawDuration = durations.reduce((sum, value) => sum + value, 0);
  const scale = requestedDuration > 0 && rawDuration > 0 ? requestedDuration / rawDuration : 1;
  let cursor = 0;
  return sentences.map((text, index) => {
    const start = roundWorkflowTime(cursor);
    const end = roundWorkflowTime(cursor + durations[index] * scale);
    cursor = end;
    return { index: index + 1, text, start, end };
  });
}

function splitWorkflowSentences(script = "") {
  const text = stringFromWorkflowValue(script).replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  return (text.match(/[^。！？!?；;，,：:、.\n]+[。！？!?；;，,：:、.]?/g) || []).map((item) => item.trim()).filter(Boolean);
}

function estimateWorkflowSentenceDuration(text = "") {
  const value = stringFromWorkflowValue(text).trim();
  const latinWords = value.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || [];
  if (latinWords.length >= Math.max(3, value.length / 5)) return Math.max(1.2, latinWords.length / 2.45 + 0.25);
  return Math.max(1.2, value.replace(/\s+/g, "").length / 4.2 + 0.2);
}

function workflowSegmentsToSrt(segments = []) {
  return segments.map((segment, index) => `${index + 1}\n${formatWorkflowSrtTime(segment.start)} --> ${formatWorkflowSrtTime(segment.end)}\n${segment.text}\n`).join("\n");
}

function formatWorkflowSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function roundWorkflowTime(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function workflowArrayFrom(...values) {
  return values.find((value) => Array.isArray(value) && value.length) || [];
}

function uniqueWorkflowTextList(values) {
  const seen = new Set();
  return values.reduce((items, value) => {
    const text = stringFromWorkflowValue(value).trim();
    if (!text || seen.has(text)) return items;
    seen.add(text);
    return [...items, text];
  }, []);
}

function stringFromWorkflowValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringFromWorkflowValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    return value.title || value.topic || value.name || value.text || value.content || value.summary || value.description || value.prompt || value.url || "";
  }
  return "";
}

function countWorkflowChars(text = "") {
  return String(text).replace(/\s/g, "").length;
}

function compactWorkflowText(value, limit = 160) {
  const text = stringFromWorkflowValue(value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}...`;
}

function workflowRunDeleteTarget(workflow, run) {
  const fallback = run?.kind === "topic-child" ? "未命名子任务" : workflow?.name || "未命名任务";
  const topic = run?.kind === "topic-child" && isStoryboardWorkflow(workflow)
    ? workflowTopicTitleOnly(run.topic)
    : run?.topic || workflow?.name || fallback;
  return compactWorkflowText(topic || fallback, 80) || fallback;
}

function workflowTopicTitleOnly(value = "") {
  const text = stringFromWorkflowValue(value).trim();
  if (!text) return "未命名子任务";
  const firstLine = text
    .replace(/\[START_TOPIC_EXAMPLE\]|\[END_TOPIC_EXAMPLE\]/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => {
      const cleanLine = line.replace(/^\s*\d+[、.．)]\s*/, "").trim();
      return cleanLine && !/^(?:\[?选题标题\]?|【选题标题】)\s*[:：]?\s*$/.test(cleanLine) && !/^【(?:开场场景|故事梗概)】/.test(cleanLine);
    }) || text;
  return firstLine
    .replace(/^\s*\d+[、.．)]\s*/, "")
    .replace(/^(?:\[?选题标题\]?|【选题标题】)\s*[:：]?\s*/, "")
    .split(/【(?:开场场景|故事梗概|核心冲突|带货植入|产品植入|转化动机|卖点植入|产品卖点|价格机制|成交引导)】/)[0]
    .trim() || "未命名子任务";
}

function workflowShotId(shot) {
  return stringFromWorkflowValue(shot?.id || shot?.shotId || shot?.uuid || shot?.sceneId || shot?.key);
}

function workflowMissingImageShots(run) {
  return (Array.isArray(run?.shots) ? run.shots : []).filter((shot) => workflowShotRequiresGeneratedImage(shot) && !workflowShotImageUrl(shot));
}

function workflowShotImageUrl(shot) {
  if (!shot || typeof shot !== "object") return "";
  return resolveFlowStudioFileUrl(shot.imageUrl || shot.fileUrl || shot.url || shot.image?.url || shot.result?.url || "");
}

function workflowShotRequiresGeneratedImage(shot) {
  return Boolean(shot);
}

function formatWorkflowDate(value) {
  if (!value) return "已保存";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "已保存";
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });
}
