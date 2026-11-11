import { httpError } from "../http.js";
import { listAssets, saveAsset } from "./asset-store.js";
import { proxyLlmCompletion } from "./model-proxy.js";

const writingStyleSystemPrompt = "你是专业的中文写作风格分析师，擅长从原文中提取可复用的写作风格 DNA。请输出结构化中文报告。";

export async function executeWritingStyleAnalysisJob(user, input = {}, config = {}) {
  const assetId = normalizeText(input.assetId || input.id);
  if (!assetId) throw httpError(400, "缺少文风资产 ID。");

  const currentAsset = await findWritingStyleAsset(user.id, assetId, config);
  if (!currentAsset) throw httpError(404, "文风资产不存在或已被删除。");

  const currentPayload = normalizeObject(currentAsset.payload);
  const sourceFile = normalizeSourceFile(input.sourceFile || currentPayload.sourceFiles?.[0]);
  const llmKeyId = normalizeText(input.llmKeyId || currentPayload.llmKeyId);
  const modelId = normalizeText(input.modelId || currentPayload.analysisModelId);
  if (!sourceFile.text) throw httpError(400, "样本文档没有可分析的正文。");
  if (!llmKeyId || !modelId) throw httpError(400, "缺少 LLM 渠道或分析模型。");

  const result = await proxyLlmCompletion({
    apiKeyId: llmKeyId,
    model: modelId,
    taskType: "asset-writing-style-analysis",
    messages: [
      { role: "system", content: writingStyleSystemPrompt },
      { role: "user", content: buildWritingStyleAnalysisPrompt(sourceFile) },
    ],
  }, config, user);
  const report = extractLlmContent(result?.data) || normalizeText(result?.content);
  if (!report) throw new Error("模型没有返回可保存的文风分析结果。");

  const now = new Date().toISOString();
  const name = normalizeText(input.name || currentPayload.name || currentAsset.name || sourceFile.name) || "未命名文风";
  const groupId = normalizeText(input.groupId || currentPayload.groupId || currentAsset.groupId);
  const payload = writingStylePayloadFromAnalysis(report, currentPayload, {
    id: assetId,
    name,
    groupId,
    llmKeyId,
    modelId,
    sourceFile,
    updatedAt: now,
  });
  const asset = await saveAsset(user, "writing-style", {
    id: assetId,
    name,
    groupId,
    createdAt: currentPayload.createdAt || currentAsset.createdAt || input.createdAt || now,
    payload,
  }, config);
  return { asset };
}

export async function markWritingStyleAnalysisError(user, input = {}, config = {}, message = "") {
  const assetId = normalizeText(input.assetId || input.id);
  if (!assetId) return null;
  const currentAsset = await findWritingStyleAsset(user.id, assetId, config).catch(() => null);
  if (!currentAsset) return null;
  const currentPayload = normalizeObject(currentAsset.payload);
  const sourceFile = normalizeSourceFile(input.sourceFile || currentPayload.sourceFiles?.[0]);
  const now = new Date().toISOString();
  const name = normalizeText(input.name || currentPayload.name || currentAsset.name || sourceFile.name) || "未命名文风";
  const groupId = normalizeText(input.groupId || currentPayload.groupId || currentAsset.groupId);
  return await saveAsset(user, "writing-style", {
    id: assetId,
    name,
    groupId,
    createdAt: currentPayload.createdAt || currentAsset.createdAt || input.createdAt || now,
    payload: {
      ...currentPayload,
      id: assetId,
      name,
      groupId,
      tag: "AI 分析",
      desc: "文风分析失败",
      prompt: "",
      analysisStatus: "error",
      analysisError: normalizeText(message) || "后台文风分析失败，请重新上传。",
      analysisModelId: normalizeText(input.modelId || currentPayload.analysisModelId),
      llmKeyId: normalizeText(input.llmKeyId || currentPayload.llmKeyId),
      sourceFiles: sourceFile.name ? [sourceFile] : currentPayload.sourceFiles || [],
      updatedAt: now,
    },
  }, config);
}

export function writingStylePayloadFromAnalysis(report, basePayload = {}, options = {}) {
  const value = normalizeText(report);
  const sourceFile = normalizeSourceFile(options.sourceFile || basePayload.sourceFiles?.[0]);
  return {
    ...basePayload,
    id: normalizeText(options.id || basePayload.id),
    name: normalizeText(options.name || basePayload.name || sourceFile.name) || "未命名文风",
    groupId: normalizeText(options.groupId || basePayload.groupId),
    tag: "AI 分析",
    desc: firstReportSummary(value),
    prompt: value,
    analysisStatus: "done",
    analysisError: "",
    analysisModelId: normalizeText(options.modelId || basePayload.analysisModelId),
    llmKeyId: normalizeText(options.llmKeyId || basePayload.llmKeyId),
    sourceFiles: sourceFile.name ? [sourceFile] : basePayload.sourceFiles || [],
    updatedAt: options.updatedAt || new Date().toISOString(),
  };
}

export function buildWritingStyleAnalysisPrompt(file = {}) {
  return `请分析我上传的文章写作风格 DNA，从以下维度输出结构化报告：

【调性】
- 整体气质（亲切/犀利/幽默/冷峻/学究/江湖/文艺...）
- 与读者的关系（平等聊天/导师指点/朋友吐槽/专家科普...）

【洞察偏好】
- 偏好"说破型"洞察（说出大家想说但没说出的话）还是"看透型"洞察（揭示大家没意识到的真相）？
- 给出 3 个原文例句佐证

【五个表达招数】
- 把大变小（从宏观缩到具体）的使用频率和典型例句
- 把远变近（建立相关性）的使用频率和典型例句
- 把抽象变具体（用场景/数字/故事）的使用频率和典型例句
- 把复杂变简单（删减/直白）的使用频率和典型例句
- 把平淡变精彩（反差/角色互换/意外）的使用频率和典型例句

【句式节奏】
- 平均句长（短促有力 vs 长句绵密）
- 标志性句式（排比？反问？自嘲？设问？）
- 段落长度和换行习惯

【用词指纹】
- 口语化程度（1-10）
- 是否混用英文/网络用语/成语
- 高频口头禅或标志性用词
- 绝对不会用的词（例：综上所述、不是X而是Y）

【观点表达方式】
- 如何提出观点（直述/先讲故事/先提问/先否定常见看法...）
- 如何论证（摆数据/讲案例/用比喻/引用权威...）
- 如何收尾（总结/反问/留悬念/行动号召...）

文章文件名：${normalizeText(file.name)}
文章正文：
${normalizeText(file.text)}`;
}

function firstReportSummary(report = "") {
  const line = String(report)
    .split(/\n+/)
    .map((item) => item.replace(/^[-#*\s]+/, "").trim())
    .find((item) => item && !/^【/.test(item));
  return line ? line.slice(0, 90) : "已通过 AI 分析文章写作风格 DNA。";
}

function extractLlmContent(data) {
  const message = data?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content.trim();
  if (Array.isArray(message?.content)) return message.content.map((part) => part.text || part.content || "").join("\n").trim();
  const geminiText = Array.isArray(data?.candidates)
    ? data.candidates.flatMap((candidate) => candidate?.content?.parts || []).map((part) => part.text || "").join("\n").trim()
    : "";
  return normalizeText(data?.choices?.[0]?.text || data?.output_text || geminiText);
}

async function findWritingStyleAsset(userId, assetId, config) {
  const data = await listAssets(userId, "writing-style", config);
  return (data.assets || []).find((asset) => asset.id === assetId) || null;
}

function normalizeSourceFile(file = {}) {
  const value = file && typeof file === "object" ? file : {};
  return {
    ...value,
    name: normalizeText(value.name),
    type: normalizeText(value.type),
    text: normalizeText(value.text),
    fileUrl: normalizeText(value.fileUrl),
    fileKey: normalizeText(value.fileKey),
    mimeType: normalizeText(value.mimeType),
    size: Number(value.size || 0),
    sizeBytes: Number(value.sizeBytes || value.size || 0),
    status: normalizeText(value.status),
  };
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeText(value = "") {
  return String(value || "").trim();
}
