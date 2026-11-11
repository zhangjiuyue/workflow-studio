export const WORKFLOW_COVER_MAX_ROLE_IMAGES = 9;

export const workflowCoverCountOptions = [1, 2, 3, 4, 5];

export const workflowCoverRealismInstruction = "去掉人物脸部和身上的所有马赛克效果、彩绘效果、素描效果和绘画效果，保持真人皮肤质感和真实的衣物质感。";

export function workflowCoverTypeLabel(type = "") {
  return {
    explain: "口播视频",
    story: "故事视频",
    ecommerce: "带货视频",
    free: "自由创作视频",
  }[String(type || "").trim()] || "视频";
}

export function defaultWorkflowCoverPrompt(type = "") {
  const normalizedType = String(type || "").trim();
  if (normalizedType === "explain") {
    return `这是一条口播视频，请根据视频主题设计一张具有点击吸引力的自媒体封面图。

画面需要准确表达视频的核心观点和情绪，主体清晰，构图简洁，第一眼能够看出视频大致讲什么。如果提供了角色参考图，请保持人物身份、面部特征、发型和整体形象一致，并根据内容设计自然、有感染力的表情和动作。

请按照指定的图片比例进行构图，避免重要人物或主体贴近画面边缘。不要出现平台 Logo、水印、二维码或与内容无关的元素。除非提示词明确要求，否则不要在画面中生成文字。

${workflowCoverRealismInstruction}`;
  }
  if (normalizedType === "story") {
    return `这是一条故事/短剧视频，请根据故事内容设计一张具有点击吸引力的自媒体封面图。

请重点表现故事中最有吸引力的人物关系、核心冲突、悬念、反转方向或情绪瞬间，让画面具有明确的故事感和戏剧张力，但不要直接泄露完整结局。如果提供了角色参考图，请保持人物身份、面部特征、发型、服装特征和整体形象一致。

请按照指定的图片比例进行构图，保证人物关系和画面主次清晰，避免重要人物贴近画面边缘。不要出现平台 Logo、水印、二维码或与故事无关的元素。除非提示词明确要求，否则不要在画面中生成文字。

${workflowCoverRealismInstruction}`;
  }
  if (normalizedType === "ecommerce") {
    return `这是一条带货视频，请把它当作普通的故事/短剧内容来设计一张具有点击吸引力的自媒体封面图。

请重点表现人物关系、情绪、冲突、悬念或反转，让用户首先对视频内容产生兴趣。封面不要设计成传统商品广告，不要刻意突出商品、品牌、价格、优惠信息、购买按钮或促销元素。如果提供了角色参考图，请保持人物身份、面部特征、发型、服装特征和整体形象一致。

请按照指定的图片比例进行构图，保证人物关系和画面主次清晰，避免重要人物贴近画面边缘。不要出现平台 Logo、水印、二维码或与内容无关的元素。除非提示词明确要求，否则不要在画面中生成文字。

${workflowCoverRealismInstruction}`;
  }
  return `这是一条自媒体视频，请根据视频内容设计一张具有点击吸引力的封面图。

画面需要主题明确、主体清晰、构图简洁，并准确表达视频的核心内容和情绪。如果提供了角色参考图，请保持人物身份和主要外观特征一致。

请按照指定的图片比例进行构图，避免重要主体贴近画面边缘。不要出现平台 Logo、水印、二维码或无关元素。除非提示词明确要求，否则不要在画面中生成文字。

${workflowCoverRealismInstruction}`;
}

export function composeWorkflowCoverInstruction(input = {}) {
  const type = String(input.type || "").trim();
  const includeSystemPrompt = input.includeSystemPrompt !== false;
  const userPrompt = String(input.userPrompt || "").trim();
  const sections = [];

  if (includeSystemPrompt) sections.push(defaultWorkflowCoverPrompt(type));
  if (userPrompt) {
    sections.push(includeSystemPrompt ? `【用户补充要求】\n${userPrompt}` : userPrompt);
  }

  return sections.join("\n\n");
}

export function workflowCoverContentReferenceLabel(type = "") {
  return ["story", "ecommerce"].includes(String(type || "").trim())
    ? "引用当前选题大纲"
    : "引用当前选题和最终文案";
}

export function buildWorkflowCoverPrompt(input = {}) {
  const type = String(input.type || "").trim();
  const prompt = String(input.prompt || defaultWorkflowCoverPrompt(type)).trim();
  const topic = String(input.topic || "").trim();
  const script = String(input.script || "").trim();
  const roleReferenceCount = Math.max(0, Number(input.roleReferenceCount || 0));
  const sections = [prompt];

  if (roleReferenceCount) {
    sections.push(`【角色参考图】\n本次提供了 ${roleReferenceCount} 张角色参考图。请参考图片保持对应角色身份和核心外观一致，不要把不同角色的五官或服装特征混合。`);
  }

  if (input.includeContentReference) {
    if (["story", "ecommerce"].includes(type)) {
      if (topic) sections.push(`【选题大纲】\n${topic}`);
    } else {
      if (topic) sections.push(`【视频选题】\n${topic}`);
      if (script) sections.push(`【最终文案】\n${script}`);
    }
  }

  return sections.filter(Boolean).join("\n\n");
}

export function validateWorkflowCoverRoleCount(count = 0) {
  const normalizedCount = Math.max(0, Number(count || 0));
  if (normalizedCount <= WORKFLOW_COVER_MAX_ROLE_IMAGES) return "";
  return `角色参考图最多选择 ${WORKFLOW_COVER_MAX_ROLE_IMAGES} 张，当前已选择 ${normalizedCount} 张。`;
}

export function normalizeWorkflowCoverCount(value = 1) {
  const count = Math.round(Number(value || 1));
  return Math.max(1, Math.min(5, Number.isFinite(count) ? count : 1));
}

export function collectWorkflowCoverRoleImages(run = {}) {
  const shots = Array.isArray(run.shots) ? run.shots : [];
  const seen = new Set();
  return shots.filter((shot) => shot?.assetType === "role").map((shot, index) => ({
    id: String(shot.id || shot.shotId || workflowCoverRoleImageUrl(shot) || `run-role-${index + 1}`),
    name: String(shot.title || shot.name || shot.roleName || shot.roleKey || `角色图 ${index + 1}`),
    url: workflowCoverRoleImageUrl(shot),
    thumbnailUrl: workflowCoverRoleThumbnailUrl(shot),
  })).filter((image) => image.url).filter((image) => {
    if (seen.has(image.url)) return false;
    seen.add(image.url);
    return true;
  });
}

function workflowCoverRoleImageUrl(shot = {}) {
  return String(shot.imageUrl || shot.fileUrl || shot.url || shot.image?.url || shot.result?.url || "").trim();
}

function workflowCoverRoleThumbnailUrl(shot = {}) {
  return String(shot.imageThumbnailUrl || shot.thumbnailUrl || shot.thumbUrl || shot.image?.thumbnailUrl || shot.result?.thumbnailUrl || "").trim();
}
