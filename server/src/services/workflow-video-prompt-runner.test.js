import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aiDirectorCompletionMarker,
  aiDirectorStartMarker,
  buildAiDirectorStoryboardInstructions,
  buildAiDirectorSystemPrompt,
  buildAiDirectorUserPrompt,
  buildWorkflowAiDirectorTimeline,
  executeWorkflowVideoPromptNode,
  normalizeAiDirectorOutput,
  parseAiDirectorPlanResponse,
} from "./workflow-video-prompt-runner.js";
import { ensureUser } from "./user-store.js";
import { createWorkflow, createWorkflowRun } from "./workflow-store.js";

const assets = [
  {
    promptToken: "[[ASSET_001]]",
    assetRef: "role_father",
    assetType: "role",
    title: "父亲",
    imageUrl: "https://example.com/father.png",
  },
  {
    promptToken: "[[ASSET_002]]",
    assetRef: "role_gu",
    assetType: "role",
    title: "谷雨",
    imageUrl: "https://example.com/gu.png",
  },
  {
    promptToken: "[[ASSET_003]]",
    assetRef: "scene_dining",
    assetType: "scene",
    title: "家庭餐厅",
    imageUrl: "https://example.com/scene.png",
  },
];

const directPromptResponse = `${aiDirectorStartMarker}
<VIDEO_TASK>
场景参考：[[ASSET_003]] 家庭餐厅
角色：[[ASSET_002]] 谷雨，[[ASSET_001]] 父亲
角色-声线绑定：谷雨｜克制真诚的青年男声，父亲｜沉稳厚重的中年男声

[0–1.5秒]：家庭餐厅中景固定镜头，谷雨攥着筷子看向父亲。

[1.5–13秒]：反打父亲近景，他放下筷子，沉声让谷雨明早跟车。
</VIDEO_TASK>
${aiDirectorCompletionMarker}`;

test("AI director system prompt treats the full script as the only narrative source", () => {
  const prompt = buildAiDirectorSystemPrompt();
  assert.match(prompt, /完整阅读输入剧本/);
  assert.match(prompt, /唯一叙事依据/);
  assert.match(prompt, /忽略输入中已有的“第N镜”/);
  assert.match(prompt, /从零重新规划/);
  assert.match(prompt, /所有明确属于人物说出的对白必须逐字保留/);
  assert.match(prompt, /禁止润色、改写、概括/);
  assert.match(prompt, /AI 导演只决定怎么拍/);
  assert.match(prompt, /按本地下载文件名排序/);
  assert.match(prompt, /依次转换为 @图片1、@图片2、@图片3/);
  assert.match(prompt, /同一镜中每张图片的序号唯一/);
  assert.match(prompt, /对应时间码末尾加入【音效：具体声音】/);
  assert.match(prompt, new RegExp(aiDirectorStartMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, new RegExp(aiDirectorCompletionMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /直接输出最终视频提示词/);
  assert.doesNotMatch(prompt, /合法 JSON/);
});

test("AI director storyboard instructions generate final prompts in the shot node", () => {
  const prompt = buildAiDirectorStoryboardInstructions({ maxDurationSeconds: 15 });
  assert.match(prompt, /一次完整剧本生成任务/);
  assert.match(prompt, /原对白是不可编辑的只读数据（最高优先级）/);
  assert.match(prompt, /原对白逐字保留高于其他所有要求/);
  assert.match(prompt, /必须增加视频任务或继续拆分对白，绝对不能删除、改写、概括或跳过任何对白字符/);
  assert.match(prompt, /当前对白尚未逐字输出完毕时，禁止切换场景、进入下一句对白、商品介绍或下一剧情节点/);
  assert.match(prompt, /下一任务必须由原说话人从尚未输出的字符继续/);
  assert.match(prompt, /只有全部原对白输出完成后，才允许输出 \[END_OUTPUT\]/);
  assert.match(prompt, /只允许从这份清单逐字复制对白/);
  assert.match(prompt, /错别字、病句、重复文字、错误标点、引号不完整/);
  assert.match(prompt, /禁止纠错、润色、改写、概括、同义替换、删字、补字/);
  assert.match(prompt, /所有片段按顺序直接拼接后必须与原文逐字一致/);
  assert.match(prompt, /每句只读对白只能消费一次/);
  assert.match(prompt, /后续时间码和任务禁止再次输出/);
  assert.match(prompt, /禁止对原对白进行语义去重、重要性筛选或上下文推断/);
  assert.match(prompt, /询问、回答、确认、重复和过渡对白仍必须逐字输出/);
  assert.match(prompt, /“提问—回答”等连续对白单元不得拆掉任何一方/);
  assert.match(prompt, /格式使用的外层中文双引号不能替换、吞掉、配对修复或删除/);
  assert.match(prompt, /每个拆分片段都必须重新写出原说话人并独立使用一组中文双引号/);
  assert.match(prompt, /禁止输出没有角色标注和引号的独立对白片段/);
  assert.match(prompt, /分别标明说话人、分别使用一组中文双引号/);
  assert.match(prompt, /动作、神情、心理、环境和【音效】只能写在引号外/);
  assert.match(prompt, /所有对白、旁白和画外音必须写进实际发生的时间码行/);
  assert.match(prompt, /禁止在时间码之外或最后一条时间码之后集中罗列/);
  assert.match(prompt, /纯动作、反应、环境建立和转场时间码可以没有对白/);
  assert.match(prompt, /按完整剧本的自然叙事组织视频任务/);
  assert.match(prompt, /视频任务数量不设目标，也禁止以减少任务数量为目标/);
  assert.match(prompt, /每条任务时长控制在 10–15 秒/);
  assert.doesNotMatch(prompt, /通常 \d+[–-]\d+ 个切镜/);
  assert.match(prompt, /提取只读对白清单 → 按自然语速计算每段对白时长/);
  assert.match(prompt, /采用语速区间较慢一端保守计算连续发声的理论最低时长/);
  assert.match(prompt, /禁止把整条任务时长全部分配给对白/);
  assert.match(prompt, /同一场景、同一人物、同一轮长对白或同一戏剧节点在容量不足时也必须拆成多个连续任务/);
  assert.match(prompt, /绝不能以“只是切镜”为由把超出时长容量的对白继续留在同一任务/);
  assert.match(prompt, /新任务从上一任务之后的下一个尚未使用剧情事件或对白片段开始/);
  assert.match(prompt, /禁止重复上一任务末尾对白/);
  assert.match(prompt, /角色、场景、商品映射/);
  assert.match(prompt, /标签内依次输出“场景参考”“角色”/);
  assert.match(prompt, /每秒约 3\.5–4 个汉字/);
  assert.match(prompt, /语速区间较慢一端保守计算/);
  assert.match(prompt, /\[2\.5–4\.5秒\]/);
  assert.match(prompt, /最后一个时间码的结束值必须是整数/);
  assert.match(prompt, /从 0 开始、连续无重叠的局部时间码/);
  assert.match(prompt, /禁止使用裸露的“第1镜”标题代替任务标签/);
  assert.match(prompt, /显式写出至少一种景别或视角，以及一种运镜方式/);
  assert.match(prompt, /每个时间码代表一个实际切镜/);
  assert.match(prompt, /说话人变化时必须开始新的时间码/);
  assert.match(prompt, /镜头不移动时也必须明确写“固定镜头”/);
  assert.match(prompt, /不得只写剧情动作而省略镜头语言/);
  assert.match(prompt, /【音效：具体声音】/);
  assert.match(prompt, /音效必须能由画面内动作或环境自然产生/);
  assert.match(prompt, /按本地下载文件名排序/);
  assert.match(prompt, /同一镜中每张图片的序号唯一/);
  assert.match(prompt, /最终组装后的视频提示词展示示例/);
  assert.match(prompt, /第1镜\n\n场景参考：@图片4 家庭餐厅/);
  assert.match(prompt, /角色：@图片2 谷雨，@图片1 父亲，@图片3 母亲/);
  assert.match(prompt, /【音效：筷子轻触碗底的细微声响】/);
  assert.match(prompt, /\[\[Scene_A\]\]/);
  assert.match(prompt, /\[\[Role_A\]\]/);
  assert.match(prompt, /同一角色在全剧所有任务中逐字复用/);
  assert.match(prompt, /每个角色只写一条简短的“核心音色\+年龄性别”/);
  assert.match(prompt, /绑定项左侧必须使用具体人物姓名/);
  assert.match(prompt, /严禁使用 Role_A、Role_B、\[\[Role_A\]\]、\[\[Role_B\]\] 等映射 ID/);
  assert.match(prompt, /明确属于中国，且原文没有外国设定时，统一写“中国男性”或“中国女性”/);
  assert.match(prompt, /禁止写“东亚男性”或“东亚女性”/);
  assert.match(prompt, /原文明示其他国家、地区或民族时严格按原文/);
  assert.match(prompt, /禁止写国籍、外貌、性格经历、成长阶段或当前场景的情绪和语速/);
  assert.match(prompt, /临时表演要求必须写在对应时间码的分镜信息中/);
  assert.match(prompt, /第一行必须且只能是 \[START_OUTPUT\]/);
  assert.match(prompt, /最后一行必须且只能是 \[END_OUTPUT\]/);
  assert.match(prompt, /两个标记都只能出现一次/);
  assert.match(prompt, /角色、场景、商品映射/);
  assert.match(prompt, /不输出 JSON/);
});

test("AI director story instructions omit product references entirely", () => {
  const prompt = buildAiDirectorStoryboardInstructions({
    maxDurationSeconds: 15,
    includeProductReference: false,
  });
  assert.match(prompt, /这是故事视频工作流，不输出任何“商品参考”字段/);
  assert.match(prompt, /禁止写“商品参考：无”或“可选的商品参考：无”/);
  assert.doesNotMatch(prompt, /商品参考：\[\[Product_1\]\]/);
});

test("AI director segmented instructions output task blocks without repeating global mappings", () => {
  const prompt = buildAiDirectorStoryboardInstructions({
    maxDurationSeconds: 15,
    includeProductReference: true,
    segmented: true,
  });
  assert.match(prompt, /AI 导演分段生成中的一个连续剧本范围/);
  assert.match(prompt, /中间只能输出当前分段的全部视频任务/);
  assert.doesNotMatch(prompt, /\[START_ROLE_MAPPING\]/);
  assert.doesNotMatch(prompt, /\[START_SCENE_MAPPING\]/);
  assert.match(prompt, /<VIDEO_TASK>/);
});

test("AI director output keeps one fixed voice per role and removes empty product references", () => {
  const response = `[START_OUTPUT]
<VIDEO_TASK>
场景参考：[[Scene_A]] 家庭餐厅
角色：[[Role_A]] 谷雨，[[Role_B]] 父亲
可选的商品参考：无
角色-声线绑定：谷雨｜克制真诚的青年男声；父亲｜沉稳厚重的中年男声

[0–10秒]：谷雨压着情绪低声说出原文对白，父亲沉默看着他。
</VIDEO_TASK>
<VIDEO_TASK>
场景参考：[[Scene_A]] 家庭餐厅
角色：[[Role_A]] 谷雨，[[Role_B]] 父亲
商品参考：无
角色-声线绑定：谷雨｜慌张、越来越小声；父亲｜带着怒气、语气加重

[0–11秒]：谷雨声音越来越小，父亲语气加重说出原文对白。
</VIDEO_TASK>
[END_OUTPUT]`;
  const normalized = normalizeAiDirectorOutput(response);
  const plan = parseAiDirectorPlanResponse(response);

  assert.doesNotMatch(normalized, /商品参考/);
  assert.equal(plan.segments.length, 2);
  assert.match(plan.segments[0].prompt, /角色-声线绑定：谷雨｜克制真诚的青年男声；父亲｜沉稳厚重的中年男声/);
  assert.match(plan.segments[1].prompt, /角色-声线绑定：谷雨｜克制真诚的青年男声；父亲｜沉稳厚重的中年男声/);
  assert.match(plan.segments[1].prompt, /谷雨声音越来越小，父亲语气加重/);
  assert.doesNotMatch(plan.segments[1].prompt, /谷雨｜慌张/);
});

test("AI director parses direct final-prompt task blocks instead of JSON", () => {
  const plan = parseAiDirectorPlanResponse(directPromptResponse);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].durationSeconds, 13);
  assert.deepEqual(plan.segments[0].assetTokens, [
    "[[ASSET_003]]",
    "[[ASSET_002]]",
    "[[ASSET_001]]",
  ]);
  assert.match(plan.segments[0].prompt, /角色-声线绑定/);
});

test("AI director accepts stable storyboard asset references", () => {
  const response = `${aiDirectorStartMarker}
<VIDEO_TASK>
场景参考：[[Scene_A]] 家庭餐厅
角色：[[Role_A]] 父亲，[[Role_B]] 谷雨
角色-声线绑定：父亲｜沉稳男声，谷雨｜克制青年男声

[0–13秒]：父子在餐桌前完成原剧本对白。
</VIDEO_TASK>
${aiDirectorCompletionMarker}`;
  const plan = parseAiDirectorPlanResponse(response);
  assert.deepEqual(plan.segments[0].assetTokens, ["[[Scene_A]]", "[[Role_A]]", "[[Role_B]]"]);
});

test("AI director rejects an incomplete response without a final-prompt task block", () => {
  assert.throws(
    () => parseAiDirectorPlanResponse("这不是完整的视频任务"),
    /首行必须是 \[START_OUTPUT\]/,
  );
  assert.throws(
    () => parseAiDirectorPlanResponse(`${aiDirectorStartMarker}\n<VIDEO_TASK>没有时间码</VIDEO_TASK>\n${aiDirectorCompletionMarker}`),
    /没有有效时间码/,
  );
  assert.throws(
    () => parseAiDirectorPlanResponse(`${aiDirectorStartMarker}\n<VIDEO_TASK>\n[0–13秒]：尚未传完\n</VIDEO_TASK>`),
    /末行必须是 \[END_OUTPUT\]/,
  );
  assert.throws(
    () => parseAiDirectorPlanResponse(`模型说明\n${directPromptResponse}`),
    /首行必须是 \[START_OUTPUT\]/,
  );
  assert.throws(
    () => parseAiDirectorPlanResponse(`${directPromptResponse}\n额外说明`),
    /末行必须是 \[END_OUTPUT\]/,
  );
  assert.throws(
    () => parseAiDirectorPlanResponse(`${aiDirectorStartMarker}\n${directPromptResponse}`),
    /两个标记都只能出现一次/,
  );
  const cumulativeTimecodeResponse = `${aiDirectorStartMarker}
<VIDEO_TASK>
场景参考：[[Scene_A]] 家庭餐厅
[0–11秒]：第一条任务。
</VIDEO_TASK>
<VIDEO_TASK>
场景参考：[[Scene_A]] 家庭餐厅
[11–15秒]：错误延续上一条任务的时间码。
</VIDEO_TASK>
${aiDirectorCompletionMarker}`;
  assert.throws(
    () => parseAiDirectorPlanResponse(cumulativeTimecodeResponse, { maxDurationSeconds: 15 }),
    /第2条 AI 导演分镜必须使用独立局部时间轴并从 0 秒开始/,
  );
  const overlongTaskResponse = `${aiDirectorStartMarker}
<VIDEO_TASK>
场景参考：[[Scene_A]] 家庭餐厅
[0–16秒]：超过所选最大时长。
</VIDEO_TASK>
${aiDirectorCompletionMarker}`;
  assert.throws(
    () => parseAiDirectorPlanResponse(overlongTaskResponse, { maxDurationSeconds: 15 }),
    /超过所选最大 15 秒/,
  );
});

test("AI director user prompt sends one complete script and targets the selected duration", () => {
  const baseInput = {
    workflowType: "story",
    script: "第1镜：谷雨向父亲开口借钱。第2镜：父亲让他明早跟车。",
    assets,
  };
  const fifteenSecondPrompt = buildAiDirectorUserPrompt({
    ...baseInput,
    maxDurationSeconds: 15,
  });
  assert.match(fifteenSecondPrompt, /每条任务通常为 10–15 秒/);
  assert.match(fifteenSecondPrompt, /视频任务数量不设目标，也禁止以减少任务数量为目标/);
  assert.doesNotMatch(fifteenSecondPrompt, /原稿客观容量预算/);
  assert.doesNotMatch(fifteenSecondPrompt, /不得少于 \d+ 条视频任务/);
  assert.doesNotMatch(fifteenSecondPrompt, /切镜密度/);
  assert.match(fifteenSecondPrompt, /“第N镜”只用于确认原剧情顺序/);
  assert.match(fifteenSecondPrompt, /【完整剧本】/);
  assert.match(fifteenSecondPrompt, /第1镜：谷雨向父亲开口借钱/);
  assert.match(fifteenSecondPrompt, /<VIDEO_TASK>/);
  assert.match(fifteenSecondPrompt, /\[\[ASSET_003\]\]｜scene｜家庭餐厅/);
  assert.match(fifteenSecondPrompt, /场景参考：\[\[ASSET_003\]\] 家庭餐厅/);
  assert.match(fifteenSecondPrompt, /禁止编造素材或自行书写 @图片N/);
  assert.match(fifteenSecondPrompt, /原对白是不可编辑的只读数据/);
  assert.match(fifteenSecondPrompt, /原对白逐字保留高于其他所有要求/);
  assert.match(fifteenSecondPrompt, /必须增加视频任务或继续拆分对白/);
  assert.match(fifteenSecondPrompt, /当前对白尚未逐字输出完毕时，禁止切换场景/);
  assert.match(fifteenSecondPrompt, /下一任务必须由原说话人从尚未输出的字符继续/);
  assert.match(fifteenSecondPrompt, /只有全部原对白输出完成后，才允许输出 \[END_OUTPUT\]/);
  assert.match(fifteenSecondPrompt, /生成时只能从原剧本逐字复制/);
  assert.match(fifteenSecondPrompt, /错别字、病句、重复、错误标点或引号不完整，也不得纠正/);
  assert.match(fifteenSecondPrompt, /拆分片段按顺序直接拼接后必须与原文逐字一致/);
  assert.match(fifteenSecondPrompt, /每句原对白或其拆分片段只能消费一次/);
  assert.match(fifteenSecondPrompt, /禁止对原对白进行语义去重、重要性筛选或上下文推断/);
  assert.match(fifteenSecondPrompt, /询问、回答、确认、重复和过渡对白仍必须逐字输出/);
  assert.match(fifteenSecondPrompt, /“提问—回答”等连续对白单元不得拆掉任何一方/);
  assert.match(fifteenSecondPrompt, /外层格式引号不能替换、吞掉、修复或删除原文自身的异常引号和标点/);
  assert.match(fifteenSecondPrompt, /每个拆分片段都必须独立重新写出原说话人/);
  assert.match(fifteenSecondPrompt, /禁止以无角色标注的裸文本延续上一个任务的对白/);
  assert.match(fifteenSecondPrompt, /所有对白、旁白和画外音必须直接写入实际发生的时间码行/);
  assert.match(fifteenSecondPrompt, /有对白的时间码必须同时写明说话人、当前情绪或语速/);
  assert.match(fifteenSecondPrompt, /纯动作、反应、环境建立和转场时间码可以没有对白/);
  assert.match(fifteenSecondPrompt, /每句原对白都出现且仅出现一次/);
  assert.match(fifteenSecondPrompt, /所有原对白仍须逐字保留/);
  assert.match(fifteenSecondPrompt, /允许把前后连续的原分镜重新组织/);
  assert.match(fifteenSecondPrompt, /禁止复述上一任务最后一句对白或拆分片段/);
  assert.match(fifteenSecondPrompt, /每个角色只写一条简短的“核心音色\+年龄性别”/);
  assert.match(fifteenSecondPrompt, /“角色-声线绑定”左侧必须写具体人物姓名/);
  assert.match(fifteenSecondPrompt, /严禁写 Role_A、Role_B、\[\[Role_A\]\]、\[\[Role_B\]\] 等角色映射 ID/);
  assert.match(fifteenSecondPrompt, /明确属于中国，且原文没有外国设定时，统一写“中国男性”或“中国女性”/);
  assert.match(fifteenSecondPrompt, /禁止写“东亚男性”或“东亚女性”/);
  assert.match(fifteenSecondPrompt, /临时情绪、语速和说话状态全部写在对应时间码的分镜信息中/);
  assert.doesNotMatch(fifteenSecondPrompt, /对白必须根据完整剧本重新创作/);
  assert.match(fifteenSecondPrompt, /\[START_OUTPUT\]/);
  assert.match(fifteenSecondPrompt, /\[END_OUTPUT\]/);
  assert.match(fifteenSecondPrompt, /每秒约 3\.5–4 个汉字/);
  assert.match(fifteenSecondPrompt, /语速区间较慢一端保守计算/);
  assert.match(fifteenSecondPrompt, /最后一个时间码的结束值为整数/);
  assert.match(fifteenSecondPrompt, /时间段数量按实际导演需要决定/);
  assert.match(fifteenSecondPrompt, /【音效：符合场景的克制环境声】/);
  assert.match(fifteenSecondPrompt, /按本地下载文件名排序/);
  assert.match(fifteenSecondPrompt, /同一镜中每张图片的序号唯一/);
  assert.match(fifteenSecondPrompt, /最终组装后的视频提示词展示示例/);
  assert.match(fifteenSecondPrompt, /场景参考：@图片4 家庭餐厅/);
  assert.match(fifteenSecondPrompt, /【音效：筷子轻触碗底的细微声响】/);
  assert.match(fifteenSecondPrompt, /\[8\.5–11秒\]/);
  assert.match(fifteenSecondPrompt, /禁止润色、改写、概括/);
  assert.match(fifteenSecondPrompt, /不输出 JSON/);
  assert.doesNotMatch(fifteenSecondPrompt, /sourceShotIds/);

  const tenSecondPrompt = buildAiDirectorUserPrompt({
    ...baseInput,
    maxDurationSeconds: 10,
  });
  assert.match(tenSecondPrompt, /每条任务通常为 4–10 秒/);
  assert.match(tenSecondPrompt, /\[7–9秒\]/);
});

test("AI director prompts inject the selected dialogue language and matching speech rate", () => {
  const script = `小木屋 / 晚上

Leo: Everyone watching right now, hit that like button and subscribe.`;
  const userPrompt = buildAiDirectorUserPrompt({
    workflowType: "story",
    language: "en",
    script,
    assets,
    maxDurationSeconds: 15,
  });
  const instructions = buildAiDirectorStoryboardInstructions({
    maxDurationSeconds: 15,
    includeProductReference: false,
    segmented: true,
    dialogueLanguage: "en",
  });

  assert.match(userPrompt, /【对白语言】\n英语/);
  assert.match(userPrompt, /英语对白按每秒约 2\.2–2\.7 个单词/);
  assert.doesNotMatch(userPrompt, /该段秒数 × 4 个汉字/);
  assert.match(instructions, /当前对白语言为英语/);
  assert.match(instructions, /英语对白按每秒约 2\.2–2\.7 个单词/);
});

test("AI director prompt keeps language-specific natural speech guidance", () => {
  const expectedGuidance = {
    zh: "中文对白按每秒约 3.5–4 个汉字估算",
    en: "英语对白按每秒约 2.2–2.7 个单词",
    de: "德语对白按每秒约 2–2.4 个单词",
    fr: "法语对白按每秒约 2.3–2.7 个单词",
    ja: "日语对白按每秒约 5–6 个假名或汉字字符估算",
    ko: "韩语对白按每秒约 4–5 个韩文音节估算",
    id: "印尼语对白按每秒约 2.3–2.7 个单词",
    pt: "葡萄牙语对白按每秒约 2.3–2.7 个单词",
    es: "西班牙语对白按每秒约 2.5–2.9 个单词",
  };

  for (const [language, guidance] of Object.entries(expectedGuidance)) {
    const prompt = buildAiDirectorStoryboardInstructions({
      maxDurationSeconds: 15,
      dialogueLanguage: language,
    });
    assert.ok(prompt.includes(guidance), `${language} should use its own natural speech guidance`);
  }
});

test("AI director timeline aligns each prompt's local image numbers with its selected assets", () => {
  const plan = parseAiDirectorPlanResponse(directPromptResponse);
  const timeline = buildWorkflowAiDirectorTimeline({
    plan,
    assets,
    maxDurationSeconds: 15,
  });

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].durationSeconds, 13);
  assert.equal(timeline[0].title, "第1镜");
  assert.deepEqual(timeline[0].assets.map((asset) => asset.title), ["父亲", "谷雨", "家庭餐厅"]);
  assert.match(timeline[0].videoPrompt, /场景参考：@图片3 家庭餐厅/);
  assert.match(timeline[0].videoPrompt, /角色：@图片2 谷雨，@图片1 父亲/);
  assert.doesNotMatch(timeline[0].videoPrompt, /\[\[ASSET_/);
  assert.match(timeline[0].videoPrompt, /\[1.5–13秒\]/);
  assert.match(timeline[0].videoPrompt, /规则：/);
  assert.match(timeline[0].videoPrompt, /不要生成任何背景音乐（BGM）或配乐/);
});

test("stored AI director storyboard assembles video prompts without another model request", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-ai-director-assemble-"));
  const config = {
    env: "test",
    dataDir,
    store: { driver: "json" },
    storage: { provider: "local" },
  };
  const user = ensureUser(config, {
    id: "ai-director-user",
    email: "ai-director@example.com",
    displayName: "AI Director",
  });
  const workflow = await createWorkflow(user, {
    id: "ai-director-workflow",
    name: "AI 导演组装测试",
    type: "story",
    config: { type: "story" },
  }, config);
  const stablePrompt = directPromptResponse
    .replaceAll("[[ASSET_003]]", "[[Scene_A]]")
    .replaceAll("[[ASSET_002]]", "[[Role_B]]")
    .replaceAll("[[ASSET_001]]", "[[Role_A]]");
  const plan = parseAiDirectorPlanResponse(stablePrompt);
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: "ai-director-run",
    kind: "topic-child",
    status: "waiting",
    stages: {
      script: "done",
      shot: "done",
      image: "done",
      videoPrompt: "pending",
      video: "pending",
      draft: "pending",
    },
    result: {
      scriptOutput: "谷雨向父亲借钱，父亲让他明早跟车。",
      storyboardMode: "ai-director",
      aiDirectorMaxDurationSeconds: 15,
      aiDirectorPlan: { ...plan, maxDurationSeconds: 15, modelId: "shot-model" },
      shots: [
        { assetRef: "Role_A", assetType: "role", title: "父亲", imageUrl: "https://example.com/father.png" },
        { assetRef: "Role_B", assetType: "role", title: "谷雨", imageUrl: "https://example.com/gu.png" },
        { assetRef: "Scene_A", assetType: "scene", title: "家庭餐厅", imageUrl: "https://example.com/scene.png" },
      ],
    },
  }, config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("stored storyboard assembly must not call a model provider");
  };
  try {
    const result = await executeWorkflowVideoPromptNode(user, {
      runId: run.id,
      videoPromptMode: "ai-director-assemble",
      maxDurationSeconds: 15,
    }, config);
    assert.equal(result.timeline.length, 1);
    assert.match(result.timeline[0].videoPrompt, /@图片/);
    assert.doesNotMatch(result.timeline[0].videoPrompt, /\[\[(?:Scene|Role)_/);
    assert.equal(result.run.result.videoPromptPlan.source, "storyboard");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});
