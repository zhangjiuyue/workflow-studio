export const defaultWorkflowRoleImageStyleId = "mosaic-three";

export const workflowRoleImageStyleOptions = [
  {
    id: "single",
    title: "单人角色图",
    desc: "单张全身角色设计图，正常清晰人脸。",
  },
  {
    id: "sketch-three",
    title: "真人大头三视图",
    desc: "左侧脸部大特写，右侧全身正面、侧面、背面。",
  },
  {
    id: "mosaic-three",
    title: "人脸马赛克三视图",
    desc: "脸部马赛克，身体保持真实摄影的正侧背三视图。",
  },
  {
    id: "custom",
    title: "自定义风格",
    desc: "只使用本次填写的角色图片风格。",
  },
];

const roleImageStyleSegments = [
  /^(?:单人)?全身照$/,
  /^单人角色设计图.*$/,
  /^无表情$/,
  /^双手(?:自然)?下垂$/,
  /^正常清晰人脸$/,
  /^人物脸部(?:打上)?马赛克.*$/,
  /^脸部马赛克.*$/,
  /^其他部分保持真实摄影$/,
  /^身体(?:与其他部分)?保持真实摄影$/,
  /^真实摄影$/,
  /^真人摄影$/,
  /^三视图$/,
  /^全身三视图.*$/,
  /^横屏角色三视图.*$/,
  /^正面[、,，/／\s]*侧面[、,，/／\s]*背面.*$/,
  /^纯灰白色无缝摄影棚背景$/,
  /^纯灰白色摄影棚背景$/,
  /^摄影棚背景$/,
  /^背景中没有任何物体或人物$/,
  /^左侧[：:].*(?:特写|肖像).*右侧[：:].*(?:三视图|正面|侧面|背面).*$/,
  /^左侧[：:].*(?:特写|肖像).*$/,
  /^右侧[：:].*(?:三视图|正面|侧面|背面).*$/,
  /^写实风格$/,
  /^电影级光影$/,
  /^8k分辨率$/i,
  /^超高细节$/,
];

export function normalizeWorkflowRoleImageStyleId(value = "") {
  const id = String(value || "").trim();
  return workflowRoleImageStyleOptions.some((item) => item.id === id)
    ? id
    : defaultWorkflowRoleImageStyleId;
}

export function workflowRoleImageStylePrompt(styleId = defaultWorkflowRoleImageStyleId, customPrompt = "") {
  const normalized = normalizeWorkflowRoleImageStyleId(styleId);
  if (normalized === "custom") return String(customPrompt || "").trim();
  if (normalized === "single") {
    return "单人角色设计图，全身照，无表情，双手自然下垂，正常清晰人脸，真实摄影，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物";
  }
  if (normalized === "sketch-three") {
    return "真人角色设计图，左侧人物脸部大特写肖像，右侧全身正面、侧面、背面三视图，正常清晰人脸，无表情，双手自然下垂，真实摄影，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物";
  }
  return "横屏角色三视图，正面、侧面、背面同屏排列，人物脸部打上马赛克，身体与其他部分保持真实摄影，无表情，双手自然下垂，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物";
}

export function stripWorkflowRoleImageStyle(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .split(/[\n,，；;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const styleCandidate = part
        .replace(/^(?:补充要求|图片要求|构图要求|风格要求)\s*[：:]\s*/, "")
        .replace(/[。.!！]+$/g, "")
        .trim();
      return !roleImageStyleSegments.some((pattern) => pattern.test(styleCandidate));
    })
    .join("，")
    .replace(/[，,]{2,}/g, "，")
    .replace(/^[，,\s]+|[，,\s]+$/g, "")
    .trim();
}
