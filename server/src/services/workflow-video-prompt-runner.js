import crypto from "node:crypto";
import { httpError } from "../http.js";
import { appendWorkflowAiDirectorVideoPromptRules } from "../lib/workflow-ai-video-prompt.mjs";
import { sortWorkflowVideoAssetsByFileName } from "../lib/workflow-video-prompt.mjs";
import { updateJob } from "./job-store.js";
import { proxyLlmCompletion } from "./model-proxy.js";
import {
  getWorkflowRun,
  listWorkflows,
  updateWorkflowRun,
  workflowConfigForRunSnapshot,
} from "./workflow-store.js";

const aiDirectorTaskStart = "<VIDEO_TASK>";
const aiDirectorTaskEnd = "</VIDEO_TASK>";
export const aiDirectorStartMarker = "[START_OUTPUT]";
export const aiDirectorCompletionMarker = "[END_OUTPUT]";
const aiDirectorSingleCallMaxOutputTokens = 48000;

const aiDirectorRenderedPromptExample = `第1镜

场景参考：@图片4 家庭餐厅
角色：@图片2 谷雨，@图片1 父亲，@图片3 母亲
角色-声线绑定：谷雨｜克制真诚的青年男声；父亲｜沉稳厚重的中年男声；母亲｜朴素温和的中年女声

[0–2秒]：夜晚，家庭餐厅中景固定镜头，一家三口围坐小方桌，桌上摆着两盘素菜和三碗米饭，谷雨攥着筷子迟迟没夹菜，抬头看向父亲又低下头。【音效：室内安静的环境底噪和轻微餐具碰触声】

[2–6秒]：切谷雨近景并缓慢推近，他用筷子轻轻戳着碗里的米粒，神色紧张，声音发虚地对父亲说：“爸，能不能给我五千块钱？”父亲夹菜的筷子停在半空。

[6–8秒]：反打父亲近景固定镜头，他没有立即回答，目光沉静地落向谷雨；前景虚化的母亲抬起头，神色疑惑。

[8–12秒]：切母亲中近景并轻微推镜，她皱眉看向谷雨，语气疑惑地问：“五千？你要这么多钱干啥？”谷雨低下头，父亲保持沉默。

[12–13秒]：回到餐桌中景固定镜头收束，谷雨的筷子一下下戳着碗里的米粒，桌面气氛凝滞。【音效：筷子轻触碗底的细微声响】`;

const aiDirectorDialogueLanguageProfiles = {
  zh: { label: "中文", promptRate: "中文对白按每秒约 3.5–4 个汉字估算" },
  en: { label: "英语", promptRate: "英语对白按每秒约 2.2–2.7 个单词（约 130–160 词/分钟）估算" },
  de: { label: "德语", promptRate: "德语对白按每秒约 2–2.4 个单词（约 120–145 词/分钟）估算" },
  fr: { label: "法语", promptRate: "法语对白按每秒约 2.3–2.7 个单词（约 140–160 词/分钟）估算" },
  ja: { label: "日语", promptRate: "日语对白按每秒约 5–6 个假名或汉字字符估算" },
  ko: { label: "韩语", promptRate: "韩语对白按每秒约 4–5 个韩文音节估算" },
  id: { label: "印尼语", promptRate: "印尼语对白按每秒约 2.3–2.7 个单词（约 140–160 词/分钟）估算" },
  pt: { label: "葡萄牙语", promptRate: "葡萄牙语对白按每秒约 2.3–2.7 个单词（约 140–160 词/分钟）估算" },
  es: { label: "西班牙语", promptRate: "西班牙语对白按每秒约 2.5–2.9 个单词（约 150–175 词/分钟）估算" },
};

function aiDirectorDialogueLanguageProfile(language = "zh") {
  const id = String(language || "").trim().toLowerCase().split(/[-_]/)[0];
  return {
    id: aiDirectorDialogueLanguageProfiles[id] ? id : "zh",
    ...(aiDirectorDialogueLanguageProfiles[id] || aiDirectorDialogueLanguageProfiles.zh),
  };
}

export async function executeWorkflowVideoPromptNode(user, input = {}, config = {}) {
  const runId = normalizeText(input.runId);
  if (!runId) throw httpError(400, "缺少工作流任务 ID。");
  let maxDurationSeconds = Number(input.maxDurationSeconds);
  const context = await loadVideoPromptContext(user.id, runId, config);
  const workflowForRun = workflowConfigForRunSnapshot(context.workflow, context.run);
  const workflow = normalizeObject(workflowForRun.config || workflowForRun);
  if (!["story", "ecommerce"].includes(normalizeText(workflow.type || context.workflow.type))) {
    throw httpError(400, "AI 导演分镜仅支持故事和带货工作流。");
  }

  const result = normalizeObject(context.run.result);
  const script = normalizeText(result.scriptOutput);
  if (!script) throw httpError(400, "没有找到可用于 AI 导演分镜的完整剧本。");
  const storedAiDirectorPlan = normalizeObject(result.aiDirectorPlan);
  const assembleStoredPlan = normalizeText(result.storyboardMode) === "ai-director"
    && Array.isArray(storedAiDirectorPlan.segments)
    && storedAiDirectorPlan.segments.length > 0;
  if (assembleStoredPlan) {
    maxDurationSeconds = normalizeMaxDuration(result.aiDirectorMaxDurationSeconds || storedAiDirectorPlan.maxDurationSeconds);
  } else {
    maxDurationSeconds = normalizeMaxDuration(maxDurationSeconds);
  }
  const assets = assembleStoredPlan
    ? assignStoryboardAssetTokens(normalizeVideoPromptAssets(result.shots, result.shotAssetRefs))
    : assignAiDirectorAssetTokens(normalizeVideoPromptAssets(result.shots, result.shotAssetRefs));
  if (!assets.length || assets.some((asset) => !asset.imageUrl)) {
    throw httpError(400, "请先完成全部角色图、场景图和商品图。");
  }

  const llmKeyId = normalizeText(input.llmKeyId || input.apiKeyId || workflow.llmKeyId);
  const modelId = normalizeText(input.modelId || input.shotModelId || workflow.shotModelId || workflow.storyModelId);
  if (!assembleStoredPlan && (!llmKeyId || !modelId)) throw httpError(400, "请选择 AI 导演分镜使用的 LLM 渠道和模型。");
  const jobId = normalizeText(input.jobId);
  if (jobId) await updateJob(user.id, jobId, { status: "running", progress: 5 }, config);

  try {
    const plan = assembleStoredPlan
      ? storedAiDirectorPlan
      : await generateAiDirectorPlan(user, config, {
        apiKeyId: llmKeyId,
        modelId,
        maxDurationSeconds,
        workflowType: normalizeText(workflow.type || context.workflow.type),
        language: normalizeText(workflow.language) || "zh",
        script,
        assets,
      });
    const timeline = buildWorkflowAiDirectorTimeline({ plan, assets, maxDurationSeconds });
    const now = new Date().toISOString();
    const updatedRun = await updateWorkflowRun(user.id, context.run.id, {
      status: "waiting",
      completedAt: "",
      stages: {
        ...(context.run.stages || {}),
        videoPrompt: "done",
        video: "pending",
        draft: "pending",
      },
      result: {
        ...result,
        videoPromptMode: "ai-director",
        videoPromptMaxDurationSeconds: maxDurationSeconds,
        videoPromptPlan: {
          mode: "ai-director",
          schemaVersion: 2,
          maxDurationSeconds,
          segmentCount: timeline.length,
          generatedAt: now,
          modelId: assembleStoredPlan ? normalizeText(storedAiDirectorPlan.modelId) : modelId,
          source: assembleStoredPlan ? "storyboard" : "video-production",
        },
        videoPromptError: "",
        videoTimeline: timeline,
        videoResults: [],
        videoStatus: "",
        videoPackage: {},
        videoPackageStatus: "",
        videoPackageTaskId: "",
        videoPackageName: "",
        videoPackageDetail: "",
        videoPackageError: "",
        videoPackageProgress: 0,
        videoPackageDone: 0,
        videoPackageTotal: 0,
        draft: {},
        draftStatus: "",
        draftUrl: "",
        draftId: "",
        draftError: "",
      },
      error: "",
      updatedAt: now,
    }, config);
    if (jobId) {
      await updateJob(user.id, jobId, {
        status: "done",
        progress: 100,
        result: { segmentCount: timeline.length, maxDurationSeconds },
        error: "",
      }, config);
    }
    return { run: updatedRun, timeline };
  } catch (error) {
    if (jobId) {
      await updateJob(user.id, jobId, {
        status: "error",
        error: error.message || "AI 导演视频提示词组装失败。",
      }, config).catch(() => {});
    }
    throw error;
  }
}

async function generateAiDirectorPlan(user, config, input) {
  const response = await proxyLlmCompletion({
    apiKeyId: input.apiKeyId,
    model: input.modelId,
    taskType: "workflow-video-prompt",
    maxOutputTokens: aiDirectorSingleCallMaxOutputTokens,
    streamCompletionMarker: aiDirectorCompletionMarker,
    messages: [
      { role: "system", content: buildAiDirectorSystemPrompt() },
      { role: "user", content: buildAiDirectorUserPrompt(input) },
    ],
  }, config, user);
  return parseAiDirectorPlanResponse(response.content || response.data?.content || "", {
    maxDurationSeconds: input.maxDurationSeconds,
  });
}

export function buildAiDirectorSystemPrompt() {
  return `你是一名资深真人短剧导演和 AI 视频分镜设计师。

请完整阅读输入剧本，把它作为唯一叙事依据。忽略输入中已有的“第N镜”等分镜边界，从零重新规划若干个可以独立生成的视频任务。保持原有剧情顺序、人物关系、关键动作、商品事实、冲突、反转和结局，不随意改变故事。

原剧本中所有明确属于人物说出的对白必须逐字保留。禁止润色、改写、概括、同义替换、增删、合并或调换对白；禁止新增原剧本不存在的台词。把每句原对白视为按原顺序排列、只能消费一次的只读字符片段：一旦整句或其中一段已分配给某个时间码，后续时间码和视频任务不得再次输出。允许把一段长对白按自然停顿拆到多个连续切镜或视频任务，但拆分后的文字按顺序直接拼接必须与原文完全一致。每个拆分片段都必须独立重新标明原说话人，并用中文双引号完整包裹该片段；禁止把任何对白片段写成没有角色标注的独立裸文本。格式使用的外层中文双引号只是容器，原文自身已有的引号、异常引号、重复标点和末尾标点仍属于只读对白字符，不得被外层引号替换、吞掉、配对修复或删除。单条任务时长内说不完时必须拆到下一个视频任务，不能删字或压缩措辞。AI 导演只决定怎么拍、何时切镜和人物如何表演，不决定人物说什么。

最高优先级规则一：原对白逐字保留高于其他所有要求。当对白完整性与任务时长、任务数量、场景切换、镜头细节或剧情段落完整性发生冲突时，必须增加视频任务或继续拆分对白，绝对不能删除、改写、概括或跳过任何对白字符。

最高优先级规则二：当前对白尚未逐字输出完毕时，禁止切换场景、进入下一句对白、商品介绍或下一剧情节点。任务达到最大时长时，下一任务必须由原说话人从尚未输出的字符继续；只有全部原对白输出完成后，才允许输出 ${aiDirectorCompletionMarker}。

禁止对原对白进行语义去重、重要性筛选或上下文推断。即使某个姓名、年龄、身份或事实已经在角色映射、画面描述、前文或后文中出现，原剧本中的询问、回答、确认、重复和过渡对白仍必须逐字输出。“提问—回答”等连续对白单元不得拆掉任何一方。

必须严格按照“提取只读对白清单 → 按本次对白语言的自然语速保守计算每段对白所需时间 → 为停顿、动作和对方反应预留时间 → 据此划分视频任务 → 最后为每个任务设计内部切镜”的顺序规划。禁止先按剧情段落或原镜号合并内容，再把过量对白硬塞进时间码。自然语速区间一律采用较慢一端计算连续发声的理论最低时长；任务中只要还有停顿、动作、转场或反应，实际可用对白时长必须继续扣减，不能把整条任务时长全部算作发声时间。

场景、时间、主要人物关系或完整戏剧节点变化时优先拆分；同一场景的长对白按说话轮次、自然语速和语义节点拆分。视频任务数量不设目标，也禁止以减少任务数量为目标；任务数量只能由完整容纳全部原对白、动作、停顿和反应所需的自然时长决定。同一场景、同一人物、同一轮长对白或同一戏剧节点也可以且必须在容量不足时拆成多个连续任务。每个任务必须是能够在时长内真实表演完成的可生成片段，而不是必须装下完整剧情段落的容器。最大时长只是绝对上限，不是填满目标：必须先计算对白、停顿、动作和反应所需时间，再选择能够自然表达当前内容的整数时长；禁止为了接近最大时长继续塞入下一轮对白、下一个动作节点或下一个戏剧节点。

每个任务内部必须使用从 0 开始的连续时间码。内部切镜点优先使用 0.5 秒粒度的小数，但最后一个时间码的结束值必须是整数秒，即整条视频任务的最终时长必须为整数。

每个时间码代表一个实际切镜，只承载一个主要画面构图、一个核心动作和最多一个角色的一轮对白；说话人变化时必须开始新的时间码，禁止在同一时间码中堆入多名角色的连续对白。每个时间码都必须达到可直接拍摄的导演执行稿细度，并显式写出：至少一种景别或视角；一种运镜方式，若不移动也必须写“固定镜头”；前中后景构图、人物站位与调度；核心动作、神情、微表情、情绪和视线。不得只写人物做了什么而省略景别、机位或运镜。当前剧情有对白、旁白或画外音时，必须把原文直接写进它实际发生的时间码行，同时写清说话人、当时的情绪或语速、口型状态和对方必要反应；纯动作、环境建立、反应或转场时间码可以没有对白。当脚步、开门、钟表、餐具、衣料、呼吸、车辆或环境底噪对当前动作、空间或情绪有表达作用时，在对应时间码末尾加入【音效：具体声音】；音效必须可由画面内动作或环境自然产生，不要每个时间码机械添加，禁止背景音乐。

所有对白、旁白和画外音都必须归属于具体时间码，禁止写在时间码之外；最后一条时间码结束后不得继续罗列角色对白或独立引号文本。时间码之外只能出现任务规定的“场景参考”“角色”、商品参考（如有）和“角色-声线绑定”等结构字段，不能出现任何可听台词。

相邻任务必须从上一任务结束后的下一个尚未使用剧情事件或对白片段继续。新任务需要承接上一任务时，只能描写听完后的停顿、表情、动作、视线、环境状态或其他后续反应，禁止复述上一任务最后一句对白或最后一个拆分片段。

镜头节奏应包括环境建立、人物动作或对白、对方反应、动作或道具特写以及情绪收束。外显对白要求口型与声音同步，画外音时人物闭嘴无口型。

角色映射中的人物外观描述必须服从剧本明确的国家与社会语境。当人物姓名、亲属称谓、地点、机构和生活背景明确属于中国，且原文没有外国设定时，统一写“中国男性”或“中国女性”，禁止泛化为“东亚男性”或“东亚女性”。原文明示其他国家、地区或民族时严格按原文；确实没有任何国家语境依据时才不强行补充国籍。

“角色-声线绑定”只负责“这个人听起来是谁”。先为每个角色确定一条唯一、简短、全剧固定的基础声线，以后每次出现都逐字复用。绑定项左侧必须写“小野”“李秀兰”等具体人物姓名，严禁写 Role_A、Role_B、[[Role_A]]、[[Role_B]] 等角色映射 ID。每个角色只写“具体人物姓名｜核心音色+年龄性别”的短语，例如“谷雨｜克制真诚的青年男声；父亲｜沉稳厚重的中年男声；母亲｜朴素温和的中年女声”。禁止写国籍、外貌、性格经历、成长阶段，也禁止写低声、急促、压着情绪、哽咽、哭腔、愤怒、慌张、气息不稳等当前场景的情绪、语速和表演状态；这些只能写入对应时间码的分镜信息。

输出必须充分详细、可直接拍摄：每个时间码完整写出当前画面、表演和运镜；该时间码实际发生对白时，再在同一行写入原文对白和即时反应。不得把任务对白集中追加在时间码块下方；不重复固定角色档案、全局场景定义或统一规则，不写与拍摄无关的分析。

全程禁止字幕、文字叠加、标签、标注、水印、Logo 和背景音乐。采用 9:16 真人现代短剧风格，保持写实人物、真实皮肤与衣物纹理、自然光影、真人电影质感、统一色调、干净人声与克制环境音效；禁止插画、动漫、油画、水彩、CG、3D 渲染及任何艺术转绘感。同一镜头中的同一角色只能出现一个实体，禁止分身、克隆、镜像替身或同帧重复。

只允许引用用户提供的素材占位符。生成阶段不要自行猜测或书写 @图片N；系统会在组装每一镜的最终视频提示词时，将该镜实际引用的角色图、场景图和商品图按本地下载文件名排序，再依次转换为 @图片1、@图片2、@图片3……；同一镜中每张图片的序号唯一。严格遵守用户给出的任务边界和最终文本格式，直接输出最终视频提示词，不要输出 JSON、Markdown、解释、分析或思考过程。整份返回内容的第一行必须且只能是 ${aiDirectorStartMarker}，最后一行必须且只能是 ${aiDirectorCompletionMarker}；两个标记都只能出现一次，标记前后禁止输出任何其他文字。`;
}

export function buildAiDirectorStoryboardInstructions({
  maxDurationSeconds = 15,
  includeProductReference = true,
  segmented = false,
  dialogueLanguage = "zh",
} = {}) {
  const duration = normalizeMaxDuration(maxDurationSeconds);
  const languageProfile = aiDirectorDialogueLanguageProfile(dialogueLanguage);
  const targetRange = duration === 15 ? "10–15" : "4–10";
  const productReferenceRule = includeProductReference
    ? "只有本任务画面实际使用商品时才输出“商品参考”；没有使用商品时整行省略，禁止写“商品参考：无”或“可选的商品参考：无”"
    : "这是故事视频工作流，不输出任何“商品参考”字段；禁止写“商品参考：无”或“可选的商品参考：无”";
  const exampleTimecodes = duration === 15
    ? [
      "[0–2.5秒]：夜晚室内近景固定镜头，写清环境光线、前后景构图、人物姿态、神情与视线。",
      "[2.5–4.5秒]：切道具特写并缓慢推近，写清焦点变化、人物手部动作及由动作触发的【音效：具体声音】。",
      "[4.5–6.5秒]：切门口平视中景固定镜头，交代人物入画位置、空间关系、动作和第一反应。",
      "[6.5–8.5秒]：过肩近景反打，写清说话者的原文对白、口型、语气、微表情和对方视线反应。",
      "[8.5–11秒]：近景收束并轻微推镜，写清情绪落点、人物最后动作与克制环境音；最后结束值 11 为整数。",
    ]
    : [
      "[0–2秒]：夜晚室内中景固定镜头，写清环境光线、构图、人物姿态、神情与视线。",
      "[2–3.5秒]：切道具特写并缓慢推近，写清焦点变化、手部动作及【音效：具体声音】。",
      "[3.5–5.5秒]：切门口平视中景，交代人物入画位置、空间关系、动作和第一反应。",
      "[5.5–7秒]：过肩近景反打，写清原文对白、口型、语气、微表情和对方反应。",
      "[7–9秒]：近景收束并轻微推镜，写清情绪落点与环境音；最后结束值 9 为整数。",
    ];
  const modeIntroduction = segmented
    ? "这是 AI 导演分段生成中的一个连续剧本范围，并使用独立于传统分镜模式的系统提示词完成。你只需把当前范围从头到尾拆成可直接生成视频的任务；不要沿用输入中的‘第N镜’边界，不要重复输出全局资产映射，也不要涉及其他分段。"
    : "这是一次完整剧本生成任务。请通读完整剧本，自然规划可直接生成视频的 AI 导演分镜，再连续输出角色、场景、商品映射（如有）和全部视频任务。输入中的“第N镜”只帮助确认原剧情顺序，不要求与最终任务一一对应。";
  const coverageRule = segmented
    ? "把当前连续剧本分段作为唯一叙事依据。所有人物对白必须逐字保留，角色归属、先后顺序、标点和原有措辞不得改变。第一条任务必须从本段第一项内容开始，最后一条任务必须覆盖本段最后一项内容和最后一句对白；不得回顾前段、预演后段或遗漏本段内容。"
    : "把完整剧本作为唯一叙事依据。第一条任务从最早剧情事件开始，最后一条任务覆盖最后一个剧情事件和最后一句对白；保持剧情顺序、人物关系、关键动作、商品事实、冲突、反转和结局，不遗漏、不概述替代、不提前结束。";
  const outputRule = segmented
    ? `整份返回内容的第一行必须且只能是 ${aiDirectorStartMarker}，中间只能输出当前分段的全部视频任务，不得输出角色、场景、商品映射；全部 ${aiDirectorTaskEnd} 输出完毕后，最后一行必须且只能是 ${aiDirectorCompletionMarker}。两个标记都只能出现一次。`
    : `整份返回内容的第一行必须且只能是 ${aiDirectorStartMarker}，然后输出角色、场景、商品映射（如有）和视频任务；只有处理到原剧本最后一个剧情事件和最后一句对白、且全部 ${aiDirectorTaskEnd} 均已输出后，最后一行必须且只能是 ${aiDirectorCompletionMarker}。两个标记都只能出现一次，标记前后禁止输出标题、解释、代码围栏或任何其他文字。`;
  const mappingExample = segmented ? "" : `[START_ROLE_MAPPING]
Role_A: 角色名：角色库[角色库角色名]
Role_B: 角色名：稳定人物外观描述
[END_ROLE_MAPPING]
[START_SCENE_MAPPING]
Scene_A: 场景名称
提示词：空无一人的场景图提示词
[END_SCENE_MAPPING]
${includeProductReference ? `[START_PRODUCT_MAPPING]
Product_1: 产品库[产品名称]
[END_PRODUCT_MAPPING]
` : ""}`;
  return `# AI 导演分镜输出规则
${modeIntroduction}

# 原对白是不可编辑的只读数据（最高优先级）
最高优先级规则一：原对白逐字保留高于其他所有要求。当对白完整性与任务时长、任务数量、场景切换、镜头细节或剧情段落完整性发生冲突时，必须增加视频任务或继续拆分对白，绝对不能删除、改写、概括或跳过任何对白字符。
最高优先级规则二：当前对白尚未逐字输出完毕时，禁止切换场景、进入下一句对白、商品介绍或下一剧情节点。任务达到最大时长时，下一任务必须由原说话人从尚未输出的字符继续；只有全部原对白输出完成后，才允许输出 ${aiDirectorCompletionMarker}。

1. 先从完整剧本中按出现顺序提取全部人物对白、旁白和画外音，在内部建立只读对白清单。只允许从这份清单逐字复制对白，禁止凭记忆复述。不要输出清单。
2. 即使原文存在错别字、病句、重复文字、错误标点、引号不完整或表达不自然，也必须原样保留；禁止纠错、润色、改写、概括、同义替换、删字、补字、调整语序或修改标点。格式使用的外层中文双引号不能替换、吞掉、配对修复或删除原文自身的任何引号和标点。
3. 每句对白的说话人、文字、标点和先后顺序必须保持不变。每句只读对白只能消费一次：一旦整句或片段已写入某个时间码，后续时间码和任务禁止再次输出。禁止对原对白进行语义去重、重要性筛选或上下文推断；即使姓名、年龄、身份或事实已在角色映射、画面描述、前文或后文出现，原剧本中的询问、回答、确认、重复和过渡对白仍必须逐字输出，“提问—回答”等连续对白单元不得拆掉任何一方。禁止改变说话人、合并不同角色台词、把动作写成台词或新增原剧本不存在的台词。
4. 长对白可以在原文已有标点或自然停顿处拆到相邻时间段或相邻视频任务；所有片段按顺序直接拼接后必须与原文逐字一致，任何字句、异常引号或标点都不能遗漏、重复或被格式引号取代。每个拆分片段都必须重新写出原说话人并独立使用一组中文双引号，包括拆到下一个视频任务的后半句。禁止输出没有角色标注和引号的独立对白片段。
5. 原剧本中的说话人标签和表演说明写在引号外；真正需要说出口的原文逐字复制到中文双引号“”内。原对白自身已有的异常标点或引号仍作为原文字符保留在外层格式引号内部。
6. 每个时间码最多只能有一个角色的一轮对白；说话人变化时必须开始新的时间码，并分别标明说话人、分别使用一组中文双引号。动作、神情、心理、环境和【音效】只能写在引号外。所有对白、旁白和画外音必须写进实际发生的时间码行，禁止在时间码之外或最后一条时间码之后集中罗列；纯动作、反应、环境建立和转场时间码可以没有对白。
7. 导演创作权限仅限场景、构图、机位、运镜、动作、表演、节奏和环境音；没有修改、补写或重新创作对白的权限。
8. 输出结束前，在内部按照只读对白清单从第一句到最后一句逐句核对：每句都出现且仅出现一次，逐字一致、说话人一致、顺序一致。不要输出核对过程。

# 自然分镜规则
1. 严格按照“提取只读对白清单 → 按自然语速计算每段对白时长 → 为停顿、动作和对方反应预留时间 → 划分视频任务 → 设计任务内部切镜”的顺序规划。禁止先按剧情段落、场景或原镜号合并内容，再把过量对白硬塞进时间码。
2. 按完整剧本的自然叙事组织视频任务，禁止为了平均分配内容、模仿原镜号或展示导演技巧而拆开连续剧情。视频任务数量不设目标，也禁止以减少任务数量为目标；数量只能由完整容纳全部原对白、动作、停顿和反应所需的自然时长决定。
3. 场景、时间、主要人物关系或完整戏剧节点发生变化时，可以建立新任务；同一场景、同一人物、同一轮长对白或同一戏剧节点在容量不足时也必须拆成多个连续任务。每条任务必须是能在时长内真实表演完成的可生成片段，而不是必须装下完整剧情段落的容器。景别变化、正反打、特写、推拉或其他运镜通常在任务内部通过时间码完成，但绝不能以“只是切镜”为由把超出时长容量的对白继续留在同一任务。新任务从上一任务之后的下一个尚未使用剧情事件或对白片段开始；需要衔接时只写后续动作、表情、视线或环境反应，禁止重复上一任务末尾对白。
4. 每条任务时长控制在 ${targetRange} 秒，最终时长为整数且不得超过 ${duration} 秒。当前对白语言为${languageProfile.label}；${languageProfile.promptRate}。采用语速区间较慢一端保守计算连续发声的理论最低时长；任务中的停顿、动作、转场和反应还要另外占用时间，禁止把整条任务时长全部分配给对白。放不下时必须在自然边界建立下一任务，禁止删改对白、压缩措辞或极限加速。
5. ${coverageRule}
6. 每条任务使用从 0 开始、连续无重叠的局部时间码；切镜点可使用 0.5 秒粒度，最后一个时间码的结束值必须是整数。时间段数量由实际导演需要决定，不要求固定数量或固定节奏模板。
7. 每个时间码代表一个实际切镜，只承载一个主要构图、一个核心动作和最多一个角色的一轮对白；说话人变化时必须开始新的时间码，禁止在同一时间码中堆入多名角色的连续对白。每个时间码必须显式写出至少一种景别或视角，以及一种运镜方式；镜头不移动时也必须明确写“固定镜头”。同时写清机位、前中后景构图、人物位置与调度、动作、神情、视线、口型和必要反应，不得只写剧情动作而省略镜头语言。当前剧情有对白时，必须在同一条时间码内写出“说话人 + 当前情绪或语速 + 中文双引号内的原文对白 + 对方必要反应”；不得把对白集中追加到时间码块下方。纯动作、反应、环境建立和转场时间码可以没有对白。只写对当前剧情有用的内容，不为了显得详细而堆砌空镜、反打、特写或重复反应。
8. 当脚步、开门、钟表、餐具、衣料、呼吸、车辆或环境底噪对当前动作、空间或情绪有表达作用时，在对应时间码末尾加入【音效：具体声音】。音效必须能由画面内动作或环境自然产生，不要为每个时间码机械添加；始终禁止背景音乐、字幕、文字叠加、水印和 Logo。
9. 角色映射中的人物外观描述必须服从剧本明确的国家与社会语境。当姓名、亲属称谓、地点、机构和生活背景明确属于中国，且原文没有外国设定时，统一写“中国男性”或“中国女性”，禁止写“东亚男性”或“东亚女性”；原文明示其他国家、地区或民族时严格按原文，确实没有依据时才不强行补充国籍。“角色-声线绑定”中每个角色只写一条简短的“核心音色+年龄性别”，同一角色在全剧所有任务中逐字复用。绑定项左侧必须使用具体人物姓名，严禁使用 Role_A、Role_B、[[Role_A]]、[[Role_B]] 等映射 ID。禁止写国籍、外貌、性格经历、成长阶段或当前场景的情绪和语速；低声、急促、哽咽、愤怒等临时表演要求必须写在对应时间码的分镜信息中。
10. 只引用全局映射区已经定义的素材 ID，例如 [[Scene_A]]、[[Role_A]]、[[Product_1]]；禁止编造素材或自行书写 @图片N。系统在组装每一镜的最终视频提示词时，会将该镜实际引用的角色图、场景图和商品图按本地下载文件名排序，再依次转换为 @图片1、@图片2、@图片3……；同一镜中每张图片的序号唯一。${productReferenceRule}。
11. 每条任务严格用 ${aiDirectorTaskStart} 和 ${aiDirectorTaskEnd} 包裹，标签内依次输出“场景参考”“角色”、${includeProductReference ? "实际需要时的“商品参考”、" : ""}“角色-声线绑定”和局部时间码。禁止使用裸露的“第1镜”标题代替任务标签。
12. 不输出 JSON、Markdown、解释、分析、总标题、规划清单或检查过程。不要在每条任务中重复这些固定规则。
13. ${outputRule}

任务格式：
${aiDirectorStartMarker}
${mappingExample}
${aiDirectorTaskStart}
场景参考：[[Scene_A]] 场景名称
角色：[[Role_A]] 角色名，[[Role_B]] 角色名
${includeProductReference ? "商品参考：[[Product_1]] 商品名称\n" : ""}角色-声线绑定：角色A｜稳定的年龄性别与音色质感；角色B｜稳定的年龄性别与音色质感

${exampleTimecodes.join("\n")}
${aiDirectorTaskEnd}
${aiDirectorCompletionMarker}

最终组装后的视频提示词展示示例（只学习字段顺序、镜头细度和音效写法，禁止复制示例角色、剧情或对白；@图片N 由系统根据该镜本地文件名顺序生成，模型输出时仍必须使用素材占位符）：
${aiDirectorRenderedPromptExample}`;
}

export function buildAiDirectorUserPrompt(input) {
  const assetCatalog = input.assets
    .map((asset) => `${asset.promptToken}｜${asset.assetType}｜${asset.title}`)
    .join("\n");
  const formatExample = buildAiDirectorDirectFormatExample(input.assets, input.maxDurationSeconds);
  const targetDurationRange = input.maxDurationSeconds === 15 ? "10–15" : "4–10";
  const productReferenceRule = input.workflowType === "story"
    ? "这是故事视频工作流，任何任务都不要输出“商品参考”字段；尤其禁止输出“商品参考：无”或“可选的商品参考：无”。"
    : "只有任务画面实际使用商品时才输出“商品参考”；没有使用商品时整行省略，禁止输出“商品参考：无”或“可选的商品参考：无”。";
  const languageProfile = aiDirectorDialogueLanguageProfile(input.language);
  return `请根据下面的完整剧本，从零重新规划全部视频任务，并一次性输出可直接用于参考生视频模型的最终中文提示词。

本次最大时长：${input.maxDurationSeconds} 秒。
每条任务通常为 ${targetDurationRange} 秒，最大时长只是上限。

最高优先级要求：
规则一：原对白逐字保留高于其他所有要求。当对白完整性与任务时长、任务数量、场景切换、镜头细节或剧情段落完整性发生冲突时，必须增加视频任务或继续拆分对白，绝对不能删除、改写、概括或跳过任何对白字符。
规则二：当前对白尚未逐字输出完毕时，禁止切换场景、进入下一句对白、商品介绍或下一剧情节点。任务达到最大时长时，下一任务必须由原说话人从尚未输出的字符继续；只有全部原对白输出完成后，才允许输出 ${aiDirectorCompletionMarker}。

1. 完整剧本是唯一叙事依据。保持剧情顺序、人物关系、关键动作、商品事实、冲突、反转和结局，从第一项内容连续处理到最后一句对白。
2. 原对白是不可编辑的只读数据。生成前先在内部按顺序提取全部人物对白、旁白和画外音；生成时只能从原剧本逐字复制，禁止凭记忆复述。
3. 即使原文存在错别字、病句、重复、错误标点或引号不完整，也不得纠正。禁止润色、改写、概括、同义替换、删字、补字、调序、改变说话人、合并不同角色台词或新增对白。禁止对原对白进行语义去重、重要性筛选或上下文推断；即使姓名、年龄、身份或事实已在角色映射、画面描述、前文或后文出现，询问、回答、确认、重复和过渡对白仍必须逐字输出，“提问—回答”等连续对白单元不得拆掉任何一方。外层格式引号不能替换、吞掉、修复或删除原文自身的异常引号和标点。
4. 每句原对白或其拆分片段只能消费一次，写入某个时间码后不得在后续时间码或任务中再次出现。长对白可以在原有标点或自然停顿处拆到相邻时间段或任务；拆分片段按顺序直接拼接后必须与原文逐字一致。每个拆分片段都必须独立重新写出原说话人，并把该片段的可听原文完整放在一组中文双引号“”内；禁止以无角色标注的裸文本延续上一个任务的对白。说话人和表演说明写在引号外。
5. 输出前在内部从第一句到最后一句逐句核对：每句原对白都出现且仅出现一次，文字、标点、说话人和顺序一致。不要输出对白清单或核对过程。

角色与声线要求：
1. 角色映射中的人物外观描述必须服从剧本明确的国家与社会语境。当姓名、亲属称谓、地点、机构和生活背景明确属于中国，且原文没有外国设定时，统一写“中国男性”或“中国女性”，禁止写“东亚男性”或“东亚女性”；原文明示其他国家、地区或民族时严格按原文，确实没有依据时才不强行补充国籍。
2. “角色-声线绑定”左侧必须写具体人物姓名，例如“小野｜清亮克制的青年男声；李秀兰｜沙哑温厚的老年女声”。严禁写 Role_A、Role_B、[[Role_A]]、[[Role_B]] 等角色映射 ID。

自然分镜要求：
1. 严格按照“提取只读对白清单 → 按自然语速计算每段对白时长 → 为停顿、动作和对方反应预留时间 → 划分视频任务 → 设计任务内部切镜”的顺序规划。禁止先按剧情段落、场景或原镜号合并内容，再把过量对白硬塞进时间码。
2. 输入中的“第N镜”只用于确认原剧情顺序，允许把前后连续的原分镜重新组织，不要求与最终视频任务一一对应。视频任务数量不设目标，也禁止以减少任务数量为目标；数量只能由完整容纳全部原对白、动作、停顿和反应所需的自然时长决定。同一场景、同一人物、同一轮长对白或同一戏剧节点在容量不足时也必须拆成多个连续任务。景别、正反打、特写和运镜变化通常属于任务内部设计，但绝不能以此为由把超出时长容量的对白继续留在同一任务。新任务必须从上一任务之后的下一个尚未使用剧情事件或对白片段开始；需要承接时只写听完后的动作、表情、视线或环境状态，禁止复述上一任务最后一句对白或拆分片段。
3. 当前对白语言为${languageProfile.label}；${languageProfile.promptRate}。采用语速区间较慢一端保守计算连续发声的理论最低时长；停顿、动作、转场和反应必须另外占用时间，禁止把整条任务时长全部分配给对白。放不下时必须在自然边界建立下一任务，禁止删改对白、压缩措辞或极限加速。
4. 每条任务使用从 0 开始、连续无重叠的局部时间码，最后一个时间码的结束值为整数且不得超过 ${input.maxDurationSeconds} 秒。时间段数量按实际导演需要决定，不使用固定数量或固定切镜模板。
5. 每个时间码代表一个实际切镜，只承载一个主要构图、一个核心动作和最多一个角色的一轮对白；说话人变化时必须开始新的时间码，禁止在同一时间码中堆入多名角色的连续对白。每个时间码必须显式写出至少一种景别或视角，以及一种运镜方式；镜头不移动时也必须写“固定镜头”。同时写清机位、前中后景构图、人物位置与调度、动作、神情、视线、口型和必要反应，不得只写人物动作而省略镜头语言。所有对白、旁白和画外音必须直接写入实际发生的时间码行；有对白的时间码必须同时写明说话人、当前情绪或语速、中文双引号内的原文和对方必要反应。禁止在时间码之外或最后一条时间码之后集中罗列对白；纯动作、反应、环境建立和转场时间码可以没有对白。只写对当前剧情有用的可拍内容，不堆砌空镜、反打、特写或重复反应。
6. 当脚步、开门、钟表、餐具、衣料、呼吸、车辆或环境底噪对当前动作、空间或情绪有表达作用时，在对应时间码末尾写【音效：具体声音】。音效必须能由画面内动作或环境自然产生，不要机械地每个时间码都添加；禁止背景音乐。
7. 每条任务只引用实际需要的素材占位符，禁止编造素材或自行书写 @图片N。系统在组装该镜最终视频提示词时，会把该镜实际引用的角色图、场景图和商品图按本地下载文件名排序，再依次转换为 @图片1、@图片2、@图片3……；同一镜中每张图片的序号唯一。${productReferenceRule}
8. “角色-声线绑定”只绑定当前任务实际出现的角色。绑定项左侧必须写具体人物姓名，严禁写 Role_A、Role_B、[[Role_A]]、[[Role_B]] 等映射 ID。每个角色只写一条简短的“核心音色+年龄性别”，同一角色在全剧逐字复用；不得写国籍、外貌、成长阶段、当前情绪或语速。临时情绪、语速和说话状态全部写在对应时间码的分镜信息中。
9. 每条任务严格使用 ${aiDirectorTaskStart} 和 ${aiDirectorTaskEnd} 包裹，标签内依次输出“场景参考”“角色”、${input.workflowType === "story" ? "" : "实际需要时的“商品参考”、"}“角色-声线绑定”和局部时间码。
10. 不输出 JSON、Markdown、解释、分析、总标题、任务编号、规划清单或检查过程。
11. 第一行必须且只能是 ${aiDirectorStartMarker}；最后一行必须且只能是 ${aiDirectorCompletionMarker}。两个标记各出现一次，标记前后不得有其他文字。

格式示例（使用本次目录中的真实素材，只参考结构和细致程度；画面和动作必须根据完整剧本重新设计，示例中的泛化文字不能替代原剧本对白，所有原对白仍须逐字保留）：
${formatExample}

最终组装后的视频提示词展示示例（只学习字段顺序、镜头细度和音效写法，禁止复制示例角色、剧情或对白；@图片N 由系统根据该镜本地文件名顺序生成，你输出时仍必须使用素材占位符）：
${aiDirectorRenderedPromptExample}

【工作流类型】
${input.workflowType}

【对白语言】
${languageProfile.label}

【可用素材目录，顺序固定】
${assetCatalog}

【完整剧本】
${input.script}`;
}

function buildAiDirectorDirectFormatExample(assets = [], maxDurationSeconds = 15) {
  const scene = assets.find((asset) => asset.assetType === "scene");
  const roles = assets.filter((asset) => asset.assetType === "role").slice(0, 2);
  const lead = roles[0]?.title || "画面主体";
  const counterpart = roles[1]?.title || "对方";
  const exampleTimecodes = Number(maxDurationSeconds) === 10
    ? [
      `[0–2秒]：夜晚室内中景固定镜头，交代光线、前后景构图和人物空间关系；${lead}完成符合剧情的具体动作，神情、情绪和视线清晰可见。`,
      `[2–3.5秒]：切${lead}近景并缓慢推镜，写清手部动作、焦点变化、微表情、自然停顿和该段原文对白。`,
      `[3.5–5.5秒]：反打${counterpart}过肩近景，写清机位、目光和即时反应；未说话时闭嘴聆听。【音效：符合场景的克制环境声】`,
      `[5.5–7秒]：切关键道具特写并进行焦点转移，动作与声音同步，推动剧情而非重复信息。`,
      `[7–9秒]：回到人物近景收束，轻微推镜至情绪落点；最后结束值 9 为整数。`,
    ]
    : [
      `[0–2.5秒]：夜晚室内中景固定镜头，交代光线、前后景构图和人物空间关系；${lead}完成符合剧情的具体动作，神情、情绪和视线清晰可见。`,
      `[2.5–4.5秒]：切${lead}近景并缓慢推镜，写清手部动作、焦点变化、微表情、自然停顿和该段原文对白。`,
      `[4.5–6.5秒]：反打${counterpart}过肩近景，写清机位、目光和即时反应；未说话时闭嘴聆听。【音效：符合场景的克制环境声】`,
      `[6.5–8.5秒]：切关键道具特写并进行焦点转移，动作与声音同步，推动剧情而非重复信息。`,
      `[8.5–11秒]：回到人物近景收束，轻微推镜至情绪落点；最后结束值 11 为整数。`,
    ];
  const lines = [
    aiDirectorTaskStart,
    `场景参考：${scene ? `${scene.promptToken} ${scene.title}` : "无"}`,
    `角色：${roles.length ? roles.map((asset) => `${asset.promptToken} ${asset.title}`).join("，") : "无"}`,
    `角色-声线绑定：${roles.length ? roles.map((asset) => `${asset.title}｜符合年龄性别且全剧固定的基础音色`).join("；") : "无"}`,
    "",
    ...exampleTimecodes.flatMap((timecode) => [timecode, ""]),
    aiDirectorTaskEnd,
  ];
  return lines.join("\n");
}

export function normalizeAiDirectorOutput(value = "", options = {}) {
  const productReferencePattern = options.removeProductReferences
    ? /^[ \t]*(?:可选的)?商品参考\s*[:：][^\n]*\n?/gim
    : /^[ \t]*(?:可选的)?商品参考\s*[:：]\s*(?:无|没有|不适用|none)\s*\n?/gim;
  let text = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(productReferencePattern, "");
  const voiceBindings = new Map();
  const voiceLinePattern = /^([ \t]*角色-声线绑定\s*[:：]\s*)([^\n]*)$/gm;
  for (const match of text.matchAll(voiceLinePattern)) {
    parseAiDirectorVoiceBindings(match[2]).forEach(({ name, description }) => {
      const key = normalizeText(name).toLowerCase();
      if (key && description && !voiceBindings.has(key)) {
        voiceBindings.set(key, description);
      }
    });
  }
  text = text.replace(voiceLinePattern, (line, prefix, content) => {
    const bindings = parseAiDirectorVoiceBindings(content);
    if (!bindings.length) return line;
    return `${prefix}${bindings.map(({ name, description }) => {
      const fixedDescription = voiceBindings.get(normalizeText(name).toLowerCase()) || description;
      return `${name}｜${fixedDescription}`;
    }).join("；")}`;
  });
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function parseAiDirectorVoiceBindings(value = "") {
  return String(value || "")
    .split(/\s*(?:[；;]|[，,](?=\s*[^，,；;\n｜|]{1,20}\s*[｜|]))\s*/)
    .map((item) => {
      const match = item.match(/^\s*([^｜|：:]{1,30})\s*[｜|]\s*(.+?)\s*$/);
      return match
        ? { name: normalizeText(match[1]), description: normalizeText(match[2]) }
        : null;
    })
    .filter(Boolean);
}

export function parseAiDirectorPlanResponse(value = "", options = {}) {
  const integrityOnly = Boolean(options.integrityOnly);
  const text = integrityOnly
    ? String(value || "").replace(/\r\n?/g, "\n").trim()
    : normalizeAiDirectorOutput(value);
  const maxDurationSeconds = Number(options.maxDurationSeconds || 0);
  const startCount = text.split(aiDirectorStartMarker).length - 1;
  const endCount = text.split(aiDirectorCompletionMarker).length - 1;
  if (
    !text.startsWith(aiDirectorStartMarker)
    || !text.endsWith(aiDirectorCompletionMarker)
    || startCount !== 1
    || endCount !== 1
  ) {
    throw httpError(502, `AI 导演返回内容不完整：首行必须是 ${aiDirectorStartMarker}，末行必须是 ${aiDirectorCompletionMarker}，且两个标记都只能出现一次。`);
  }
  const segments = [];
  const pattern = /<VIDEO_TASK>\s*([\s\S]*?)\s*<\/VIDEO_TASK>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const prompt = normalizeText(match[1]);
    const assetTokens = [...new Set(prompt.match(/\[\[(?:ASSET_\d{3}|Role_[A-Za-z0-9_-]+|Scene_[A-Za-z0-9_-]+|Product_[A-Za-z0-9_-]+)\]\]/g) || [])];
    const timecodes = aiDirectorPromptTimecodes(prompt);
    const segmentIndex = segments.length + 1;
    if (!integrityOnly) {
      validateAiDirectorPromptTimecodes(timecodes, {
        segmentIndex,
        maxDurationSeconds,
      });
    }
    const durationSeconds = roundOne(timecodes.at(-1)?.end || 0);
    if (prompt && (integrityOnly || (assetTokens.length && durationSeconds > 0))) {
      segments.push({ prompt, assetTokens, durationSeconds });
    }
  }
  if (!segments.length && !integrityOnly) {
    throw httpError(502, "AI 导演返回内容没有按视频任务格式完整输出，请重试或更换模型。");
  }
  return { segments };
}

export function buildWorkflowAiDirectorTimeline({ plan, assets = [], maxDurationSeconds = 15 } = {}) {
  const tokenAssetMap = new Map(assets.map((asset) => [asset.promptToken, asset]));
  return (Array.isArray(plan?.segments) ? plan.segments : []).map((segment, index) => {
    const unknownTokens = segment.assetTokens.filter((token) => !tokenAssetMap.has(token));
    if (unknownTokens.length) throw httpError(502, `第${index + 1}条 AI 导演分镜引用了不存在的素材。`);
    const segmentAssets = sortWorkflowVideoAssetsByFileName(
      segment.assetTokens.map((token) => tokenAssetMap.get(token)).filter(Boolean),
      (asset) => asset.title,
    );
    if (!segmentAssets.length) throw httpError(502, `第${index + 1}条 AI 导演分镜没有匹配到参考图片。`);
    const prompt = renderAiDirectorFinalPrompt(segment.prompt, segmentAssets);
    const firstAsset = segmentAssets[0] || {};
    return {
      id: crypto.randomUUID(),
      shotId: `ai-director-${index + 1}`,
      shotIds: [String(index + 1)],
      index: index + 1,
      startIndex: index + 1,
      endIndex: index + 1,
      title: `第${index + 1}镜`,
      storyboardDetail: prompt,
      script: prompt,
      groupSize: 1,
      durationSeconds: segment.durationSeconds,
      imageUrl: firstAsset.imageUrl || "",
      imageThumbnailUrl: firstAsset.imageThumbnailUrl || firstAsset.thumbnailUrl || "",
      imagePrompt: prompt,
      assets: segmentAssets,
      videoPromptMode: "ai-director",
      videoPromptMaxDurationSeconds: maxDurationSeconds,
      videoPromptBeats: [],
      voiceBindings: [],
      videoPrompt: prompt,
      ecommerceStoryboard: true,
    };
  });
}

function assignAiDirectorAssetTokens(assets = []) {
  return sortWorkflowVideoAssetsByFileName(assets, (asset) => asset.title)
    .map((asset, index) => ({
      ...asset,
      promptToken: `[[ASSET_${String(index + 1).padStart(3, "0")}]]`,
    }));
}

function assignStoryboardAssetTokens(assets = []) {
  return sortWorkflowVideoAssetsByFileName(assets, (asset) => asset.title)
    .map((asset) => ({
      ...asset,
      promptToken: `[[${normalizeText(asset.assetRef || asset.roleKey)}]]`,
    }))
    .filter((asset) => !/^\[\[\]\]$/.test(asset.promptToken));
}

function renderAiDirectorFinalPrompt(value = "", assets = []) {
  let prompt = normalizeText(value);
  assets.forEach((asset, index) => {
    const tokenPattern = new RegExp(`${escapeRegExp(asset.promptToken)}\\s*(?:@图片\\d+\\s*)?`, "g");
    prompt = prompt.replace(tokenPattern, `@图片${index + 1} `);
  });
  prompt = prompt.replace(/\[\[(?:ASSET_\d{3}|Role_[A-Za-z0-9_-]+|Scene_[A-Za-z0-9_-]+|Product_[A-Za-z0-9_-]+)\]\]\s*/g, "");
  return appendWorkflowAiDirectorVideoPromptRules(
    prompt.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim(),
  );
}

function aiDirectorPromptDuration(value = "") {
  const ends = aiDirectorPromptTimecodes(value).map((timecode) => timecode.end);
  return roundOne(Math.max(0, ...ends));
}

function aiDirectorPromptTimecodes(value = "") {
  return [...String(value || "").matchAll(/\[\s*(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*秒\s*\]/g)]
    .map((match) => ({
      start: Number(match[1]),
      end: Number(match[2]),
    }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end));
}

function validateAiDirectorPromptTimecodes(timecodes = [], options = {}) {
  const segmentIndex = Number(options.segmentIndex || 1);
  const maxDurationSeconds = Number(options.maxDurationSeconds || 0);
  if (!timecodes.length) {
    throw httpError(502, `第${segmentIndex}条 AI 导演分镜没有有效时间码。`);
  }
  if (timecodes[0].start !== 0) {
    throw httpError(502, `第${segmentIndex}条 AI 导演分镜必须使用独立局部时间轴并从 0 秒开始，不能延续上一条任务的累计时间码。`);
  }
  for (let index = 0; index < timecodes.length; index += 1) {
    const current = timecodes[index];
    if (current.end <= current.start) {
      throw httpError(502, `第${segmentIndex}条 AI 导演分镜第${index + 1}个时间码结束值必须大于开始值。`);
    }
    if (index > 0 && Math.abs(current.start - timecodes[index - 1].end) > 0.001) {
      throw httpError(502, `第${segmentIndex}条 AI 导演分镜时间码必须从 0 秒开始并连续无空档、无重叠。`);
    }
  }
  const durationSeconds = timecodes.at(-1).end;
  if (!Number.isInteger(durationSeconds)) {
    throw httpError(502, `第${segmentIndex}条 AI 导演分镜最终时长必须是整数秒。`);
  }
  if (maxDurationSeconds > 0 && durationSeconds > maxDurationSeconds) {
    throw httpError(502, `第${segmentIndex}条 AI 导演分镜时长为 ${durationSeconds} 秒，超过所选最大 ${maxDurationSeconds} 秒。`);
  }
}

function normalizeVideoPromptAssets(value = [], shotAssetRefs = {}) {
  const refsByShot = normalizeObject(shotAssetRefs);
  return (Array.isArray(value) ? value : []).map((asset, index) => {
    const assetRef = normalizeText(asset?.assetRef || asset?.roleKey);
    const assetType = normalizeText(asset?.assetType || asset?.type);
    const shotRefs = normalizePositiveIntegers(asset?.shotRefs);
    if (!shotRefs.length && assetRef) {
      Object.entries(refsByShot).forEach(([shotIndex, refs]) => {
        const key = assetType === "scene" ? "sceneRefs" : assetType === "product" ? "productRefs" : "roleRefs";
        if ((Array.isArray(refs?.[key]) ? refs[key] : []).map(normalizeText).includes(assetRef)) shotRefs.push(Number(shotIndex));
      });
    }
    return {
      ...asset,
      index: Number(asset?.index || index + 1),
      assetRef,
      assetType,
      title: normalizeText(asset?.title || asset?.name || assetRef) || `图片${index + 1}`,
      imageUrl: normalizeText(asset?.imageUrl || asset?.fileUrl || asset?.url),
      imageThumbnailUrl: normalizeText(asset?.imageThumbnailUrl || asset?.thumbnailUrl),
      shotRefs: [...new Set(shotRefs)].sort((left, right) => left - right),
    };
  }).filter((asset) => ["role", "scene", "product"].includes(asset.assetType) && asset.imageUrl);
}

async function loadVideoPromptContext(userId, runId, config) {
  const run = await getWorkflowRun(userId, runId, config);
  const workflows = await listWorkflows(userId, config);
  const workflow = workflows.find((item) => item.id === run.workflowId && item.userId === userId);
  if (!workflow) throw httpError(404, "工作流不存在。");
  return { workflow, run };
}

function normalizeMaxDuration(value) {
  const duration = Number(value);
  if (![10, 15].includes(duration)) throw httpError(400, "AI 导演分镜最大时长只支持 10 秒或 15 秒。");
  return duration;
}

function normalizePositiveIntegers(value = []) {
  return (Array.isArray(value) ? value : [])
    .map(Number)
    .filter((number) => Number.isInteger(number) && number > 0);
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function roundOne(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
