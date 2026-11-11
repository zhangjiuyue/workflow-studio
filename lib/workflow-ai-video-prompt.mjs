import { sortWorkflowVideoAssetsByFileName } from "./workflow-video-prompt.mjs";

export const workflowAiDirectorVideoPromptRules = [
  "画面平滑过渡，参考图片中的场景与构图和表现力",
  "禁止添加字幕、标签或标注",
  "不要生成任何背景音乐（BGM）或配乐",
  "单镜头同角色唯一：同一镜头中同一角色只能出现一个实体，禁止分身、克隆、镜像替身、并排双人同角或同帧重复出现在画面中",
  "运镜设计要丰富多样，符合短视频审美节奏",
  "风格：真人电影质感，禁止任何艺术画风，自然镜头过渡，统一色调",
  "去掉人物脸部和身上的所有彩绘效果、素描效果和绘画效果，保持真人皮肤质感和真实的衣物质感",
  "必须保持写实、真实摄影、真人实拍的视觉表达，禁止插画、动漫、油画、水彩、CG、3D 渲染或任何艺术转绘感",
];

export function workflowAiDirectorErrorMessage(value = "") {
  const message = String(value || "").trim();
  if (!message) return "";
  if (/(?:^|\b)terminated(?:$|\b)|premature(?:ly)? closed|socket hang up|other side closed|ECONNRESET|UND_ERR_SOCKET|response body.*aborted/i.test(message)) {
    return "模型返回连接意外中断，未获得完整结果。若渠道后台没有请求记录，通常表示请求未被正式受理；若已有记录，则可能已产生费用。请稍后重试。";
  }
  return message;
}

export function workflowAiDirectorTimelineTaskView({
  localTask = null,
  running = false,
  progress = 0,
  failed = false,
  error = "",
  backendJobId = "",
} = {}) {
  if (running) {
    return {
      mode: "ai-director",
      status: "running",
      progress: Math.max(5, Number(progress) || 0),
      done: 0,
      total: 0,
      indeterminate: true,
      detail: "正在分析完整剧本，从零规划视频任务、切镜节奏、人物表演、情绪和时间码；完成后会自动显示结果。",
    };
  }
  if (localTask?.status === "submitting") return localTask;
  if (
    localTask?.status === "running"
    && localTask.jobId
    && String(localTask.jobId) !== String(backendJobId || "")
  ) return localTask;
  if (failed) {
    const detail = workflowAiDirectorErrorMessage(error) || "AI 导演分镜生成失败，请检查模型配置后重试。";
    return {
      mode: "ai-director",
      status: "error",
      progress: 100,
      done: 0,
      total: 0,
      detail,
      error: detail,
    };
  }
  return localTask;
}

export function workflowVideoTimelineHasAiDirectorOutput(timeline = []) {
  return (Array.isArray(timeline) ? timeline : []).some((item) => (
    String(item?.videoPromptMode || "").trim() === "ai-director"
  ));
}

export function workflowStoryboardReadyForVideoTimeline({
  workflowType = "",
  storyboardMode = "",
  aiDirectorPlan = null,
  traditionalStoryboardCount = 0,
} = {}) {
  const storyboardWorkflow = ["story", "ecommerce"].includes(String(workflowType || "").trim());
  if (!storyboardWorkflow) return true;
  if (String(storyboardMode || "").trim() === "ai-director") {
    return Array.isArray(aiDirectorPlan?.segments) && aiDirectorPlan.segments.length > 0;
  }
  return Number(traditionalStoryboardCount) > 0;
}

export function buildWorkflowAiDirectorVideoPrompt({ assets = [], voiceBindings = [], beats = [] } = {}) {
  const orderedAssets = sortWorkflowVideoAssetsByFileName(
    (Array.isArray(assets) ? assets : []).filter((asset) => aiDirectorAssetUrl(asset)),
    (asset) => aiDirectorAssetName(asset),
  );
  const imageLabel = (asset) => `@图片${orderedAssets.indexOf(asset) + 1}`;
  const scenes = orderedAssets.filter((asset) => asset.assetType === "scene");
  const roles = orderedAssets.filter((asset) => asset.assetType === "role");
  const products = orderedAssets.filter((asset) => asset.assetType === "product");
  const lines = [
    `场景参考：${aiDirectorAssetReferenceLine(scenes, imageLabel)}`,
    `角色：${aiDirectorAssetReferenceLine(roles, imageLabel)}`,
  ];
  if (products.length) lines.push(`商品参考：${aiDirectorAssetReferenceLine(products, imageLabel)}`);

  const bindingsByName = new Map(
    normalizeWorkflowAiDirectorVoiceBindings(voiceBindings)
      .map((binding) => [binding.name, binding.voice]),
  );
  const bindingLine = roles
    .map((asset) => aiDirectorAssetName(asset))
    .filter((name) => name && bindingsByName.has(name))
    .map((name) => `${name}｜${bindingsByName.get(name)}`)
    .join("，");
  lines.push(`角色-声线绑定：${bindingLine || "无"}`, "");

  normalizeWorkflowAiDirectorBeats(beats).forEach((beat) => {
    lines.push(`[${formatAiDirectorSeconds(beat.start)}–${formatAiDirectorSeconds(beat.end)}秒]：${beat.description}`, "");
  });
  lines.push("规则：", ...workflowAiDirectorVideoPromptRules.map((rule) => `- ${rule}`));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeWorkflowAiDirectorVoiceBindings(value = []) {
  if (Array.isArray(value)) {
    return value.map((binding) => ({
      name: String(binding?.name || binding?.role || binding?.character || "").trim(),
      voice: String(binding?.voice || binding?.description || binding?.tone || "").trim(),
    })).filter((binding) => binding.name && binding.voice);
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .map(([name, voice]) => ({ name: String(name).trim(), voice: String(voice || "").trim() }))
    .filter((binding) => binding.name && binding.voice);
}

export function normalizeWorkflowAiDirectorBeats(value = []) {
  return (Array.isArray(value) ? value : []).map((beat) => ({
    start: Number(beat?.start),
    end: Number(beat?.end),
    description: String(beat?.description || beat?.prompt || beat?.text || "").trim(),
  })).filter((beat) => Number.isFinite(beat.start) && Number.isFinite(beat.end) && beat.description);
}

function aiDirectorAssetReferenceLine(assets, imageLabel) {
  return assets.length
    ? assets.map((asset) => `${imageLabel(asset)} ${aiDirectorAssetName(asset)}`).join("，")
    : "无";
}

function aiDirectorAssetName(asset = {}) {
  return String(asset.title || asset.name || asset.roleKey || asset.sceneMapping || asset.assetRef || "图片").trim();
}

function aiDirectorAssetUrl(asset = {}) {
  return String(asset.imageUrl || asset.fileUrl || asset.url || "").trim();
}

function formatAiDirectorSeconds(value) {
  const number = Math.round(Number(value || 0) * 10) / 10;
  return Number.isInteger(number) ? String(number) : String(number).replace(/\.0$/, "");
}
