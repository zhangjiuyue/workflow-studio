import { getDecryptedApiKey } from './api-key-store.js';
import { trustedApiPolicy } from './trusted-api-registry.js';
import { httpError } from "../http.js";
import { listAssets, saveAsset } from "./asset-store.js";
import { proxyLlmCompletion } from "./model-proxy.js";
import { normalizeYoutubeVideoUrl } from "../lib/youtube-video-url.mjs";

const scriptVideoAnalysisPrompt = `# Role: 爆款短视频脚本复原分析师

# Mission
你将分析上传的对标视频，把它沉淀为“原视频脚本复原版 + 扩写规则”。这个资产将用于后续工作流基于对标视频进行创作，所以最重要的是完整保留原视频的剧情结构、人物关系、产品出场位置、镜头节奏和对白风格。

# Core Objective
请输出一份可以直接保存为脚本资产的固定标题纯文本。你需要识别并保留：
- 人物角色：主角、配角和可确认边缘人物的数量、人物关系；如果用户指定角色数量，以指定数量为目标，但不能凭空捏造没有出现在视频中的人物
- 原时长：记录原视频真实时长，用秒数表示
- 目标时长：记录本次脚本资产的目标时长；未自定义时等于原时长
- 有无对白：按整个原视频判断，有台词/旁白/口播就是“有”，几乎没有台词就是“无”
- 产品首次出场比例：产品首次明确出场的时间点和占比
- 原视频脚本复原：按 4-5 秒一镜尽量完整复原，每镜保留镜头画面、角色对白和备注
- 扩写规则：后续扩写到目标时长时，如何在不破坏原爆款结构的前提下扩充内容

# Product Reveal Definition
“产品首次出场”包括：产品实物、包装、品牌名、产品名、明确卖点、价格机制、购买动作，或任何让观众已经知道具体商品的表达。普通痛点、需求、人物冲突和泛泛解决方向不算产品首次出场。

# Output Rules
必须只返回下面固定标题的纯文本，不要输出 JSON、Markdown 代码块、解释、问候或额外章节。标题名、字段名和顺序必须保持一致。未知内容用“未识别”，但原时长、目标时长和角色数量必须尽量给出数字；如果无法读取精确原时长，请优先使用上传元信息中的时长，禁止把已知时长填 0。

【脚本资产摘要】
原时长：0 秒
目标时长：0 秒
角色数量：0
有无对白：有/无
产品首次出场：约 0%，约 0 秒；依据：一句话说明判断依据

【核心人物】
主角数量：0
配角数量：0
人物关系：一句话说明核心人物关系和冲突张力
角色清单：
1. 角色名或代号（主角/配角/可确认边缘人物）：身份、性格、穿搭、行为特征，以及在冲突中的作用

【原视频脚本复原】
镜头粒度：约 4-5 秒一镜
镜头数量：0

第 1 镜：0-5 秒｜场景/景别
【画面内容】 用具体画面、动作、表情、场景和调度复原这一镜，不要空泛概括。
【角色对白】 角色名（语气）：还原台词意思和说话风格；这一镜没有对白就写“无对白”。
【备注】 说明这一镜的剧情作用、情绪作用、反转作用、产品作用或转化作用。

第 2 镜：5-10 秒｜场景/景别
【画面内容】 ...
【角色对白】 ...
【备注】 ...

【扩写规则】
1. 目标时长只作为后续扩写参考，本次资产不输出目标时长版完整脚本。
2. 扩写时必须保持原视频剧情结构和阶段顺序，只扩充每个阶段内部的有效内容，不要重排产品出场、反转、卖点释放和转化收口的位置。
3. 产品首次出场必须保持相同相对比例。例如原视频在 75% 左右首次明确出场，目标时长版也应在 75% 左右首次明确出场。
4. 扩写优先增加真实剧情冲突、人物试探、误会升级、伏笔回收、使用场景、用户顾虑、产品细节、前后对比、信任背书、价格机制解释和评论互动收束。
5. 扩写对白时要保留原视频角色说话风格、语气强弱、信息释放顺序和冲突节奏，不追求逐字复刻，但不能改变人物关系和核心矛盾。
6. 如果原视频几乎没有对白，扩写也应以剧情动作和画面推进为主，不要强行加入大量口播。
7. 不要用空镜、重复对白、无意义等待、黑场或纯情绪拉扯来凑目标时长。

【风险提示】
1. 说明后续复用这个脚本资产时最容易破坏原结构的风险。`;

const videoAnalysisTimeoutMinutes = 20;
const videoAnalysisTimeoutMs = videoAnalysisTimeoutMinutes * 60 * 1000;
const videoAnalysisMaxTimeoutMs = videoAnalysisTimeoutMs;
const videoAnalysisRetryDelayMs = 4000;
const videoAnalysisMaxAttempts = 3;
const scriptFallbackSecondsPerShot = 5;
const scriptMaxDisplayRoleCount = 20;
export const videoAnalysisModelId = "";

export async function executeScriptAssetVideoAnalysisJob(user, input = {}, config = {}) {
  const assetId = normalizeId(input.assetId || input.id);
  if (!assetId) throw httpError(400, "缺少脚本资产 ID。");

  const currentAsset = await findScriptAsset(user.id, assetId, config);
  if (!currentAsset) throw httpError(404, "脚本资产不存在或已被删除。");

  const currentPayload = normalizeObject(currentAsset.payload);
  const analysisInput = {
    ...currentPayload,
    ...input,
    sourceFile: input.sourceFile || currentPayload.sourceFile,
    name: input.name || currentPayload.name || currentAsset.name,
    groupId: input.groupId || currentPayload.groupId || currentAsset.groupId,
    modelId: input.modelId || currentPayload.analysisModelId,
    llmKeyId: input.llmKeyId || currentPayload.llmKeyId,
    createdAt: currentPayload.createdAt || currentAsset.createdAt || input.createdAt,
    analysisStartedAt: input.analysisStartedAt || currentPayload.analysisStartedAt,
    analysisTimeoutMs: input.analysisTimeoutMs || currentPayload.analysisTimeoutMs,
  };
  const analysis = await analyzeScriptVideoSource(user, analysisInput, config, {
    onRetry: ({ retryCount, maxAttempts, error }) =>
      markScriptAssetVideoAnalysisRetrying(user, {
        ...analysisInput,
        assetId,
      }, config, {
        retryCount,
        maxAttempts,
        message: error?.message || "模型服务临时繁忙，正在自动重试。",
      }),
  });
  const payload = scriptAssetPayloadFromVideoAnalysis(analysis, currentPayload, {
    id: assetId,
  });
  const saved = await saveAsset(user, "script", {
    id: assetId,
    name: analysis.name,
    groupId: analysis.groupId,
    fileUrl: analysis.sourceFile.fileUrl || currentAsset.fileUrl || "",
    fileKey: analysis.sourceFile.fileKey || currentAsset.fileKey || "",
    mimeType: analysis.sourceFile.mimeType || currentAsset.mimeType || "",
    sizeBytes: analysis.sourceFile.sizeBytes || currentAsset.sizeBytes || 0,
    createdAt: analysis.createdAt,
    payload,
  }, config);
  return { asset: saved, profile: analysis.profile };
}

export async function analyzeScriptVideoSource(user, input = {}, config = {}, options = {}) {
  const sourceFile = normalizeSourceFile(input.sourceFile);
  const videoContentUrl = resolveBackendVideoUrl(sourceFile.fileUrl, input.publicApiBaseUrl || config.publicApiBaseUrl || "");
  if (!videoContentUrl) throw httpError(400, "视频文件地址为空，无法分析。");

  const sourceDurationSeconds = positiveInteger(sourceFile.durationSeconds || input.videoDurationSeconds);
  const targetDurationMode = input.targetDurationMode === "custom" ? "custom" : "source";
  const requestedTargetSeconds = positiveInteger(input.targetDurationSeconds || input.durationSeconds);
  const targetDurationSeconds = targetDurationMode === "custom"
    ? requestedTargetSeconds || sourceDurationSeconds
    : sourceDurationSeconds || requestedTargetSeconds;
  const roleCountMode = input.roleCountMode === "custom" ? "custom" : "auto";
  const roleCount = Math.max(1, Math.min(20, positiveInteger(input.roleCount) || 1));
  const modelId = normalizeText(input.modelId || input.analysisModelId);
  const llmKeyId = normalizeText(input.llmKeyId);
  if (!llmKeyId) throw httpError(400, "请选择用于视频分析的 LLM 渠道。");
  const analysisKey = await getDecryptedApiKey(user.id, llmKeyId, config);
  assertVideoAnalysisModel(modelId, trustedApiPolicy(analysisKey?.channel, "llm")?.modelOptions || []);

  const timeoutMs = clampVideoAnalysisTimeoutMs(
    input.analysisTimeoutMs || videoAnalysisRequestTimeoutMs({ sourceDurationSeconds }),
  );
  const name = normalizeText(input.name || sourceFile.name) || "脚本视频资产";
  const groupId = normalizeId(input.groupId);
  const rawText = await requestScriptStructureAnalysis({
    user,
    config,
    llmKeyId,
    modelId,
    videoContentUrl,
    sourceFile,
    sourceDurationSeconds,
    roleCountMode,
    roleCount,
    targetDurationMode,
    targetDurationSeconds,
    timeoutMs,
    onRetry: options.onRetry,
  });

  const profile = normalizeScriptStructureProfile(rawText, {
    sourceFile,
    sourceDurationSeconds,
    roleCountMode,
    roleCount,
    targetDurationMode,
    targetDurationSeconds,
  });
  const now = new Date().toISOString();
  const finalSourceDurationSeconds = profile.sourceDurationSeconds || sourceDurationSeconds;
  const finalTargetDurationSeconds = profile.targetDurationSeconds || targetDurationSeconds || finalSourceDurationSeconds;
  return {
    name,
    groupId,
    rawText,
    profile,
    sourceFile,
    sourceDurationSeconds: finalSourceDurationSeconds,
    targetDurationMode,
    targetDurationSeconds: finalTargetDurationSeconds,
    roleCountMode,
    roleCount,
    modelId,
    llmKeyId,
    analysisStartedAt: input.analysisStartedAt || input.createdAt || now,
    analysisTimeoutMs: timeoutMs,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

export function assertVideoAnalysisModel(modelId = "", models = []) {
  if (!modelId || !models.some(model => model.id === modelId && model.videoAnalysis)) {
    throw httpError(400, "请选择管理员已启用视频分析能力的模型。");
  }
  return modelId;
}

export function scriptAssetPayloadFromVideoAnalysis(analysis = {}, basePayload = {}, options = {}) {
  const id = normalizeId(options.id || basePayload.id);
  const sourceFile = normalizeSourceFile(analysis.sourceFile || basePayload.sourceFile);
  const sourceDurationSeconds = positiveInteger(analysis.sourceDurationSeconds || analysis.profile?.sourceDurationSeconds || sourceFile.durationSeconds);
  const targetDurationSeconds = positiveInteger(analysis.targetDurationSeconds || analysis.profile?.targetDurationSeconds || sourceDurationSeconds);
  const createdAt = analysis.createdAt || basePayload.createdAt || new Date().toISOString();
  return {
    ...basePayload,
    type: "script",
    ...(id ? { id } : {}),
    groupId: normalizeId(analysis.groupId || basePayload.groupId),
    name: normalizeText(analysis.name || basePayload.name || sourceFile.name) || "脚本视频资产",
    desc: targetDurationSeconds
      ? `脚本资产 · 原时长 ${formatVideoDuration(sourceDurationSeconds)} · 目标时长 ${formatVideoDuration(targetDurationSeconds)}`
      : "已完成视频提取",
    tag: basePayload.tag || "",
    prompt: normalizeText(analysis.rawText || basePayload.prompt),
    rawAnalysis: "",
    scriptProfile: analysis.profile || basePayload.scriptProfile || null,
    sourceShotCount: analysis.profile?.sourceShotCount || undefined,
    targetShotCount: analysis.profile?.targetShotCount || undefined,
    estimatedShotCount: analysis.profile?.estimatedShotCount || undefined,
    analysisStatus: "done",
    analysisError: "",
    analysisRetryCount: 0,
    analysisMaxAttempts: videoAnalysisMaxAttempts,
    analysisMaxRetries: Math.max(0, videoAnalysisMaxAttempts - 1),
    analysisRetryMessage: "",
    analysisModelId: normalizeText(analysis.modelId || basePayload.analysisModelId),
    llmKeyId: normalizeText(analysis.llmKeyId || basePayload.llmKeyId),
    entryMode: "video",
    roleCountMode: analysis.roleCountMode === "custom" ? "custom" : "auto",
    roleCount: Math.max(1, Math.min(20, positiveInteger(analysis.roleCount || basePayload.roleCount) || 1)),
    targetDurationMode: analysis.targetDurationMode === "custom" ? "custom" : "source",
    targetDurationSeconds: targetDurationSeconds || undefined,
    durationSeconds: targetDurationSeconds || undefined,
    analysisStartedAt: analysis.analysisStartedAt || basePayload.analysisStartedAt || createdAt,
    analysisTimeoutMs: positiveInteger(analysis.analysisTimeoutMs || basePayload.analysisTimeoutMs) || undefined,
    sourceFile,
    createdAt,
    updatedAt: analysis.updatedAt || new Date().toISOString(),
  };
}

export async function markScriptAssetVideoAnalysisError(user, input = {}, config = {}, message = "") {
  const assetId = normalizeId(input.assetId || input.id);
  if (!assetId) return null;
  const currentAsset = await findScriptAsset(user.id, assetId, config).catch(() => null);
  if (!currentAsset) return null;
  const currentPayload = normalizeObject(currentAsset.payload);
  const sourceFile = normalizeSourceFile(input.sourceFile || currentPayload.sourceFile);
  const now = new Date().toISOString();
  const name = normalizeText(input.name || currentPayload.name || currentAsset.name || sourceFile.name) || "脚本视频资产";
  const groupId = normalizeId(input.groupId || currentPayload.groupId || currentAsset.groupId);
  return await saveAsset(user, "script", {
    id: assetId,
    name,
    groupId,
    fileUrl: sourceFile.fileUrl || currentAsset.fileUrl || "",
    fileKey: sourceFile.fileKey || currentAsset.fileKey || "",
    mimeType: sourceFile.mimeType || currentAsset.mimeType || "",
    sizeBytes: sourceFile.sizeBytes || currentAsset.sizeBytes || 0,
    createdAt: currentPayload.createdAt || currentAsset.createdAt || input.createdAt || now,
    payload: {
      ...currentPayload,
      type: "script",
      id: assetId,
      groupId,
      name,
      desc: "视频提取失败",
      analysisStatus: "error",
      analysisError: message || "脚本视频提取失败，请稍后重试。",
      analysisRetryCount: Math.max(0, videoAnalysisMaxAttempts - 1),
      analysisMaxAttempts: videoAnalysisMaxAttempts,
      analysisMaxRetries: Math.max(0, videoAnalysisMaxAttempts - 1),
      analysisRetryMessage: message || "脚本视频提取失败，请稍后重试。",
      analysisModelId: input.modelId || currentPayload.analysisModelId || "",
      llmKeyId: input.llmKeyId || currentPayload.llmKeyId || "",
      entryMode: "video",
      roleCountMode: input.roleCountMode || currentPayload.roleCountMode || "auto",
      roleCount: positiveInteger(input.roleCount || currentPayload.roleCount) || 1,
      targetDurationMode: input.targetDurationMode || currentPayload.targetDurationMode || "source",
      targetDurationSeconds: positiveInteger(input.targetDurationSeconds || currentPayload.targetDurationSeconds || currentPayload.durationSeconds) || undefined,
      durationSeconds: positiveInteger(input.targetDurationSeconds || currentPayload.durationSeconds) || undefined,
      analysisStartedAt: input.analysisStartedAt || currentPayload.analysisStartedAt || currentPayload.createdAt || now,
      analysisTimeoutMs: positiveInteger(input.analysisTimeoutMs || currentPayload.analysisTimeoutMs) || undefined,
      sourceFile: sourceFile.fileUrl ? sourceFile : currentPayload.sourceFile,
      updatedAt: now,
    },
  }, config);
}

async function markScriptAssetVideoAnalysisRetrying(user, input = {}, config = {}, retry = {}) {
  const assetId = normalizeId(input.assetId || input.id);
  if (!assetId) return null;
  const currentAsset = await findScriptAsset(user.id, assetId, config).catch(() => null);
  if (!currentAsset) return null;
  const currentPayload = normalizeObject(currentAsset.payload);
  const sourceFile = normalizeSourceFile(input.sourceFile || currentPayload.sourceFile);
  const now = new Date().toISOString();
  const name = normalizeText(input.name || currentPayload.name || currentAsset.name || sourceFile.name) || "脚本视频资产";
  const groupId = normalizeId(input.groupId || currentPayload.groupId || currentAsset.groupId);
  const retryCount = positiveInteger(retry.retryCount);
  const maxAttempts = positiveInteger(retry.maxAttempts) || videoAnalysisMaxAttempts;
  return await saveAsset(user, "script", {
    id: assetId,
    name,
    groupId,
    fileUrl: sourceFile.fileUrl || currentAsset.fileUrl || "",
    fileKey: sourceFile.fileKey || currentAsset.fileKey || "",
    mimeType: sourceFile.mimeType || currentAsset.mimeType || "",
    sizeBytes: sourceFile.sizeBytes || currentAsset.sizeBytes || 0,
    createdAt: currentPayload.createdAt || currentAsset.createdAt || input.createdAt || now,
    payload: {
      ...currentPayload,
      type: "script",
      id: assetId,
      groupId,
      name,
      desc: retryCount ? `视频提取中 · 重试第 ${retryCount} 次` : "视频提取中",
      analysisStatus: "running",
      analysisError: "",
      analysisRetryCount: retryCount,
      analysisMaxAttempts: maxAttempts,
      analysisMaxRetries: Math.max(0, maxAttempts - 1),
      analysisRetryMessage: normalizeText(retry.message) || "模型服务临时繁忙，正在自动重试。",
      analysisModelId: input.modelId || currentPayload.analysisModelId || "",
      llmKeyId: input.llmKeyId || currentPayload.llmKeyId || "",
      entryMode: "video",
      roleCountMode: input.roleCountMode || currentPayload.roleCountMode || "auto",
      roleCount: positiveInteger(input.roleCount || currentPayload.roleCount) || 1,
      targetDurationMode: input.targetDurationMode || currentPayload.targetDurationMode || "source",
      targetDurationSeconds: positiveInteger(input.targetDurationSeconds || currentPayload.targetDurationSeconds || currentPayload.durationSeconds) || undefined,
      durationSeconds: positiveInteger(input.targetDurationSeconds || currentPayload.durationSeconds) || undefined,
      analysisStartedAt: input.analysisStartedAt || currentPayload.analysisStartedAt || currentPayload.createdAt || now,
      analysisTimeoutMs: positiveInteger(input.analysisTimeoutMs || currentPayload.analysisTimeoutMs) || undefined,
      sourceFile: sourceFile.fileUrl ? sourceFile : currentPayload.sourceFile,
      updatedAt: now,
    },
  }, config);
}

async function requestScriptStructureAnalysis({
  user,
  config,
  llmKeyId,
  modelId,
  videoContentUrl,
  sourceFile,
  sourceDurationSeconds = 0,
  roleCountMode = "auto",
  roleCount = 1,
  targetDurationMode = "source",
  targetDurationSeconds = 0,
  timeoutMs = videoAnalysisTimeoutMs,
  onRetry = null,
}) {
  return await withVideoAnalysisRetry(async () => {
    const result = await proxyLlmCompletion({
      apiKeyId: llmKeyId,
      model: modelId,
      taskType: "asset-script-video-analysis",
      timeoutMs,
      messages: [
        {
          role: "system",
          content: scriptVideoAnalysisPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildScriptStructureAnalysisInstruction({
                sourceFile,
                sourceDurationSeconds,
                roleCountMode,
                roleCount,
                targetDurationMode,
                targetDurationSeconds,
              }),
            },
            scriptVideoMessagePart(videoContentUrl, sourceFile),
          ],
        },
      ],
    }, config, user);
    const rawText = stripTextCodeFence(extractLlmContent(result?.data) || String(result?.content || "").trim());
    if (!rawText) throw transientVideoAnalysisError("模型没有返回脚本资产。");
    if (isTransientVideoAnalysisText(rawText)) throw transientVideoAnalysisError("模型当前处于高峰或临时繁忙，已自动重试；请稍后再试。");
    if (isMissingVideoAnalysisResponse(rawText)) throw new Error("脚本资产解析失败：模型没有返回可用结果。");
    return rawText;
  }, { label: "脚本资产解析", onRetry });
}

function buildScriptStructureAnalysisInstruction({ sourceFile = null, sourceDurationSeconds = 0, roleCountMode = "auto", roleCount = 1, targetDurationMode = "source", targetDurationSeconds = 0 } = {}) {
  const sourceText = sourceDurationSeconds ? formatVideoDuration(sourceDurationSeconds) : "未识别";
  const targetText = targetDurationSeconds ? formatVideoDuration(targetDurationSeconds) : "跟随原视频";
  const targetRoleCount = Math.max(1, Math.min(20, Number(roleCount || 1)));
  const roleCountRule = roleCountMode === "custom"
    ? `自定义 ${targetRoleCount} 个。请把 ${targetRoleCount} 当作目标角色数量：优先统计主角和核心角色；核心角色不足 ${targetRoleCount} 个时，继续统计重要配角；仍不足时，可以统计外观可确认、能用于后续角色图生成的边缘人物。禁止凭空捏造没有出现在视频中的人物；如果主角、配角和可确认边缘人物加起来仍少于 ${targetRoleCount} 个，就按实际可确认人物数量填写。`
    : "跟随视频实际核心角色。请只统计真正推动剧情、反复出现、有明确台词或承担主要冲突的核心角色和重要配角，不要用边缘人物凑数。";
  return `请分析上传的对标视频，只输出系统要求的固定标题纯文本脚本资产。

【视频元信息】
文件名：${sourceFile?.name || "未命名视频"}
原视频时长：${sourceText}
目标时长设置：${targetDurationMode === "custom" ? `自定义 ${targetText}` : "跟随原视频"}
角色数量设置：${roleCountRule}

【分析重点】
1. 必须复原原视频完整脚本，按 4-5 秒左右一镜输出“第 N 镜”，尽量覆盖完整原视频，不要只输出摘要。
2. 必须提取“原时长”和“目标时长”：原时长使用上传元信息中的原视频秒数；目标时长使用本次设置的目标时长，自定义目标时长时必须等于本次设置，未自定义时等于原时长。
3. 必须按“角色数量设置”统计人物：角色数量必须等于角色清单实际条目数。AI 分析模式只列主角、核心角色和重要配角；自定义模式下先列主角/核心角色/重要配角，如果不足目标数量，再补充视频里真实出现且外观可确认的边缘人物；如果全部可确认人物仍不足目标数量，就按实际人数填写。禁止凭空捏造人物，禁止把镜头数、对白条数或剧情节点数当作角色数量。角色清单请按主角、核心角色、重要配角、可确认边缘人物的优先级排序，并在括号里标注类型。
4. 必须判断整个视频“有无对白”：有台词、旁白或口播就写“有”；几乎没有台词就写“无”。
5. 必须识别产品首次明确出场的时间点和占比；如果视频没有明确产品，写“未识别明确产品”。
6. 原视频里出现的产品名、价格、卖点、使用效果等信息请如实保留，不要替换成占位符。
7. 如果本次设置了自定义目标时长，不要输出目标时长版完整脚本，只在【扩写规则】里说明如何保持原结构进行扩写。
8. 【扩写规则】必须明确强调：保持原视频结构比例、保持产品首次出场比例、扩充每个阶段内部内容、保留角色关系和说话风格；不要用空镜、重复对白、无意义等待、黑场或纯情绪拉扯来凑目标时长。`;
}

export function normalizeScriptStructureProfile(text = "", fallback = {}) {
  const sourceDurationSeconds = positiveInteger(durationSecondsFromText(labeledTextFromText(text, ["原时长", "原视频时长", "视频时长"])) || fallback.sourceDurationSeconds || fallback.sourceFile?.durationSeconds);
  const targetDurationSeconds = positiveInteger(fallback.targetDurationSeconds || durationSecondsFromText(labeledTextFromText(text, ["目标时长", "目标视频时长"])) || sourceDurationSeconds);
  const targetDurationMode = fallback.targetDurationMode || "source";
  const roleCountMode = fallback.roleCountMode === "custom" ? "custom" : "auto";
  const requestedRoleCount = Math.max(0, Math.min(scriptMaxDisplayRoleCount, positiveInteger(fallback.roleCount)));
  const roleCountLimit = scriptRoleCountLimit(roleCountMode, requestedRoleCount);
  const characters = scriptCharactersWithinRoleLimit(normalizeScriptCharactersFromText(text), roleCountLimit, roleCountMode);
  const explicitLeadCount = positiveInteger(labeledTextFromText(text, ["主角数量", "主角数"]));
  const explicitSupportingCount = positiveInteger(labeledTextFromText(text, ["配角数量", "配角数"]));
  const hasExplicitRoleBreakdown = Boolean(explicitLeadCount || explicitSupportingCount);
  const leadCount = explicitLeadCount || characters.filter((item) => /主角|主线|lead|main/i.test(item.roleType)).length;
  const supportingCount = explicitSupportingCount || characters.filter((item) => /配角|support|secondary/i.test(item.roleType)).length;
  const explicitRoleCount = positiveInteger(labeledTextFromText(text, ["角色数量", "核心角色数量", "核心人物数量", "核心角色数", "核心人物数"]));
  const totalCount = normalizeScriptRoleTotalCount({
    explicitCount: explicitRoleCount,
    characterCount: characters.length,
    leadCount,
    supportingCount,
    roleCountMode,
    preferLeadSupportingCount: hasExplicitRoleBreakdown,
    limit: roleCountLimit,
  });
  const sourceShotCount = positiveInteger(labeledTextFromText(text, ["原镜头", "原镜头数量", "原视频镜头", "原视频镜头数", "镜头数量", "分镜数量"])) ||
    scriptShotCountFromText(text) ||
    estimateScriptShotCount(sourceDurationSeconds);
  const targetShotCount = targetDurationMode === "custom" && targetDurationSeconds && sourceDurationSeconds && sourceShotCount
    ? Math.max(1, Math.round(sourceShotCount * (targetDurationSeconds / sourceDurationSeconds)))
    : sourceShotCount;
  return {
    assetType: "reference_script_asset",
    sourceDurationSeconds,
    targetDurationMode,
    targetDurationSeconds,
    hasDialogue: normalizeScriptDialogueValue(labeledTextFromText(text, ["有无对白", "是否有对白", "对白状态"]), text),
    sourceShotCount,
    targetShotCount,
    estimatedShotCount: sourceShotCount,
    coreCharacters: {
      leadCount,
      supportingCount,
      totalCount,
      characters,
      hasExplicitRoleBreakdown,
    },
    productFirstAppearance: normalizeProductFirstAppearanceFromText(text, sourceDurationSeconds),
    expansionRules: stringListFromBracketSection(text, "扩写规则"),
    riskNotes: stringListFromBracketSection(text, "风险提示"),
  };
}

function scriptRoleCountLimit(roleCountMode = "auto", requestedRoleCount = 0) {
  const requested = positiveInteger(requestedRoleCount);
  if (roleCountMode === "custom" && requested) return Math.min(scriptMaxDisplayRoleCount, requested);
  return scriptMaxDisplayRoleCount;
}

function scriptCharactersWithinRoleLimit(characters = [], limit = scriptMaxDisplayRoleCount, roleCountMode = "auto") {
  const normalized = Array.isArray(characters) ? characters : [];
  if (!normalized.length) return [];
  const coreCharacters = normalized.filter((item) => !isScriptEdgeCharacter(item));
  const edgeCharacters = normalized.filter(isScriptEdgeCharacter);
  const ordered = roleCountMode === "custom"
    ? [...coreCharacters, ...edgeCharacters]
    : coreCharacters;
  return ordered.slice(0, Math.max(1, Math.min(scriptMaxDisplayRoleCount, positiveInteger(limit) || scriptMaxDisplayRoleCount)));
}

function isScriptEdgeCharacter(character = {}) {
  const text = `${character.roleType || ""} ${character.description || ""} ${character.functionInConflict || ""}`;
  return /边缘|路人|群演|背景|群众|围观|可确认边缘|短暂|一闪而过|无台词|客串|不推动|不参与核心冲突/.test(text);
}

function normalizeScriptRoleTotalCount({ explicitCount = 0, characterCount = 0, leadCount = 0, supportingCount = 0, roleCountMode = "auto", preferLeadSupportingCount = false, limit = scriptMaxDisplayRoleCount } = {}) {
  const safeLimit = Math.max(1, Math.min(scriptMaxDisplayRoleCount, positiveInteger(limit) || scriptMaxDisplayRoleCount));
  const leadSupportingCount = positiveInteger(leadCount) + positiveInteger(supportingCount);
  const characterTotal = positiveInteger(characterCount);
  const safeExplicitCount = positiveInteger(explicitCount);
  const explicitWithinLimit = safeExplicitCount && safeExplicitCount <= safeLimit ? safeExplicitCount : 0;
  const value = roleCountMode === "custom"
    ? characterTotal || leadSupportingCount || explicitWithinLimit
    : preferLeadSupportingCount && leadSupportingCount ? leadSupportingCount : characterTotal || leadSupportingCount || explicitWithinLimit;
  return value ? Math.min(value, safeLimit) : 0;
}

async function findScriptAsset(userId, assetId, config) {
  const data = await listAssets(userId, "script", config);
  return (data.assets || []).find((asset) => asset.id === assetId) || null;
}

async function withVideoAnalysisRetry(task, { label = "视频分析", onRetry = null } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= videoAnalysisMaxAttempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= videoAnalysisMaxAttempts || !isTransientVideoAnalysisError(error)) throw error;
      if (typeof onRetry === "function") {
        await onRetry({
          attempt,
          nextAttempt: attempt + 1,
          retryCount: attempt,
          maxAttempts: videoAnalysisMaxAttempts,
          error,
        }).catch(() => {});
      }
      await delay(videoAnalysisRetryDelayMs * attempt);
    }
  }
  throw lastError || new Error(`${label}失败，请稍后重试。`);
}

function resolveBackendVideoUrl(fileUrl = "", publicBaseUrl = "") {
  const value = normalizeText(fileUrl);
  if (!value || value.startsWith("data:") || /^https?:\/\//i.test(value)) return value;
  const base = normalizeText(publicBaseUrl).replace(/\/+$/, "");
  if (base && /^https?:\/\//i.test(base) && value.startsWith("/")) return `${base}${value}`;
  return value;
}

export function scriptVideoMessagePart(videoContentUrl = "", sourceFile = {}) {
  const mimeType = normalizeVideoMimeType(sourceFile.mimeType, [
    sourceFile.name,
    sourceFile.fileUrl,
    sourceFile.fileKey,
    videoContentUrl,
  ]);
  return {
    type: "video_url",
    mimeType,
    mime_type: mimeType,
    video_url: {
      url: videoContentUrl,
      mimeType,
      mime_type: mimeType,
    },
  };
}

function normalizeSourceFile(input = {}) {
  const file = input && typeof input === "object" ? input : {};
  const name = normalizeText(file.name || file.originalName);
  const fileUrl = normalizeText(file.fileUrl || file.url);
  const fileKey = normalizeText(file.fileKey || file.key);
  const sourceUrl = normalizeYoutubeVideoUrl(file.sourceUrl || fileUrl);
  return {
    name,
    fileUrl,
    fileKey,
    mimeType: normalizeVideoMimeType(file.mimeType || file.type, [name, fileUrl, fileKey]),
    sizeBytes: positiveInteger(file.sizeBytes || file.size),
    durationSeconds: positiveInteger(file.durationSeconds || file.duration),
    sourceType: sourceUrl ? "youtube" : "upload",
    sourceUrl,
  };
}

function normalizeVideoMimeType(value = "", candidates = []) {
  const raw = normalizeText(value).split(";")[0].toLowerCase();
  if (raw && raw !== "application/octet-stream" && raw !== "binary/octet-stream") {
    if (raw === "video/x-m4v") return "video/mp4";
    if (raw.includes("quicktime")) return "video/quicktime";
    if (raw.startsWith("video/")) return raw;
  }
  for (const candidate of candidates) {
    const inferred = videoMimeTypeFromPath(candidate);
    if (inferred) return inferred;
  }
  return "video/mp4";
}

function videoMimeTypeFromPath(value = "") {
  const path = normalizeText(value).split("?")[0].split("#")[0].toLowerCase();
  if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "video/mp4";
  if (path.endsWith(".mov") || path.endsWith(".qt")) return "video/quicktime";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".mpeg") || path.endsWith(".mpg")) return "video/mpeg";
  if (path.endsWith(".avi")) return "video/x-msvideo";
  if (path.endsWith(".3gp")) return "video/3gpp";
  return "";
}

function videoAnalysisRequestTimeoutMs({ sourceDurationSeconds = 0 } = {}) {
  return videoAnalysisTimeoutMs;
}

function clampVideoAnalysisTimeoutMs(value, minMs = videoAnalysisTimeoutMs, maxMs = videoAnalysisMaxTimeoutMs) {
  const timeoutMs = Number(value || 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return minMs;
  return Math.max(minMs, Math.min(timeoutMs, maxMs));
}

function extractLlmContent(data) {
  const message = data?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => part.text || part.content || "").join("\n").trim();
  }
  const geminiText = Array.isArray(data?.candidates)
    ? data.candidates
        .flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
        .map((part) => part.text || "")
        .join("\n")
        .trim()
    : "";
  return String(data?.choices?.[0]?.text || data?.output_text || geminiText || "").trim();
}

function stripTextCodeFence(text = "") {
  const value = String(text || "").trim();
  if (!value) return "";
  const match = value.match(/^```(?:text|txt|markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] || value).trim();
}

function isTransientVideoAnalysisText(text = "") {
  return /high\s+demand|spikes?\s+in\s+demand|try\s+again\s+later|temporarily\s+unavailable|rate\s*limit|too\s+many\s+requests|overloaded|capacity|model\s+is\s+busy|请求过多|稍后重试|模型繁忙|高峰|负载|限流|服务暂时不可用/i.test(String(text || ""));
}

function transientVideoAnalysisError(message = "模型服务当前繁忙，请稍后重试。") {
  const error = new Error(message);
  error.transientVideoAnalysis = true;
  return error;
}

function isTransientVideoAnalysisError(error) {
  const message = String(error?.message || error || "");
  return Boolean(error?.transientVideoAnalysis) ||
    error?.status === 408 ||
    error?.status === 425 ||
    error?.status === 429 ||
    Number(error?.status || 0) >= 500 ||
    /high\s+demand|spikes?\s+in\s+demand|try\s+again\s+later|temporarily\s+unavailable|rate\s*limit|too\s+many\s+requests|overloaded|capacity|请求较多|稍后重试|模型繁忙|高峰|负载|繁忙|限流|timeout|timed out|Failed to fetch|fetch|load failed|network/i.test(message);
}

function isMissingVideoAnalysisResponse(text = "") {
  const value = String(text || "").trim();
  if (!value) return true;
  return /(?:未(?:收到|接收|获取|提供|上传)|没有(?:收到|接收|获取|看到)|无法(?:访问|读取|解析|查看)|不能(?:访问|读取|解析|查看)|请(?:重新)?上传|视频读取失败|视频文件|视频链接)/i.test(value) &&
    /(?:视频|文件|链接|素材)/i.test(value) &&
    !/(?:脚本资产摘要|原视频脚本复原|扩写规则|有无对白|原时长|目标时长|分镜数量|镜头数量|产品首次出场|画面内容|角色对白|备注)/.test(value);
}

function normalizeScriptCharactersFromText(text = "") {
  const section = extractBracketSection(text, "核心人物");
  if (!section) return [];
  const listText = section.match(/角色清单\s*[:：]?\s*([\s\S]*)/i)?.[1] || "";
  return listText
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.、\s]+/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^(主角数量|配角数量|人物关系|角色清单)\s*[:：]/.test(line))
    .filter((line) => !/^(无|未识别|暂无|没有)$/.test(line))
    .map((line) => {
      const roleMatch = line.match(/^(.+?)（([^）]+)）\s*[:：]\s*(.+)$/) || line.match(/^(.+?)\(([^)]+)\)\s*[:：]\s*(.+)$/);
      if (roleMatch) {
        return {
          name: normalizeText(roleMatch[1]),
          roleType: normalizeText(roleMatch[2]),
          description: normalizeText(roleMatch[3]),
          functionInConflict: "",
        };
      }
      const plainMatch = line.match(/^(.+?)\s*[:：]\s*(.+)$/);
      return {
        name: normalizeText(plainMatch?.[1] || ""),
        roleType: "",
        description: normalizeText(plainMatch?.[2] || line),
        functionInConflict: "",
      };
    })
    .filter((item) => item.name || item.description)
    .slice(0, 20);
}

function normalizeProductFirstAppearanceFromText(text = "", sourceDurationSeconds = 0) {
  const line = String(text || "").match(/产品首次出场[^\n]*/)?.[0] || "";
  if (!line || /未识别明确产品|未识别|未出现|没有|无明确|不出现/.test(line)) {
    return { appears: false, timeSeconds: 0, percent: 0, evidence: "" };
  }
  const timeSeconds = durationSecondsFromLooseText(line);
  const percentText = line.match(/(\d+(?:\.\d+)?)\s*%/)?.[1] || "";
  const sourceSeconds = positiveInteger(sourceDurationSeconds);
  const percent = normalizePercentValue(percentText || (timeSeconds && sourceSeconds ? (timeSeconds / sourceSeconds) * 100 : 0));
  const evidence = normalizeText(line.match(/依据\s*[:：]\s*([\s\S]*)$/)?.[1] || "");
  return {
    appears: Boolean(timeSeconds || percent || evidence),
    timeSeconds,
    percent,
    evidence,
  };
}

function normalizeScriptDialogueValue(value, text = "") {
  const explicitResult = parseScriptDialogueStatus(value);
  if (explicitResult !== null) return explicitResult;
  const dialogueBlocks = [...String(text || "").matchAll(/【(?:角色对白|对白|角色台词|台词)】\s*[:：]?\s*([\s\S]*?)(?=\n\s*【(?:画面内容|角色对白|对白|角色台词|台词|备注)】|\n\s*第\s*\d+\s*镜|$)/g)]
    .map((match) => normalizeText(match[1]).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const meaningfulBlocks = dialogueBlocks.filter((item) => item && !/^(?:待补充|未识别|\.\.\.)$/.test(item));
  if (meaningfulBlocks.some((item) => !/^(?:无对白|无台词|没有对白|无)$/i.test(item))) return true;
  if (meaningfulBlocks.some((item) => /^(?:无对白|无台词|没有对白|无)$/i.test(item))) return false;
  return null;
}

function parseScriptDialogueStatus(value = "") {
  const text = normalizeText(value);
  if (!text) return null;
  if (/^(?:有\s*[\/／或、]\s*无|有无|有\/无|未识别|待补充|\.\.\.)$/.test(text)) return null;
  if (/^(无|没有|否|false|no)(?:$|[\s，。；、,.;（(])/i.test(text) || /无对白|没有对白|无台词|没有台词|不含对白|不含台词/i.test(text)) return false;
  if (/^(有|是|true|yes)(?:$|[\s，。；、,.;（(])/i.test(text) || /有对白|有台词|有口播|有旁白|有对话|含对白|包含对白|含台词|存在对白|出现对白/i.test(text)) return true;
  return null;
}

function labeledTextFromText(text = "", labels = []) {
  const body = String(text || "");
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const match = body.match(new RegExp(`${escaped}\\s*[:：]\\s*([^\\n]+)`, "i"));
    if (match?.[1]) return normalizeText(match[1]);
  }
  return "";
}

function durationSecondsFromText(text = "") {
  return durationSecondsFromLooseText(text);
}

function durationSecondsFromLooseText(text = "") {
  const value = String(text || "");
  const hourMinSec = value.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (hourMinSec) return Number(hourMinSec[1]) * 3600 + Number(hourMinSec[2]) * 60 + Number(hourMinSec[3]);
  const minSec = value.match(/(\d{1,3})\s*[:：]\s*(\d{1,2})/);
  if (minSec) return Number(minSec[1]) * 60 + Number(minSec[2]);
  const zh = value.match(/(?:(\d+)\s*(?:小时|时))?\s*(?:(\d+)\s*(?:分钟|分))?\s*(?:(\d+)\s*(?:秒|s|sec|seconds?))?/i);
  if (zh && (zh[1] || zh[2] || zh[3])) return Number(zh[1] || 0) * 3600 + Number(zh[2] || 0) * 60 + Number(zh[3] || 0);
  const number = value.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|sec|seconds?)/i)?.[1];
  return number ? Math.round(Number(number)) : 0;
}

function extractBracketSection(text = "", title = "") {
  const body = String(text || "");
  const match = body.match(new RegExp(`【${escapeRegExp(title)}】\\s*([\\s\\S]*?)(?=\\n\\s*【[^】]+】|$)`));
  return match?.[1]?.trim() || "";
}

function stringListFromBracketSection(text = "", title = "") {
  const section = extractBracketSection(text, title);
  if (!section) return [];
  return section
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.、\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

function scriptShotCountFromText(text = "") {
  const matches = [...String(text || "").matchAll(/第\s*(\d+)\s*镜/g)].map((match) => Number(match[1]) || 0);
  return matches.length ? Math.max(...matches) : 0;
}

function estimateScriptShotCount(sourceDurationSeconds = 0) {
  const sourceSeconds = positiveInteger(sourceDurationSeconds);
  return sourceSeconds ? Math.max(1, Math.round(sourceSeconds / scriptFallbackSecondsPerShot)) : 0;
}

function normalizePercentValue(value = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
}

function formatVideoDuration(value = 0) {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0)));
  if (!totalSeconds) return "待识别";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function positiveInteger(value) {
  const number = Math.round(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function normalizeId(value = "") {
  return String(value || "").trim();
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}
