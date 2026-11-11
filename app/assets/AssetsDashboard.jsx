"use client";

import { Component, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  deleteAsset,
  deleteAssetGroup,
  generateImages,
  generateText,
  getTeamContext,
  listAssets,
  listApiKeys,
  queueRoleAssetImageGeneration,
  queueScriptAssetVideoAnalysis,
  queueWritingStyleAnalysis,
  readAuthToken,
  resolveFlowStudioFileUrl,
  saveAsset,
  saveAssetGroup,
  uploadAssetFiles,
} from "../../lib/flowstudio-api";
import PageLoading from "../../components/PageLoading";
import { apiKeysForService } from "../../lib/api-key-options";
import { allImageModels as roleImageModels, imageModelsForApiKey } from "../../lib/image-model-options";
import { apiKeySupportsVideoAnalysis, llmModelsForApiKey, videoAnalysisModelId, videoAnalysisModelsForApiKey } from "../../lib/llm-model-options";
import { normalizeYoutubeVideoUrl } from "../../lib/youtube-video-url.mjs";
import {
  defaultWorkflowRoleImageStyleId as defaultRoleImageType,
  workflowRoleImageStyleOptions as roleImageTypeOptions,
} from "../../lib/workflow-role-image-style.mjs";

const assetTypes = [
  { id: "image-library", label: "图片库", iconClass: "image", desc: "图库分组与参考图", color: "cyan", unit: "图库" },
  { id: "visual-style", label: "图风库", iconClass: "style", desc: "图片生成风格", color: "violet", unit: "视觉风格预设" },
  { id: "writing-style", label: "文风库", iconClass: "writing", desc: "文案表达风格", color: "teal", unit: "文案表达风格" },
  { id: "music", label: "音乐库", iconClass: "music", desc: "背景音乐与音效", color: "rose", unit: "音频" },
  { id: "prompt", label: "提示词库", iconClass: "prompt", desc: "可复用提示词", color: "blue", unit: "提示词" },
  { id: "script", label: "脚本库", iconClass: "script", desc: "对标视频脚本结构", color: "mint", unit: "脚本资产" },
  { id: "role", label: "角色库", iconClass: "role", desc: "角色与主播人设", color: "gold", unit: "角色资产" },
  { id: "hook", label: "爆款开头", iconClass: "hook", desc: "前 3 秒钩子", color: "lime", unit: "开头资产" },
  { id: "element", label: "爆款元素", iconClass: "element", desc: "可插入增长元素", color: "orange", unit: "元素资产" },
  { id: "product", label: "带货产品库", iconClass: "product", desc: "商品卖点与约束", color: "amber", unit: "产品资产" },
];

const futureAssets = [];

const systemVisualStyles = [
  {
    id: "system-real-photo",
    name: "真实摄影风",
    desc: "真实镜头、自然光线、细节可信",
    prompt: "realistic photography, natural lighting, authentic details, true-to-life texture",
    system: true,
  },
  {
    id: "system-3d-animation",
    name: "3D动画风",
    desc: "3D 动画渲染质感，色彩明快",
    prompt: "3D animation style, cinematic lighting, vibrant colors, smooth rendering",
    system: true,
  },
];

const emptyAssets = {
  "image-library": { groups: [], assets: [] },
  "visual-style": { groups: [], assets: [] },
  "writing-style": { groups: [], assets: [] },
  prompt: { groups: [], assets: [] },
  music: { groups: [], assets: [] },
  script: { groups: [], assets: [] },
  role: { groups: [], assets: [] },
  hook: { groups: [], assets: [] },
  element: { groups: [], assets: [] },
  product: { groups: [], assets: [] },
};

const ecommerceAssetTypes = new Set(["script", "role", "hook", "element", "product"]);
const defaultVideoAnalysisModel = videoAnalysisModelId;
const defaultRoleImageModel = "";
const videoAnalysisAssetTypes = new Set(["script", "role", "hook", "element", "product"]);
const youtubeVideoAnalysisAssetTypes = new Set(["script", "role", "hook", "element"]);
const videoAnalysisMaxBytes = 20 * 1024 * 1024;
const videoAnalysisTimeoutMinutes = 20;
const videoAnalysisMaxTimeoutMinutes = 20;
const videoAnalysisTimeoutMs = videoAnalysisTimeoutMinutes * 60 * 1000;
const videoAnalysisMaxTimeoutMs = videoAnalysisMaxTimeoutMinutes * 60 * 1000;
const videoAnalysisRetryDelayMs = 4000;
const writingStyleAnalysisPollMs = 4000;
const editableTypes = new Set(["prompt", "writing-style", "visual-style", ...ecommerceAssetTypes]);
const groupedEditableTypes = new Set(["image-library", "music", "prompt", "writing-style", ...ecommerceAssetTypes]);
const roleImagePromptTemplate = "国籍/民族观感+性别，全身照，身形特征+外貌特征+具体穿着，无表情，双手下垂，正常清晰人脸，真实摄影，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物";
const roleImagePromptExample = "中国女性，全身照，孕妇体形，黑色直发戴珍珠发箍，浅黄色短袖连衣裙，无表情，双手下垂，正常清晰人脸，真实摄影，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物";
const roleImagePromptRequiredSegments = [
  "全身照",
  "无表情",
  "双手下垂",
  "正常清晰人脸",
  "真实摄影",
  "纯灰白色无缝摄影棚背景",
  "背景中没有任何物体或人物",
];
const roleImageMosaicRequiredSegments = ["人物脸部打上马赛克", "其他部分保持真实摄影", "三视图"];
const roleImageThreeViewRequiredSegments = ["三视图"];
const roleImagePromptDeprecatedSegments = new Set(["写实风格", "电影级光影", "8k分辨率", "超高细节"]);
const roleImageAutoMinCount = 1;
const roleImageAutoMaxCount = 5;
const roleImageTotalMaxCount = 10;
const roleImageDesignVariants = [
  {
    label: "默认造型",
    prompt: "沿用原始穿着描述",
  },
  {
    label: "日常备用造型",
    prompt: "穿着同身份同季节的深灰色简洁外套，内搭浅色上衣，下穿深色长裤，鞋履简洁",
  },
  {
    label: "材质色彩变化",
    prompt: "穿着低饱和色系中长款外套，内搭纯色上衣，下穿中性色长裤，材质更柔和",
  },
  {
    label: "同风格备用造型",
    prompt: "穿着同风格备用套装，外层与下装剪裁合身，整体颜色比默认造型略有变化",
  },
  {
    label: "简洁替换造型",
    prompt: "穿着符合角色身份的简洁替换服装，浅色内搭配深色外层和长裤，整体干净利落",
  },
];

const emptyGroupForm = {
  id: "",
  name: "",
  desc: "",
};

const emptyAssetForm = {
  id: "",
  name: "",
  groupId: "",
  desc: "",
  prompt: "",
  tag: "",
  shared: false,
  llmKeyId: "",
  modelId: defaultVideoAnalysisModel,
  entryMode: "video",
  videoSourceMode: "upload",
  youtubeUrl: "",
  files: [],
  sourceFile: null,
  videoDurationSeconds: 0,
  fileError: "",
  nameError: "",
  generateRoleImages: false,
  roleImageDesignCount: 1,
  roleImageType: defaultRoleImageType,
  roleImageCustomPrompt: "",
  imageKeyId: "",
  imageModelId: defaultRoleImageModel,
  imageRatio: "1:1",
  imageResolution: "1k",
  imageFormat: "png",
  roleCountMode: "auto",
  roleCount: 1,
  targetDurationMode: "source",
  targetDurationSeconds: "",
};

const emptyWritingStyleExtractForm = {
  name: "",
  groupId: "",
  llmKeyId: "",
  modelId: "",
  files: [],
  shared: false,
};

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

const productVideoAnalysisPrompt = `# Role: 专业电商视频信息提取专家

## Task
你将接收到一个剧情带货视频。你的任务是深度分析视频的视觉画面、人物对白（音轨）以及屏幕贴纸信息，提取出该产品的核心营销资料。

## Analysis Workflow
1. **全景扫描**：观看完整视频，识别视频中出现的带货产品数量。
2. **多产品预警**：如果视频中出现的独立产品（品牌或品类不同）超过 1 个，请停止后续分析，直接列出你识别到的所有产品名称，并询问：“检测到多个产品，请问您需要提取哪一个的信息？”
3. **精准提取**：若只有一个产品，请严格按照以下【提取准则】进行信息复原：
    - **如实还原**：不要过度润饰，基于视频中真实出现的台词、画面和价格进行记录。
    - **视觉优先**：对于“使用动态描述”，必须详细描述视频中人物真实的动作细节（如：撕开、咀嚼、展示特写等）。
    - **逻辑归纳**：从剧情冲突中识别“用户痛点”，从解决剧情问题的方式中识别“使用效果”。

## Extraction Template (纯文本输出)

【带货产品资料】
产品名称：[从对白或包装中提取，需精准]
产品亮点：[列举视频中提到的配料、工艺、产地、独特卖点等]
使用效果：[描述视频中展示或提到的产品功效、服用后的改变]
使用动态描述：[具体描述视频中模特/演员使用产品的动作、展示细节，不少于50字]
用户痛点：[视频剧情中所针对的尴尬场景、身体不适或生活难题]
面向人群：[根据剧情背景推断，如：久坐族、老师、吸烟者等]
价格文本：[视频中明确提到的价格、直播间活动价及赠品信息]

## Constraint & Quality Control
- 语言：必须使用中文。
- 严禁幻觉：视频中未提及的信息（如价格未提），请填写“视频未提及”。
- 动态捕捉：不要只写“食用产品”，要写出“从罐子里抓出一把，放进嘴里用力嚼，并展示出很有嚼劲的样子”。

## Output Rules
- 只输出【带货产品资料】模板，不要输出“视频类型”“剧情大纲”“分镜分析”“营销结构”“建议”等额外章节。
- 必须逐项保留以下 7 个字段，字段名不得改写、合并或增删：产品名称、产品亮点、使用效果、使用动态描述、用户痛点、面向人群、价格文本。
- 如果确实没有识别到对应信息，该字段填写“视频未提及”。`;

const roleVideoAnalysisPrompt = `# Role
你是一个顶尖的多模态视频分析专家、剧本角色拆解师以及专业的 AI 绘画提示词工程师。你擅长从真人短剧或 AI 视频中精准捕捉人物细节，并严格按照特定的美术标准构建高质量的 JSON 数据。

# Objective
请仔细观看并分析我上传的视频文件。识别视频中真实出现、可确认外观的人物，提取他们的关键信息，并为每个角色生成一段用于 AI 绘画的“写实风格”**中文**提示词。最终结果必须以严格的 JSON 格式输出。

# Workflow (思维链步骤)
请按照以下步骤在后台进行思考，但最终只输出 JSON：
1. **角色扫描**：先识别视频中所有真实出现且外观可确认的人物，并按优先级分层：核心角色（推动剧情、反复出现、有明确台词或承担主要冲突） > 重要配角（辅助冲突或有清晰互动） > 可确认边缘人物（短暂出镜但脸部/服装/身份或动作足够清楚）。如果没有提到具体名字，请根据其特征赋予一个代号。
2. **特征提取**：分析该角色在剧中的性格特征、身份定位以及显著的行为习惯。
3. **视觉分析与提示词构建 (中文)**：提取角色的国籍/民族观感、性别、年龄段、体形特征、发型、典型穿着。然后，将这些特征与**强制视觉规范**结合，生成一段纯中文的绘画提示词。
   - 绘画提示词必须按固定顺序组织：**${roleImagePromptTemplate}**。
   - “国籍/民族观感+性别”必须合并成“中国女性”“中国男性”等短语；身形、外貌、穿着特征必须紧跟在“全身照”之后。
   - 必须把模板中的“国籍/民族观感+性别”“身形特征+外貌特征+具体穿着”替换成视频里可观察到的具体描述，不要原样输出占位词。
   - 不要输出“写实风格、电影级光影、8k分辨率、超高细节”等旧版风格词；真实摄影要求只保留为“其他部分保持真实摄影”。
4. **JSON 组装**：将上述信息组装成指定的 JSON 格式。

# Constraints & Formatting
- 必须且只能输出纯 JSON 格式的数据。绝对不要在 JSON 前后输出任何解释性文本、问候语，也不要使用 Markdown 代码块标记（如 \`\`\`json）。
- JSON 必须使用中文字段名，方便系统保存字段。不要输出英文字段名 characters/name/traits/realistic_image_prompt。
- 如果我未指定角色数量，请由你判断核心角色数量，只输出核心角色和重要配角，排除边缘人物。
- 如果我指定了角色数量，请把指定数量当作目标数量：先输出核心角色，不足时继续用重要配角补足，再不足时可以使用外观可确认的边缘人物补足。禁止凭空捏造没有出现在视频中的人物；如果视频中所有可确认人物总数仍少于指定数量，就只输出实际可确认的人物数量。
- 不要提取完全无法辨认外观的背景人群、模糊路人、屏幕一角无法判断身份的人物；只有可用于生成角色图的人才可以进入角色列表。
- 如果不知道角色真实姓名，请用“角色A / 角色B / 男主 / 女主 / 老板”等代号，不能因为不知道姓名而留空。
- 每个角色都必须填写“角色名字”“角色定义”“角色绘画提示词”三个字段，不能缺字段，不能写 null。
- 顶层“角色数量”必须等于“角色列表”的实际条目数。
- “角色定义”必须包含该角色的国籍/民族观感、性别、年龄段、身份、性格特征和行为描述。
- “角色绘画提示词”必须明确写出国籍/民族观感+性别、全身照、身形特征、外貌特征、具体穿着，不要只写性格；同时必须包含无表情、双手下垂、正常清晰人脸、真实摄影、纯灰白色无缝摄影棚背景、背景中没有任何物体或人物。不要在基础角色绘画提示词里加入人脸马赛克、脸部打码或三视图要求，图片类型会在后续生成阶段单独控制。
- 保持 JSON 精简，不要输出剧情分析、分镜、镜头列表、产品信息或解释；“角色定义”控制在 120 字以内，“角色绘画提示词”控制在 180 字以内。
- 数据结构必须严格遵循以下 JSON Schema：

{
  "角色数量": 1,
  "角色列表": [
    {
      "角色名字": "角色名字或代号",
      "角色定义": "国籍/民族观感、性别、年龄段、身份、性格特征和行为描述（中文，简明扼要）",
      "角色绘画提示词": "${roleImagePromptExample}"
    }
  ]
}`;

const hookVideoAnalysisPrompt = `# Role
你是短视频爆款开头拆解专家，擅长从剧情带货、口播带货、测评种草视频中提取可复用的前 3-8 秒钩子技巧。

# Objective
请观看上传视频，识别视频中真正有效的爆款开头技巧。一个视频可以提取多个可复用开头技巧，但每个技巧必须能独立沉淀为资产卡片。

# Extraction Rules
1. 重点分析视频开头 3-8 秒，也可以补充视频中反复出现、可迁移到开头的强钩子表达。
2. 只提取明确可复用的技巧，不要把普通剧情介绍、无信息量寒暄、泛泛卖点硬凑成技巧。
3. 每个技巧必须包含：开头名称、摘要、标签、可复用内容。
4. 可复用内容必须写清楚：原始开头/画面动作、开头类型、钩子逻辑、可替换模板、适用品类/场景、使用注意。

# Output Format
必须且只能输出中文 JSON，不要输出 Markdown，不要输出解释。

{
  "爆款开头列表": [
    {
      "开头名称": "一句话命名这个开头技巧",
      "摘要": "一句话说明这个开头为什么抓人",
      "标签": "反差, 痛点, 悬念",
      "可复用内容": "原始开头：...\\n开头类型：...\\n钩子逻辑：...\\n可替换模板：...\\n适用品类/场景：...\\n使用注意：..."
    }
  ]
}`;

const elementVideoAnalysisPrompt = `# Role
你是短视频爆款元素拆解专家，擅长从剧情带货、口播带货、测评种草视频中提取可插入到新脚本中的增长元素。

# Objective
请观看上传视频，识别其中可以复用的爆款元素。一个视频可以提取多个元素，每个元素都必须作为独立资产卡片保存。

# Extraction Rules
1. 爆款元素可以包括：痛点放大、身份反差、价格锚点、前后对比、产品特写、信任背书、限时福利、用户证言、冲突反转、行动 CTA 等。
2. 只提取明确可复用且能服务剧情推进或转化的元素，不要泛泛总结。
3. 每个元素必须包含：元素名称、摘要、标签、可复用内容。
4. 可复用内容必须写清楚：元素类型、适用阶段、插入方式、示例文案/画面、适用品类/场景、风险提示。

# Output Format
必须且只能输出中文 JSON，不要输出 Markdown，不要输出解释。

{
  "爆款元素列表": [
    {
      "元素名称": "一句话命名这个爆款元素",
      "摘要": "一句话说明这个元素的作用",
      "标签": "痛点, 反差, 转化",
      "可复用内容": "元素类型：...\\n适用阶段：...\\n插入方式：...\\n示例文案/画面：...\\n适用品类/场景：...\\n风险提示：..."
    }
  ]
}`;

export default function AssetsDashboard() {
  const [assets, setAssets] = useState(emptyAssets);
  const [apiKeys, setApiKeys] = useState([]);
  const [teamContext, setTeamContext] = useState(null);
  const [activeType, setActiveType] = useState("");
  const [loadState, setLoadState] = useState("loading");
  const [message, setMessage] = useState("正在读取创意资产...");
  const [initialLoading, setInitialLoading] = useState(true);
  const [groupForm, setGroupForm] = useState(emptyGroupForm);
  const [assetForm, setAssetForm] = useState(emptyAssetForm);
  const [writingStyleExtractForm, setWritingStyleExtractForm] = useState(emptyWritingStyleExtractForm);
  const [busyAction, setBusyAction] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [pendingFeature, setPendingFeature] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);

  useEffect(() => {
    if (!readAuthToken()) return;
    let active = true;
    loadAllAssets(() => active);
    return () => {
      active = false;
    };
  }, []);

  async function loadAllAssets(isActive = () => true) {
    setLoadState("loading");
    setMessage("正在读取创意资产...");
    const results = await Promise.allSettled([...assetTypes.map((type) => listAssets(type.id)), listApiKeys(), getTeamContext()]);
    if (!isActive()) return;

    const assetResults = results.slice(0, assetTypes.length);
    const nextAssets = { ...emptyAssets };
    assetResults.forEach((result, index) => {
      const type = assetTypes[index].id;
      if (result.status !== "fulfilled") return;
      nextAssets[type] = {
        groups: Array.isArray(result.value?.groups) ? result.value.groups : [],
        assets: Array.isArray(result.value?.assets) ? result.value.assets : [],
      };
    });

    const timedOutVideoAssets = collectTimedOutVideoAnalysisAssets(nextAssets);
    const visibleAssets = markTimedOutVideoAnalysisAssets(nextAssets, timedOutVideoAssets);
    const apiResult = results[assetTypes.length];
    const teamResult = results[assetTypes.length + 1];
    const failedAssetCount = assetResults.filter((result) => result.status === "rejected").length;
    const auxiliaryFailed = apiResult?.status === "rejected" || teamResult?.status === "rejected";
    setAssets(visibleAssets);
    if (apiResult?.status === "fulfilled") {
      setApiKeys(Array.isArray(apiResult.value?.apiKeys) ? apiResult.value.apiKeys : []);
    }
    if (teamResult?.status === "fulfilled") {
      setTeamContext(teamResult.value || null);
    }
    if (timedOutVideoAssets.length) {
      persistTimedOutVideoAnalysisAssets(timedOutVideoAssets).catch(() => {});
    }
    setLoadState(failedAssetCount || auxiliaryFailed || timedOutVideoAssets.length ? "warning" : "ready");
    setMessage(
      failedAssetCount
        ? `${failedAssetCount} 类资产暂时不可用，其余资产已显示。`
        : auxiliaryFailed
          ? "创意资产已显示，部分团队或 API 配置暂时不可用。"
        : timedOutVideoAssets.length
          ? `${timedOutVideoAssets.length} 个视频分析超过预计时间未完成，已标记为失败。`
        : "创意资产已同步。",
    );
    setInitialLoading(false);
  }

  async function persistTimedOutVideoAnalysisAssets(items = []) {
    const now = new Date().toISOString();
    await Promise.allSettled(items.map(({ type, asset }) => saveAsset(type, {
      id: asset.id,
      name: asset.name,
      groupId: asset.groupId || "",
      fileUrl: asset.sourceFile?.fileUrl || asset.fileUrl || "",
      fileKey: asset.sourceFile?.fileKey || asset.fileKey || "",
      mimeType: asset.sourceFile?.mimeType || asset.mimeType || "",
      sizeBytes: asset.sourceFile?.sizeBytes || asset.sizeBytes || 0,
      createdAt: asset.createdAt,
      payload: {
        ...asset,
        desc: "视频分析超时",
        prompt: asset.prompt || "",
        analysisStatus: "error",
        analysisError: videoAnalysisTimeoutMessage(asset),
        analysisTimeoutMs: videoAnalysisTimeoutMsForAsset(asset),
        updatedAt: now,
      },
    })));
  }

  const normalized = useMemo(() => normalizeAssetState(assets), [assets]);
  const activeDefinition = assetTypes.find((type) => type.id === activeType) || assetTypes[0];
  const activeData = normalized[activeType] || emptyAssets["image-library"];
  const canEditActiveType = editableTypes.has(activeType);
  const canManageGroups = groupedEditableTypes.has(activeType);
  const showInitialLoading = initialLoading && loadState === "loading";
  const hasRunningWritingStyleAnalysis = activeType === "writing-style" && activeData.assets.some((asset) => asset.analysisStatus === "running");

  useEffect(() => {
    if (!hasRunningWritingStyleAnalysis) return undefined;
    let active = true;
    let refreshing = false;
    const timer = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await listAssets("writing-style");
        if (!active) return;
        setAssets((current) => ({
          ...current,
          "writing-style": {
            groups: Array.isArray(result?.groups) ? result.groups : [],
            assets: Array.isArray(result?.assets) ? result.assets : [],
          },
        }));
      } catch {
        // Keep the current card state and retry on the next interval.
      } finally {
        refreshing = false;
      }
    }, writingStyleAnalysisPollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [hasRunningWritingStyleAnalysis]);

  function switchAssetType(type) {
    setActiveType(type);
    setGroupForm(emptyGroupForm);
    setAssetForm(emptyAssetForm);
    setWritingStyleExtractForm(emptyWritingStyleExtractForm);
    setEditorOpen(false);
    setEditorMode("");
    setSelectedGroupId("");
  }

  async function handleSaveGroup(event) {
    event.preventDefault();
    if (!canManageGroups) return;
    const name = groupForm.name.trim();
    if (!name) {
      setLoadState("error");
      setMessage("请填写分组名称。");
      return;
    }

    setBusyAction("save-group");
    setLoadState("loading");
    setMessage(groupForm.id ? "正在保存分组..." : "正在创建分组...");
    try {
      await saveAssetGroup(activeType, {
        id: groupForm.id || crypto.randomUUID(),
        name,
        desc: groupForm.desc.trim(),
      });
      setGroupForm(emptyGroupForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      setLoadState("ready");
      setMessage(activeType === "image-library" ? "图库已保存。" : activeType === "music" ? "音乐分组已保存。" : "分组已保存。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "分组保存失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteGroup(group) {
    if (!canManageGroups) return;
    const type = activeType;
    setConfirmDialog({
      title: deleteGroupDialogTitle(type),
      summary: deleteGroupDialogSummary(type, group),
      label: "当前分组",
      target: group.name || "未命名分组",
      hint: deleteGroupDialogHint(type),
      confirmText: "确认删除",
      danger: true,
      onConfirm: () => deleteGroupConfirmed(type, group),
    });
  }

  async function deleteGroupConfirmed(type, group) {
    setBusyAction(`delete-group-${group.id}`);
    setLoadState("loading");
    setMessage("正在删除分组...");
    try {
      await deleteAssetGroup(type, group.id);
      if (groupForm.id === group.id) setGroupForm(emptyGroupForm);
      await loadAllAssets();
      setLoadState("ready");
      setMessage(type === "image-library" ? "图库已删除。" : type === "music" ? "音乐分组已删除。" : "分组已删除。");
      setConfirmDialog(null);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "分组删除失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveAsset(event) {
    event.preventDefault();
    if (!canEditActiveType) return;
    if (videoAnalysisAssetTypes.has(activeType)) {
      await handleSaveVideoAnalysisAsset();
      return;
    }
    const name = assetForm.name.trim();
    const prompt = assetForm.prompt.trim();
    const desc = assetForm.desc.trim();
    if (!name) {
      setLoadState("error");
      setMessage("请填写资产名称。");
      return;
    }
    if (["prompt", "visual-style"].includes(activeType) && !prompt) {
      setLoadState("error");
      setMessage(activeType === "visual-style" ? "请填写图风提示词。" : "请填写提示词内容。");
      return;
    }

    const now = new Date().toISOString();
    const id = assetForm.id || crypto.randomUUID();
    const payload = {
      id,
      name,
      groupId: canManageGroups ? assetForm.groupId : "",
      desc,
      prompt,
      tag: assetForm.tag.trim(),
      shared: Boolean(assetForm.shared),
      system: false,
      createdAt: assetForm.id ? undefined : now,
      updatedAt: now,
    };

    setBusyAction("save-asset");
    setLoadState("loading");
    setMessage(assetForm.id ? "正在保存资产..." : "正在创建资产...");
    try {
      await saveAsset(activeType, {
        id,
        name,
        groupId: canManageGroups ? assetForm.groupId : "",
        createdAt: payload.createdAt,
        ...assetTeamShareFields(assetForm, teamContext),
        payload,
      });
      setAssetForm(emptyAssetForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      if (canManageGroups) {
        setSelectedGroupId(assetForm.groupId || ungroupedAssetGroupId(activeType));
      }
      setLoadState("ready");
      setMessage(assetSavedMessage(activeType));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "资产保存失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveVideoAnalysisAsset() {
    const type = activeType;
    const entryMode = assetForm.entryMode === "manual" ? "manual" : "video";
    const formName = assetForm.name.trim();
    const llmKeyId = assetForm.llmKeyId;
    const modelId = assetForm.modelId || defaultVideoAnalysisModel;
    const selectedLlmKey = apiKeys.find((key) => key.id === llmKeyId) || null;
    const isYoutubeSource = youtubeVideoAnalysisAssetTypes.has(type) && assetForm.videoSourceMode === "youtube";
    const enteredYoutubeUrl = String(assetForm.youtubeUrl || "").trim();
    const youtubeUrl = normalizeYoutubeVideoUrl(enteredYoutubeUrl);
    const imageKeyId = assetForm.imageKeyId || "";
    const imageModelId = assetForm.imageModelId || defaultRoleImageModel;
    const generateRoleImages = type === "role" && Boolean(assetForm.generateRoleImages);
    const roleImageDesignCount = clampRoleImageDesignCount(assetForm.roleImageDesignCount || 1);
    const roleImageType = normalizeRoleImageType(assetForm.roleImageType);
    const roleImageCustomPrompt = String(assetForm.roleImageCustomPrompt || "").trim();
    const roleCountMode = assetForm.roleCountMode === "custom" ? "custom" : "auto";
    const roleCount = Math.max(1, Math.min(20, Number(assetForm.roleCount || 1)));
    const targetDurationMode = type === "script" && assetForm.targetDurationMode === "custom" ? "custom" : "source";
    const sourceDurationSeconds = Number(assetForm.videoDurationSeconds || assetForm.sourceFile?.durationSeconds || 0);
    const requestedTargetDurationSeconds = Math.max(0, Math.round(Number(assetForm.targetDurationSeconds || 0)));
    const targetDurationSeconds = targetDurationMode === "custom"
      ? requestedTargetDurationSeconds
      : sourceDurationSeconds;
    const selectedFile = Array.isArray(assetForm.files) ? assetForm.files[0] : null;
    const file = isYoutubeSource ? null : selectedFile;
    const canInferNameFromVideo = entryMode === "video" && videoAnalysisAssetTypes.has(type) && file;
    const name = formName || (canInferNameFromVideo ? stripExtension(file.name || "") : "");
    const hasValidSavedAnalysis = Boolean(assetForm.prompt && !isMissingVideoAnalysisResponse(assetForm.prompt));
    if (isVideoExtractedTechniqueAssetForm(type, assetForm)) {
      await handleSaveTechniqueAssetBasics(type, name);
      return;
    }
    if (entryMode === "manual" && (type === "hook" || type === "element")) {
      await handleSaveTechniqueAssetManually(type);
      return;
    }
    if (!name) {
      const nameError = videoAnalysisAssetNameRequiredMessage(type);
      setAssetForm((current) => ({ ...current, nameError }));
      setLoadState("error");
      setMessage(nameError);
      return;
    }
    if (type === "script" && assetForm.id && !file && !isYoutubeSource) {
      await handleSaveScriptAssetBasics(name);
      return;
    }
    if (!llmKeyId) {
      setLoadState("error");
      setMessage("请选择用于视频分析的 LLM 渠道。");
      return;
    }
    if (!videoAnalysisModelsForApiKey(selectedLlmKey).some(model => model.id === modelId)) {
      setLoadState("error");
      setMessage("请选择管理员已启用视频分析能力的模型。");
      return;
    }
    if (isYoutubeSource && !enteredYoutubeUrl) {
      setLoadState("error");
      setMessage("请填写 YouTube 视频链接。");
      return;
    }
    if (isYoutubeSource && !youtubeUrl) {
      setLoadState("error");
      setMessage("请输入有效的公开 YouTube 视频链接，支持 watch、youtu.be、Shorts 和 Live 地址。");
      return;
    }
    if (type === "role" && generateRoleImages && !imageKeyId) {
      setLoadState("error");
      setMessage("请选择用于角色图生成的绘画渠道。");
      return;
    }
    if (!file && !isYoutubeSource && !hasValidSavedAnalysis) {
      setLoadState("error");
      setMessage(videoAnalysisUploadRequiredMessage(activeType));
      return;
    }
    if (file && file.size > videoAnalysisMaxBytes) {
      setLoadState("error");
      setMessage("请上传 20M 以内的视频。");
      return;
    }
    if (type === "script" && targetDurationMode === "custom" && targetDurationSeconds < 30) {
      setLoadState("error");
      setMessage("请填写至少 30 秒的目标脚本时长。");
      return;
    }

    const now = new Date().toISOString();
    const id = assetForm.id || crypto.randomUUID();
    const isNewAsset = !assetForm.id;
    let uploaded = null;
    let videoDataUrl = "";
    setBusyAction("save-asset");
    setLoadState("loading");
    setMessage(isYoutubeSource ? "正在添加 YouTube 视频..." : file ? "正在上传视频..." : "正在保存资产...");
    try {
      if (file) {
        if (type !== "script") {
          setMessage("正在读取视频...");
          videoDataUrl = await readFileAsDataUrl(file);
          if (!videoDataUrl) throw new Error("视频读取失败，请重新选择视频。");
        }
        setMessage("正在上传视频...");
        const uploadResult = await uploadAssetFiles([file]);
        uploaded = normalizeUploadedFile(Array.isArray(uploadResult.files) ? uploadResult.files[0] : null);
        const videoUrl = resolveFlowStudioFileUrl(uploaded?.url || "");
        if (!videoUrl) throw new Error("视频已上传，但没有返回可用于分析的文件地址。");
      }

      const sourceFile = uploaded
        ? {
          name: uploaded.originalName || file?.name || "",
          fileUrl: uploaded.url || "",
          fileKey: uploaded.key || "",
          mimeType: normalizeVideoMimeType(uploaded.mimeType || file?.type, [uploaded.originalName, file?.name, uploaded.url, uploaded.key]),
          sizeBytes: Number(uploaded.sizeBytes || file?.size || 0),
          durationSeconds: Number(assetForm.videoDurationSeconds || assetForm.sourceFile?.durationSeconds || 0),
        }
        : isYoutubeSource
          ? {
            name: name || "YouTube 视频",
            fileUrl: youtubeUrl,
            fileKey: "",
            mimeType: "video/*",
            sizeBytes: 0,
            durationSeconds: 0,
            sourceType: "youtube",
            sourceUrl: youtubeUrl,
          }
          : assetForm.sourceFile || null;
      const shouldAnalyze = Boolean((file || isYoutubeSource) && sourceFile?.fileUrl);
      const analysisTimeoutMs = shouldAnalyze
        ? videoAnalysisTotalTimeoutMs({
          type,
          sourceDurationSeconds: sourceFile?.durationSeconds || sourceDurationSeconds,
          targetDurationSeconds,
        })
        : Number(assetForm.analysisTimeoutMs || 0);
      const payload = {
        type,
        id,
        groupId: canManageGroups ? assetForm.groupId : "",
        name,
        desc: shouldAnalyze ? "视频提取中" : assetForm.desc || "已完成视频提取",
        tag: "",
        prompt: shouldAnalyze ? "" : hasValidSavedAnalysis ? assetForm.prompt : "",
        entryMode,
        videoSourceMode: isYoutubeSource ? "youtube" : "upload",
        youtubeUrl: isYoutubeSource ? youtubeUrl : "",
        analysisStatus: shouldAnalyze ? "running" : assetForm.analysisStatus || "done",
        analysisError: "",
        analysisRetryCount: 0,
        analysisMaxAttempts: shouldAnalyze ? videoAnalysisRetryAttempts(type) : Number(assetForm.analysisMaxAttempts || 0),
        analysisMaxRetries: shouldAnalyze ? Math.max(0, videoAnalysisRetryAttempts(type) - 1) : Number(assetForm.analysisMaxRetries || 0),
        analysisRetryMessage: "",
        analysisStartedAt: shouldAnalyze ? now : assetForm.analysisStartedAt || "",
        analysisTimeoutMs,
        analysisModelId: modelId,
        llmKeyId,
        generateRoleImages,
        roleImageDesignCount,
        roleImageType,
        roleImageCustomPrompt,
        imageKeyId,
        imageModelId,
        imageRatio: assetForm.imageRatio || "1:1",
        imageResolution: assetForm.imageResolution || "1k",
        imageFormat: assetForm.imageFormat || "png",
        roleCountMode,
        roleCount,
        targetDurationMode,
        targetDurationSeconds,
        durationSeconds: type === "script" ? targetDurationSeconds : undefined,
        sourceFile,
        createdAt: assetForm.id ? assetForm.createdAt : now,
        updatedAt: now,
      };
      const teamShareFields = assetTeamShareFields(assetForm, teamContext);
      await saveAsset(activeType, {
        id,
        name,
        groupId: canManageGroups ? assetForm.groupId : "",
        fileUrl: sourceFile?.fileUrl || "",
        fileKey: sourceFile?.fileKey || "",
        mimeType: sourceFile?.mimeType || "",
        sizeBytes: sourceFile?.sizeBytes || 0,
        createdAt: payload.createdAt,
        ...teamShareFields,
        payload,
      });
      setAssetForm(emptyAssetForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      if (canManageGroups) setSelectedGroupId(payload.groupId || ungroupedAssetGroupId(activeType));
      setLoadState("ready");
      setMessage(shouldAnalyze
        ? isYoutubeSource ? "YouTube 视频已添加，正在后台提取。" : "视频已上传，正在后台提取。"
        : "资产已保存。");
      if (shouldAnalyze) {
        runVideoAnalysisInBackground({
          type,
          id,
          name,
          groupId: payload.groupId,
          llmKeyId,
          modelId,
          imageKeyId,
          imageModelId,
          generateRoleImages: payload.generateRoleImages,
          roleImageDesignCount: payload.roleImageDesignCount,
          roleImageType: payload.roleImageType,
          roleImageCustomPrompt: payload.roleImageCustomPrompt,
          imageRatio: payload.imageRatio,
          imageResolution: payload.imageResolution,
          imageFormat: payload.imageFormat,
          roleCountMode: payload.roleCountMode,
          roleCount: payload.roleCount,
          targetDurationMode: payload.targetDurationMode,
          targetDurationSeconds: payload.targetDurationSeconds,
          entryMode,
          sourceFile,
          videoDataUrl,
          isNewAsset,
          createdAt: payload.createdAt,
          analysisStartedAt: payload.analysisStartedAt,
          analysisTimeoutMs: payload.analysisTimeoutMs,
          teamShareFields,
        });
      }
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || (isYoutubeSource ? "YouTube 视频提交失败，请重试。" : "视频上传失败，请重试。"));
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveScriptAssetBasics(name) {
    const now = new Date().toISOString();
    const id = assetForm.id;
    const groupId = canManageGroups ? assetForm.groupId : "";
    const {
      files: _files,
      fileError: _fileError,
      videoDurationSeconds: _videoDurationSeconds,
      ...storedAssetForm
    } = assetForm;
    const sourceFile = storedAssetForm.sourceFile || (storedAssetForm.fileUrl ? {
      name: storedAssetForm.name || "已上传视频",
      fileUrl: storedAssetForm.fileUrl,
      fileKey: storedAssetForm.fileKey || "",
      mimeType: storedAssetForm.mimeType || "",
      sizeBytes: storedAssetForm.sizeBytes || 0,
      durationSeconds: storedAssetForm.durationSeconds || 0,
    } : null);
    const payload = {
      ...storedAssetForm,
      type: "script",
      id,
      name,
      groupId,
      sourceFile,
      updatedAt: now,
    };
    setBusyAction("save-asset");
    setLoadState("loading");
    setMessage("正在保存脚本资产...");
    try {
      await saveAsset("script", {
        id,
        name,
        groupId,
        fileUrl: sourceFile?.fileUrl || storedAssetForm.fileUrl || "",
        fileKey: sourceFile?.fileKey || storedAssetForm.fileKey || "",
        mimeType: sourceFile?.mimeType || storedAssetForm.mimeType || "",
        sizeBytes: sourceFile?.sizeBytes || storedAssetForm.sizeBytes || 0,
        createdAt: storedAssetForm.createdAt,
        ...assetTeamShareFields(assetForm, teamContext),
        payload,
      });
      setAssetForm(emptyAssetForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      if (canManageGroups) setSelectedGroupId(groupId || ungroupedAssetGroupId("script"));
      setLoadState("ready");
      setMessage("脚本资产已保存。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "脚本资产保存失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveTechniqueAssetManually(type) {
    const name = assetForm.name.trim();
    const prompt = assetForm.prompt.trim();
    if (!name) {
      setLoadState("error");
      setMessage("请填写资产名称。");
      return;
    }
    if (!prompt) {
      setLoadState("error");
      setMessage(type === "hook" ? "请填写爆款开头的可复用内容。" : "请填写爆款元素的可复用内容。");
      return;
    }
    const now = new Date().toISOString();
    const id = assetForm.id || crypto.randomUUID();
    const payload = {
      ...assetForm,
      id,
      name,
      groupId: canManageGroups ? assetForm.groupId : "",
      desc: assetForm.desc.trim(),
      prompt,
      tag: assetForm.tag.trim(),
      entryMode: "manual",
      analysisStatus: "done",
      analysisError: "",
      createdAt: assetForm.id ? assetForm.createdAt : now,
      updatedAt: now,
    };

    setBusyAction("save-asset");
    setLoadState("loading");
    setMessage(assetForm.id ? "正在保存资产..." : "正在创建资产...");
    try {
      await saveAsset(type, {
        id,
        name,
        groupId: payload.groupId,
        createdAt: payload.createdAt,
        ...assetTeamShareFields(assetForm, teamContext),
        payload,
      });
      setAssetForm(emptyAssetForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      if (canManageGroups) setSelectedGroupId(payload.groupId || ungroupedAssetGroupId(type));
      setLoadState("ready");
      setMessage(assetSavedMessage(type));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "资产保存失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveTechniqueAssetBasics(type, name) {
    if (!name) {
      setLoadState("error");
      setMessage("请填写资产名称。");
      return;
    }

    const now = new Date().toISOString();
    const id = assetForm.id;
    const groupId = canManageGroups ? assetForm.groupId : "";
    const {
      files: _files,
      fileError: _fileError,
      videoDurationSeconds: _videoDurationSeconds,
      ...storedAssetForm
    } = assetForm;
    const sourceFile = storedAssetForm.sourceFile || (storedAssetForm.fileUrl ? {
      name: storedAssetForm.name || "已上传视频",
      fileUrl: storedAssetForm.fileUrl,
      fileKey: storedAssetForm.fileKey || "",
      mimeType: storedAssetForm.mimeType || "",
      sizeBytes: storedAssetForm.sizeBytes || 0,
      durationSeconds: storedAssetForm.durationSeconds || 0,
    } : null);
    const payload = {
      ...storedAssetForm,
      type,
      id,
      name,
      groupId,
      entryMode: "video",
      sourceFile,
      updatedAt: now,
    };

    setBusyAction("save-asset");
    setLoadState("loading");
    setMessage(type === "hook" ? "正在保存爆款开头..." : "正在保存爆款元素...");
    try {
      await saveAsset(type, {
        id,
        name,
        groupId,
        fileUrl: sourceFile?.fileUrl || storedAssetForm.fileUrl || "",
        fileKey: sourceFile?.fileKey || storedAssetForm.fileKey || "",
        mimeType: sourceFile?.mimeType || storedAssetForm.mimeType || "",
        sizeBytes: sourceFile?.sizeBytes || storedAssetForm.sizeBytes || 0,
        createdAt: storedAssetForm.createdAt,
        ...assetTeamShareFields(assetForm, teamContext),
        payload,
      });
      setAssetForm(emptyAssetForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      if (canManageGroups) setSelectedGroupId(groupId || ungroupedAssetGroupId(type));
      setLoadState("ready");
      setMessage(type === "hook" ? "爆款开头已保存。" : "爆款元素已保存。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "资产保存失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function runVideoAnalysisInBackground({ type, id, name, groupId, llmKeyId, modelId, generateRoleImages = false, roleImageDesignCount = 1, roleImageType = defaultRoleImageType, roleImageCustomPrompt = "", imageKeyId = "", imageModelId = "", imageRatio = "1:1", imageResolution = "1k", imageFormat = "png", roleCountMode = "auto", roleCount = 1, targetDurationMode = "source", targetDurationSeconds = 0, sourceFile, videoDataUrl = "", isNewAsset = false, createdAt, analysisStartedAt = "", analysisTimeoutMs = 0, teamShareFields = {} }) {
    try {
      const videoUrl = resolveFlowStudioFileUrl(sourceFile?.fileUrl || "");
      if (!videoUrl) throw new Error("视频文件地址为空，无法分析。");
      const sourceYoutubeUrl = normalizeYoutubeVideoUrl(sourceFile?.sourceUrl || videoUrl);
      const videoSourceMode = sourceYoutubeUrl ? "youtube" : "upload";
      if (type === "script") {
        await queueScriptAssetVideoAnalysis({
          assetId: id,
          name,
          groupId,
          llmKeyId,
          modelId,
          roleCountMode,
          roleCount,
          targetDurationMode,
          targetDurationSeconds,
          sourceFile,
          createdAt,
          analysisStartedAt,
          analysisTimeoutMs,
        });
        await loadAllAssets();
        setLoadState("ready");
        setMessage("脚本视频提取已进入后端队列，完成后会更新资产状态。");
        return;
      }
      const videoContentUrl = videoDataUrl || videoUrl;
      const markRetrying = async ({ retryCount = 0, maxAttempts = videoAnalysisRetryAttempts(type), error = null } = {}) => {
        const now = new Date().toISOString();
        await saveAsset(type, {
          id,
          name,
          groupId,
          fileUrl: sourceFile?.fileUrl || "",
          fileKey: sourceFile?.fileKey || "",
          mimeType: sourceFile?.mimeType || "",
          sizeBytes: sourceFile?.sizeBytes || 0,
          createdAt,
          ...teamShareFields,
          payload: {
            type,
            id,
            groupId,
            name,
            desc: `视频提取中 · 重试第 ${retryCount} 次`,
            tag: "",
            prompt: "",
            analysisStatus: "running",
            analysisError: "",
            analysisRetryCount: retryCount,
            analysisMaxAttempts: maxAttempts,
            analysisMaxRetries: Math.max(0, maxAttempts - 1),
            analysisRetryMessage: error?.message || "模型服务临时繁忙，正在自动重试。",
            analysisModelId: modelId,
            llmKeyId,
            entryMode: "video",
            videoSourceMode,
            youtubeUrl: sourceYoutubeUrl,
            generateRoleImages,
            roleImageDesignCount: clampRoleImageDesignCount(roleImageDesignCount),
            roleImageType: normalizeRoleImageType(roleImageType),
            roleImageCustomPrompt: String(roleImageCustomPrompt || "").trim(),
            imageKeyId,
            imageModelId,
            imageRatio,
            imageResolution,
            imageFormat,
            roleCountMode,
            roleCount,
            targetDurationMode,
            targetDurationSeconds,
            durationSeconds: type === "script" ? targetDurationSeconds : undefined,
            analysisStartedAt: analysisStartedAt || createdAt,
            analysisTimeoutMs,
            sourceFile,
            createdAt,
            updatedAt: now,
          },
        });
        await loadAllAssets().catch(() => {});
        setMessage(`视频提取遇到临时错误，正在重试第 ${retryCount} 次。`);
      };
      const analysisResult = await analyzeVideoAssetText({
        type,
        llmKeyId,
        modelId,
        videoContentUrl,
        sourceFile,
        roleCountMode,
        roleCount,
        targetDurationMode,
        targetDurationSeconds,
        onRetry: markRetrying,
      });
      const analysis = typeof analysisResult === "string" ? analysisResult : String(analysisResult?.text || "").trim();
      const rawAnalysis = typeof analysisResult === "string" ? "" : String(analysisResult?.rawText || "").trim();
      const scriptProfile = type === "script"
        ? analysisResult?.profile || normalizeScriptStructureProfile(rawAnalysis || analysis, {
          sourceFile,
          roleCountMode,
          roleCount,
          targetDurationMode,
          targetDurationSeconds,
        })
        : null;
      if (!analysis) throw new Error("模型没有返回可保存的分析结果。");
      if (isMissingVideoAnalysisResponse(analysis)) {
        throw new Error("视频分析失败：模型没有收到可解析的视频，请确认 LLM 渠道支持视频输入后重试。");
      }
      const productProfile = type === "product" ? productProfileFromAnalysis(analysis, name) : null;
      const roleProfiles = type === "role" ? roleCharactersFromAnalysis(analysis).filter(isValidRoleProfile) : [];
      const techniqueItems = ["hook", "element"].includes(type) ? techniqueItemsFromAnalysis(type, analysis, name) : [];
      if (type === "role" && !roleProfiles.length) {
        throw new Error("角色视频解析失败：模型没有返回有效的“角色列表 / 角色名字 / 角色定义 / 角色绘画提示词”，请确认视频里有人物并重新分析。");
      }
      if (["hook", "element"].includes(type) && !techniqueItems.length) {
        throw new Error(type === "hook" ? "爆款开头解析失败：模型没有返回有效的“爆款开头列表”。" : "爆款元素解析失败：模型没有返回有效的“爆款元素列表”。");
      }
      let roleImageGenerationPayload = null;
      let roleProfilesWithImages = [];
      if (type === "role") {
        const normalizedRoleProfiles = roleProfiles.map((profile, index) => normalizeRoleProfileFields(profile, `角色${index + 1}`));
        roleProfilesWithImages = generateRoleImages
          ? normalizedRoleProfiles.map((profile) => {
            const placeholders = roleImagePlaceholderItems(profile, {
              count: roleImageDesignCount,
              roleImageType,
              roleImageCustomPrompt,
              imageKeyId,
              imageModelId,
              imageRatio,
              imageResolution,
              imageFormat,
            });
            return normalizeRoleProfileFields({
              ...profile,
              roleImages: placeholders,
              defaultImageId: placeholders[0]?.id || "",
            }, profile.name);
          })
          : normalizedRoleProfiles;
        if (generateRoleImages) {
          roleImageGenerationPayload = {
            assetId: id,
            imageKeyId,
            imageModelId,
            imageRatio,
            imageResolution,
            imageFormat,
            roleImageDesignCount,
            roleImageType,
            roleImageCustomPrompt,
          };
        }
      }
      const roleProfile = roleProfilesWithImages[0] || null;
      const finalSourceDurationSeconds = Number(sourceFile?.durationSeconds || 0);
      const finalTargetDurationSeconds = type === "script"
        ? Math.max(0, Math.round(Number(targetDurationSeconds || finalSourceDurationSeconds || 0)))
        : 0;
      const now = new Date().toISOString();
      if (["hook", "element"].includes(type)) {
        await Promise.all(techniqueItems.map((item, index) => {
          const assetId = index === 0 ? id : crypto.randomUUID();
          const assetName = item.name || `${name} ${String(index + 1).padStart(2, "0")}`;
          return saveAsset(type, {
            id: assetId,
            name: assetName,
            groupId,
            fileUrl: sourceFile?.fileUrl || "",
            fileKey: sourceFile?.fileKey || "",
            mimeType: sourceFile?.mimeType || "",
            sizeBytes: sourceFile?.sizeBytes || 0,
            createdAt: index === 0 ? createdAt : now,
            ...teamShareFields,
            payload: {
              type,
              id: assetId,
              groupId,
              name: assetName,
              desc: item.desc || (type === "hook" ? "已提取爆款开头技巧" : "已提取爆款元素"),
              tag: item.tag || "",
              prompt: item.prompt || analysis,
              rawAnalysis: analysis,
              entryMode: "video",
              videoSourceMode,
              youtubeUrl: sourceYoutubeUrl,
              sourceFile,
              sourceVideoName: sourceFile?.name || "",
              sourceTechniqueIndex: index + 1,
              analysisStatus: "done",
              analysisError: "",
              analysisRetryCount: 0,
              analysisMaxAttempts: videoAnalysisRetryAttempts(type),
              analysisMaxRetries: Math.max(0, videoAnalysisRetryAttempts(type) - 1),
              analysisRetryMessage: "",
              analysisStartedAt: analysisStartedAt || createdAt,
              analysisTimeoutMs,
              analysisModelId: modelId,
              llmKeyId,
              createdAt: index === 0 ? createdAt : now,
              updatedAt: now,
            },
          });
        }));
        await loadAllAssets();
        setLoadState("ready");
        setMessage(type === "hook" ? `爆款开头提取完成，已生成 ${techniqueItems.length} 个开头资产。` : `爆款元素提取完成，已生成 ${techniqueItems.length} 个元素资产。`);
        return;
      }
      const generatedImageItems = roleProfilesWithImages.flatMap((profile) => (
        Array.isArray(profile.roleImages) ? profile.roleImages.filter((image) => image.source !== "manual") : []
      ));
      const finalPayload = {
        type,
        id,
        groupId,
        name,
        desc: type === "script" && finalTargetDurationSeconds
          ? `脚本资产 · 原时长 ${formatVideoDuration(finalSourceDurationSeconds)} · 目标时长 ${formatVideoDuration(finalTargetDurationSeconds)}`
          : roleProfilesWithImages.length ? `已提取 ${roleProfilesWithImages.length} 个角色` : roleProfile ? roleProfile.traits || "已完成角色提取" : "已完成视频提取",
        tag: "",
        prompt: productProfile ? buildProductAnalysisText(productProfile) : roleProfilesWithImages.length ? buildRoleProfilesAnalysisText(roleProfilesWithImages) : roleProfile ? buildRoleAnalysisText(roleProfile) : analysis,
        rawAnalysis: type === "script" ? rawAnalysis && rawAnalysis !== analysis ? rawAnalysis : "" : productProfile || roleProfile ? analysis : "",
        scriptProfile: scriptProfile || undefined,
        sourceShotCount: scriptProfile?.sourceShotCount || undefined,
        targetShotCount: scriptProfile?.targetShotCount || undefined,
        estimatedShotCount: scriptProfile?.estimatedShotCount || undefined,
        productProfile: productProfile || undefined,
        roleProfile: roleProfile || undefined,
        roleCharacters: roleProfilesWithImages.length ? roleProfilesWithImages : undefined,
        analysisStatus: "done",
        analysisError: "",
        analysisRetryCount: 0,
        analysisMaxAttempts: videoAnalysisRetryAttempts(type),
        analysisMaxRetries: Math.max(0, videoAnalysisRetryAttempts(type) - 1),
        analysisRetryMessage: "",
        analysisModelId: modelId,
        llmKeyId,
        entryMode: "video",
        videoSourceMode,
        youtubeUrl: sourceYoutubeUrl,
        generateRoleImages,
        roleImageDesignCount: clampRoleImageDesignCount(roleImageDesignCount),
        roleImageType: normalizeRoleImageType(roleImageType),
        roleImageCustomPrompt: String(roleImageCustomPrompt || "").trim(),
        imageKeyId,
        imageModelId,
        imageRatio,
        imageResolution,
        imageFormat,
        imageGenerationStatus: roleImageGenerationPayload ? "running" : "",
        imageGenerationError: "",
        imageGenerationStartedAt: roleImageGenerationPayload ? now : "",
        imageGenerationCompletedAt: "",
        imageGenerationTotal: generatedImageItems.length,
        imageGenerationCompleted: generatedImageItems.filter((image) => image.imageUrl).length,
        imageGenerationFailed: generatedImageItems.filter((image) => image.imageError && !image.imageUrl).length,
        roleCountMode,
        roleCount,
        targetDurationMode,
        targetDurationSeconds: finalTargetDurationSeconds || undefined,
        durationSeconds: type === "script" ? finalTargetDurationSeconds : undefined,
        analysisStartedAt: analysisStartedAt || createdAt,
        analysisTimeoutMs,
        sourceFile,
        createdAt,
        updatedAt: now,
      };
      await saveAsset(type, {
        id,
        name,
        groupId,
        fileUrl: sourceFile?.fileUrl || "",
        fileKey: sourceFile?.fileKey || "",
        mimeType: sourceFile?.mimeType || "",
        sizeBytes: sourceFile?.sizeBytes || 0,
        createdAt,
        ...teamShareFields,
        payload: finalPayload,
      });
      let roleImageQueueFailed = null;
      if (roleImageGenerationPayload) {
        try {
          await queueRoleAssetImageGeneration(roleImageGenerationPayload);
        } catch (error) {
          roleImageQueueFailed = error;
          await saveAsset("role", {
            id,
            name,
            groupId,
            fileUrl: sourceFile?.fileUrl || "",
            fileKey: sourceFile?.fileKey || "",
            mimeType: sourceFile?.mimeType || "",
            sizeBytes: sourceFile?.sizeBytes || 0,
            createdAt,
            ...teamShareFields,
            payload: {
              ...finalPayload,
              desc: `已提取 ${roleProfilesWithImages.length} 个角色`,
              imageGenerationStatus: "error",
              imageGenerationError: error.message || "角色图任务提交失败。",
              imageGenerationCompletedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }).catch(() => {});
        }
      }
      await loadAllAssets();
      setLoadState(roleImageQueueFailed ? "warning" : "ready");
      setMessage(type === "script"
        ? "脚本视频提取完成。"
        : type === "role"
          ? roleImageQueueFailed
            ? "角色视频提取完成，但角色图任务提交失败。"
            : roleImageGenerationPayload
              ? "角色视频提取完成，角色图已进入后台生成。"
              : "角色视频提取完成。"
          : "产品视频提取完成。");
    } catch (error) {
      if (isNewAsset && !isAmbiguousVideoAnalysisError(error)) {
        await deleteAsset(type, id).catch(() => {});
        await loadAllAssets().catch(() => {});
        setLoadState("error");
        setMessage(error.message || "视频提取失败，请重新上传。");
        return;
      }
      const now = new Date().toISOString();
      await saveAsset(type, {
        id,
        name,
        groupId,
        fileUrl: sourceFile?.fileUrl || "",
        fileKey: sourceFile?.fileKey || "",
        mimeType: sourceFile?.mimeType || "",
        sizeBytes: sourceFile?.sizeBytes || 0,
        createdAt,
        ...teamShareFields,
        payload: {
          type,
          id,
          groupId,
          name,
          desc: "视频提取失败",
          tag: "",
          prompt: "",
          analysisStatus: "error",
          analysisError: error.message || "视频提取失败，请重新上传。",
          analysisRetryCount: Math.max(0, videoAnalysisRetryAttempts(type) - 1),
          analysisMaxAttempts: videoAnalysisRetryAttempts(type),
          analysisMaxRetries: Math.max(0, videoAnalysisRetryAttempts(type) - 1),
          analysisRetryMessage: error.message || "视频提取失败，请重新上传。",
          analysisModelId: modelId,
          llmKeyId,
          entryMode: "video",
          videoSourceMode,
          youtubeUrl: sourceYoutubeUrl,
          generateRoleImages,
          roleImageDesignCount: clampRoleImageDesignCount(roleImageDesignCount),
          roleImageType: normalizeRoleImageType(roleImageType),
          roleImageCustomPrompt: String(roleImageCustomPrompt || "").trim(),
          imageKeyId,
          imageModelId,
          imageRatio,
          imageResolution,
          imageFormat,
          roleCountMode,
          roleCount,
          targetDurationMode,
          targetDurationSeconds,
          durationSeconds: type === "script" ? targetDurationSeconds : undefined,
          analysisStartedAt: analysisStartedAt || createdAt,
          analysisTimeoutMs,
          sourceFile,
          createdAt,
          updatedAt: now,
        },
      }).catch(() => {});
      await loadAllAssets().catch(() => {});
      setLoadState("error");
      setMessage(error.message || "视频提取失败，请重新上传。");
    }
  }

  async function handleSaveProductProfile(fields) {
    const profile = normalizeProductProfileFields(fields, assetForm.name || "");
    const productName = profile.productName && profile.productName !== "视频未提及" ? profile.productName : "";
    if (!productName) {
      setLoadState("error");
      setMessage("请填写产品名称。");
      return { ok: false, message: "请填写产品名称。" };
    }
    const now = new Date().toISOString();
    const id = assetForm.id || crypto.randomUUID();
    const prompt = buildProductAnalysisText(profile);
    setBusyAction("save-asset");
    setLoadState("loading");
    setMessage("正在保存产品资料...");
    try {
      await saveAsset("product", {
        id,
        name: productName,
        groupId: canManageGroups ? assetForm.groupId : "",
        fileUrl: assetForm.sourceFile?.fileUrl || assetForm.fileUrl || "",
        fileKey: assetForm.sourceFile?.fileKey || assetForm.fileKey || "",
        mimeType: assetForm.sourceFile?.mimeType || assetForm.mimeType || "",
        sizeBytes: assetForm.sourceFile?.sizeBytes || assetForm.sizeBytes || 0,
        createdAt: assetForm.createdAt || now,
        ...assetTeamShareFields(assetForm, teamContext),
        payload: {
          ...assetForm,
          id,
          name: productName,
          groupId: canManageGroups ? assetForm.groupId : "",
          desc: assetForm.entryMode === "manual" ? "手动录入产品资料" : "已完成视频提取",
          prompt,
          productProfile: profile,
          productImageUrl: profile.productImageUrl,
          productImageThumbnailUrl: profile.productImageThumbnailUrl,
          productImageKey: profile.productImageKey,
          productImageName: profile.productImageName,
          productImageMimeType: profile.productImageMimeType,
          productImageSizeBytes: profile.productImageSizeBytes,
          rawAnalysis: assetForm.rawAnalysis || assetForm.prompt || "",
          entryMode: assetForm.entryMode || "video",
          analysisStatus: "done",
          analysisError: "",
          createdAt: assetForm.createdAt || now,
          updatedAt: now,
        },
      });
      setAssetForm(emptyAssetForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      setLoadState("ready");
      setMessage("产品资料已保存。");
      return { ok: true };
    } catch (error) {
      const message = error.message || "产品资料保存失败。";
      setLoadState("error");
      setMessage(message);
      return { ok: false, message };
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveRoleProfile(fields, imageSettings = {}) {
    const profiles = (Array.isArray(fields) ? fields : [fields])
      .map((item, index) => normalizeRoleProfileFields(item, `角色${index + 1}`))
      .filter(isSavableRoleProfile);
    const profile = profiles[0] || null;
    const assetName = assetForm.name || profile?.name || "角色资产";
    const now = new Date().toISOString();
    const prompt = buildRoleProfilesAnalysisText(profiles);
    const imageProgress = roleImageProgressFromProfiles(profiles);
    const imageGenerationStatus = roleImageGenerationStatusFromProgress(assetForm.imageGenerationStatus, imageProgress);
    setBusyAction("save-asset");
    setLoadState("loading");
    setMessage("正在保存角色资料...");
    try {
      await saveAsset("role", {
        id: assetForm.id,
        name: assetName,
        groupId: canManageGroups ? assetForm.groupId : "",
        fileUrl: assetForm.sourceFile?.fileUrl || assetForm.fileUrl || "",
        fileKey: assetForm.sourceFile?.fileKey || assetForm.fileKey || "",
        mimeType: assetForm.sourceFile?.mimeType || assetForm.mimeType || "",
        sizeBytes: assetForm.sourceFile?.sizeBytes || assetForm.sizeBytes || 0,
        createdAt: assetForm.createdAt,
        ...assetTeamShareFields(assetForm, teamContext),
        payload: {
          ...assetForm,
          name: assetName,
          groupId: canManageGroups ? assetForm.groupId : "",
          desc: profiles.length ? `已提取 ${profiles.length} 个角色` : "暂无角色",
          prompt,
          roleProfile: profile,
          roleCharacters: profiles,
          rawAnalysis: assetForm.rawAnalysis || assetForm.prompt || "",
          imageKeyId: imageSettings.imageKeyId || assetForm.imageKeyId || "",
          imageModelId: imageSettings.imageModelId || assetForm.imageModelId || "",
          imageRatio: imageSettings.imageRatio || assetForm.imageRatio || "1:1",
          imageResolution: imageSettings.imageResolution || assetForm.imageResolution || "1k",
          imageFormat: imageSettings.imageFormat || assetForm.imageFormat || "png",
          imageGenerationStatus,
          imageGenerationError: imageGenerationStatus === "error" || imageGenerationStatus === "partial" ? assetForm.imageGenerationError || "" : "",
          imageGenerationCompletedAt: ["done", "partial", "error"].includes(imageGenerationStatus)
            ? assetForm.imageGenerationCompletedAt || now
            : "",
          imageGenerationTotal: imageProgress.total,
          imageGenerationCompleted: imageProgress.completed,
          imageGenerationFailed: imageProgress.failed,
          analysisStatus: "done",
          analysisError: "",
          updatedAt: now,
        },
      });
      setAssetForm(emptyAssetForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      setLoadState("ready");
      setMessage("角色资料已保存。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "角色资料保存失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteAsset(asset) {
    if (!canEditActiveType || asset.system) return;
    const type = activeType;
    setConfirmDialog({
      title: "删除资产",
      summary: `确定删除“${asset.name || "未命名资产"}”吗？删除后无法在当前资产库继续使用。`,
      label: "当前资产",
      target: asset.name || "未命名资产",
      hint: "系统预设不会被删除，自定义资产删除后需要重新创建。",
      confirmText: "确认删除",
      danger: true,
      onConfirm: () => deleteAssetConfirmed(type, asset),
    });
  }

  async function deleteAssetConfirmed(type, asset) {
    setBusyAction(`delete-asset-${asset.id}`);
    setLoadState("loading");
    setMessage("正在删除资产...");
    try {
      await deleteAsset(type, asset.id);
      if (assetForm.id === asset.id) setAssetForm(emptyAssetForm);
      await loadAllAssets();
      setLoadState("ready");
      setMessage("资产已删除。");
      setConfirmDialog(null);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "资产删除失败。");
      showAssetDeleteBlockedDialog(asset, error, "资产");
    } finally {
      setBusyAction("");
    }
  }

  function startEditAsset(asset) {
    if (videoAnalysisAssetTypes.has(activeType)) {
      setAssetForm(createVideoAnalysisAssetForm(asset, apiKeys, selectedGroupId, activeType));
      setLoadState("ready");
      setMessage(`正在编辑“${asset.name}”。`);
      setEditorOpen(true);
      setEditorMode("asset");
      return;
    }
    setAssetForm({
      id: asset.id,
      name: asset.name || "",
      groupId: asset.groupId || "",
      desc: asset.desc || "",
      prompt: asset.prompt || "",
      tag: asset.tag || "",
      shared: Boolean(asset.shared || asset.scope === "team"),
    });
    setLoadState("ready");
    setMessage(`正在编辑“${asset.name}”。`);
    setEditorOpen(true);
    setEditorMode("asset");
  }

  function openEditor() {
    setGroupForm(emptyGroupForm);
    setAssetForm(videoAnalysisAssetTypes.has(activeType) ? createVideoAnalysisAssetForm(null, apiKeys, selectedGroupId, activeType) : emptyAssetForm);
    if (activeType === "writing-style") {
      const writingGroups = Array.isArray(activeData?.groups) ? activeData.groups : [];
      if (!writingGroups.length) {
        setLoadState("error");
        setMessage("请先添加文风分组，再上传样本文档提取文风。");
        openGroupEditor();
        return;
      }
      setWritingStyleExtractForm(createWritingStyleExtractDefaults(writingGroups, selectedGroupId, apiKeys));
      setEditorOpen(true);
      setEditorMode("writing-extract");
      return;
    }
    setEditorOpen(true);
    setEditorMode("asset");
  }

  function openGroupEditor() {
    setGroupForm(emptyGroupForm);
    setAssetForm(emptyAssetForm);
    setWritingStyleExtractForm(emptyWritingStyleExtractForm);
    setEditorOpen(true);
    setEditorMode("group");
  }

  async function handleWritingStyleFiles(files) {
    const selected = Array.from(files || []).filter(isWritingStyleSourceFile);
    if (!selected.length) {
      setWritingStyleExtractForm((current) => ({ ...current, files: [] }));
      setLoadState("error");
      setMessage("请选择 md、txt 或 pdf 样本文档。");
      return;
    }

    setBusyAction("read-writing-files");
    setLoadState("loading");
    setMessage(`正在读取 ${selected.length} 个样本文档...`);
    let uploadedFiles = [];
    try {
      const uploadResult = await uploadAssetFiles(selected);
      uploadedFiles = Array.isArray(uploadResult.files) ? uploadResult.files : [];
    } catch {
      uploadedFiles = [];
    }

    try {
      const pendingFiles = await Promise.all(
        selected.map((file, index) => readWritingStyleSourceFile(file, normalizeUploadedFile(uploadedFiles[index])))
      );
      setWritingStyleExtractForm((current) => ({ ...current, files: pendingFiles }));
      setLoadState("ready");
      setMessage(writingStyleFileSelectionMessage(pendingFiles));
    } catch (error) {
      setWritingStyleExtractForm((current) => ({ ...current, files: [] }));
      setLoadState("error");
      setMessage(error.message || "样本文档读取失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveWritingStyles(event) {
    event.preventDefault();
    const form = writingStyleExtractForm;
    const name = form.name.trim();
    const writingGroups = Array.isArray(activeData?.groups) ? activeData.groups : [];
    const groupId = form.groupId || writingGroups[0]?.id || "";
    const llmKeyId = form.llmKeyId;
    const modelId = form.modelId;
    const files = form.files || [];

    if (!files.length) {
      setLoadState("error");
      setMessage("请先上传用于 AI 分析的文章附件。");
      return;
    }
    if (!groupId) {
      setLoadState("error");
      setMessage("请选择文风保存分组。");
      return;
    }
    if (!llmKeyId || !modelId) {
      setLoadState("error");
      setMessage("请选择 LLM 渠道和分析模型。");
      return;
    }
    const unreadableFile = files.find((file) => !file.text?.trim());
    if (unreadableFile) {
      setLoadState("error");
      setMessage(`“${unreadableFile.name}”暂未读取到正文，无法进行 AI 分析。请换成可读取正文的 md 或 txt 文件。`);
      return;
    }

    setBusyAction("save-writing-style");
    setLoadState("loading");
    setMessage(`正在提交 ${files.length} 个文风分析任务...`);
    try {
      const jobs = [];
      for (const file of files) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const payload = {
          id,
          groupId,
          name: name && files.length === 1 ? name : stripExtension(file.name),
          tag: "AI 分析",
          desc: "文风分析中",
          prompt: "",
          analysisStatus: "running",
          analysisError: "",
          analysisStartedAt: now,
          analysisModelId: modelId,
          llmKeyId,
          sourceFiles: [
            {
              name: file.name,
              type: file.type,
              size: file.size,
              fileUrl: file.fileUrl || "",
              fileKey: file.fileKey || "",
              mimeType: file.mimeType || "",
              sizeBytes: file.sizeBytes || file.size,
              status: file.status,
              text: file.text || "",
            },
          ],
          createdAt: now,
        };
        await saveAsset("writing-style", {
          id,
          groupId,
          name: payload.name,
          createdAt: now,
          ...assetTeamShareFields(form, teamContext),
          payload,
        });
        jobs.push({
          assetId: id,
          name: payload.name,
          groupId,
          llmKeyId,
          modelId,
          sourceFile: payload.sourceFiles[0],
          createdAt: now,
          analysisStartedAt: now,
        });
      }
      setSelectedGroupId(groupId);
      setWritingStyleExtractForm(emptyWritingStyleExtractForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      setLoadState("ready");
      setMessage(`${files.length} 个文风已提交，正在后台分析。`);
      runWritingStyleAnalysisInBackground(jobs);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "文风分析任务提交失败，请重试。");
    } finally {
      setBusyAction("");
    }
  }

  async function runWritingStyleAnalysisInBackground(jobs = []) {
    const results = await Promise.allSettled(jobs.map((job) => queueWritingStyleAnalysis(job)));
    const failedJobs = results
      .map((result, index) => ({ result, job: jobs[index] }))
      .filter(({ result }) => result.status === "rejected");
    if (!failedJobs.length) return;

    const now = new Date().toISOString();
    await Promise.allSettled(failedJobs.map(({ result, job }) => saveAsset("writing-style", {
      id: job.assetId,
      name: job.name,
      groupId: job.groupId,
      createdAt: job.createdAt,
      payload: {
        id: job.assetId,
        groupId: job.groupId,
        name: job.name,
        tag: "AI 分析",
        desc: "文风分析提交失败",
        prompt: "",
        analysisStatus: "error",
        analysisError: result.reason?.message || "后台分析任务提交失败，请重新上传。",
        analysisStartedAt: job.analysisStartedAt,
        analysisModelId: job.modelId,
        llmKeyId: job.llmKeyId,
        sourceFiles: [job.sourceFile],
        createdAt: job.createdAt,
        updatedAt: now,
      },
    })));
    await loadAllAssets().catch(() => {});
    setLoadState("warning");
    setMessage(`${failedJobs.length} 个文风未能进入后台队列，请重新上传。`);
  }

  async function handleUploadImages(library, files) {
    const selected = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
    if (!selected.length) {
      setLoadState("error");
      setMessage("请选择图片文件。");
      return;
    }

    setBusyAction(`upload-images-${library.id}`);
    setLoadState("loading");
    setMessage(`正在上传 ${selected.length} 张图片...`);
    try {
      const result = await uploadAssetFiles(selected);
      const uploadedFiles = Array.isArray(result.files) ? result.files : [];
      for (let index = 0; index < uploadedFiles.length; index += 1) {
        const uploaded = uploadedFiles[index];
        const sourceFile = selected[index];
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const payload = {
          id,
          groupId: library.id,
          name: uploaded.originalName || sourceFile?.name || "未命名图片",
          type: uploaded.mimeType || sourceFile?.type || "image",
          dataUrl: uploaded.url || "",
          fileUrl: uploaded.url || "",
          fileKey: uploaded.key || "",
          thumbnailUrl: uploaded.thumbnailUrl || "",
          thumbnailKey: uploaded.thumbnailKey || "",
          thumbnailMimeType: uploaded.thumbnailMimeType || "",
          thumbnailSizeBytes: Number(uploaded.thumbnailSizeBytes || 0),
          mimeType: uploaded.mimeType || sourceFile?.type || "",
          sizeBytes: Number(uploaded.sizeBytes || sourceFile?.size || 0),
          createdAt: uploaded.createdAt || now,
          storedOnServer: true,
        };
        await saveAsset("image-library", {
          id,
          groupId: library.id,
          name: payload.name,
          fileUrl: payload.fileUrl,
          fileKey: payload.fileKey,
          mimeType: payload.mimeType,
          sizeBytes: payload.sizeBytes,
          createdAt: payload.createdAt,
          payload,
        });
      }
      await loadAllAssets();
      setLoadState("ready");
      setMessage(`${uploadedFiles.length} 张图片已保存到“${library.name}”。`);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "图片上传失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteImage(image) {
    setConfirmDialog({
      title: "删除图片",
      summary: `确定删除“${image.name || "未命名图片"}”吗？删除后无法在图片库继续使用。`,
      label: "当前图片",
      target: image.name || "未命名图片",
      hint: "如果这张图已经被现有工作流引用，系统会阻止删除。",
      confirmText: "确认删除",
      danger: true,
      onConfirm: () => deleteImageConfirmed(image),
    });
  }

  async function deleteImageConfirmed(image) {
    setBusyAction(`delete-image-${image.id}`);
    setLoadState("loading");
    setMessage("正在删除图片...");
    try {
      await deleteAsset("image-library", image.id);
      await loadAllAssets();
      setLoadState("ready");
      setMessage("图片已删除。");
      setConfirmDialog(null);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "图片删除失败。");
      showAssetDeleteBlockedDialog(image, error, "图片");
    } finally {
      setBusyAction("");
    }
  }

  async function handleUploadMusic(group, files) {
    const selected = Array.from(files || []).filter((file) => file.type.startsWith("audio/"));
    if (!selected.length) {
      setLoadState("error");
      setMessage("请选择音频文件。");
      return;
    }

    setBusyAction(`upload-music-${group.id}`);
    setLoadState("loading");
    setMessage(`正在上传 ${selected.length} 个音频...`);
    try {
      const result = await uploadAssetFiles(selected);
      const uploadedFiles = Array.isArray(result.files) ? result.files : [];
      for (let index = 0; index < uploadedFiles.length; index += 1) {
        const uploaded = uploadedFiles[index];
        const sourceFile = selected[index];
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const payload = {
          id,
          groupId: group.id,
          name: uploaded.originalName || sourceFile?.name || "未命名音频",
          type: uploaded.mimeType || sourceFile?.type || "audio",
          dataUrl: uploaded.url || "",
          fileUrl: uploaded.url || "",
          fileKey: uploaded.key || "",
          mimeType: uploaded.mimeType || sourceFile?.type || "",
          sizeBytes: Number(uploaded.sizeBytes || sourceFile?.size || 0),
          createdAt: uploaded.createdAt || now,
          storedOnServer: true,
        };
        await saveAsset("music", {
          id,
          groupId: group.id,
          name: payload.name,
          fileUrl: payload.fileUrl,
          fileKey: payload.fileKey,
          mimeType: payload.mimeType,
          sizeBytes: payload.sizeBytes,
          createdAt: payload.createdAt,
          payload,
        });
      }
      await loadAllAssets();
      setLoadState("ready");
      setMessage(`${uploadedFiles.length} 个音频已保存到“${group.name}”。`);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "音频上传失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteMusic(track) {
    setConfirmDialog({
      title: "删除音频",
      summary: `确定删除“${track.name || "未命名音频"}”吗？删除后无法在音乐库继续使用。`,
      label: "当前音频",
      target: track.name || "未命名音频",
      hint: "如果这段音频已经被现有工作流引用，系统会阻止删除。",
      confirmText: "确认删除",
      danger: true,
      onConfirm: () => deleteMusicConfirmed(track),
    });
  }

  async function deleteMusicConfirmed(track) {
    setBusyAction(`delete-music-${track.id}`);
    setLoadState("loading");
    setMessage("正在删除音频...");
    try {
      await deleteAsset("music", track.id);
      await loadAllAssets();
      setLoadState("ready");
      setMessage("音频已删除。");
      setConfirmDialog(null);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "音频删除失败。");
      showAssetDeleteBlockedDialog(track, error, "音频");
    } finally {
      setBusyAction("");
    }
  }

  function startEditImage(image) {
    setAssetForm(createMediaAssetForm(image));
    setLoadState("ready");
    setMessage(`正在编辑“${image.name || "未命名图片"}”。`);
    setEditorOpen(true);
    setEditorMode("image-asset");
  }

  function startEditMusic(track) {
    setAssetForm(createMediaAssetForm(track));
    setLoadState("ready");
    setMessage(`正在编辑“${track.name || "未命名音频"}”。`);
    setEditorOpen(true);
    setEditorMode("music-asset");
  }

  async function handleSaveMediaAsset(event) {
    event.preventDefault();
    const type = editorMode === "music-asset" ? "music" : "image-library";
    const label = type === "music" ? "音频" : "图片";
    const name = assetForm.name.trim();
    if (!name) {
      setLoadState("error");
      setMessage(`请填写${label}名称。`);
      return;
    }

    const now = new Date().toISOString();
    const id = assetForm.id;
    const groupId = assetForm.groupId || "";
    const existingPayload = assetForm.payload && typeof assetForm.payload === "object" ? assetForm.payload : {};
    const assetFormFields = { ...assetForm };
    delete assetFormFields.payload;
    const payload = {
      ...existingPayload,
      ...assetFormFields,
      id,
      name,
      groupId,
      shared: Boolean(assetForm.shared),
      updatedAt: now,
    };

    setBusyAction(`save-${type}-asset`);
    setLoadState("loading");
    setMessage(`正在保存${label}...`);
    try {
      await saveAsset(type, {
        id,
        name,
        groupId,
        fileUrl: assetForm.fileUrl || "",
        fileKey: assetForm.fileKey || "",
        mimeType: assetForm.mimeType || assetForm.type || "",
        sizeBytes: Number(assetForm.sizeBytes || 0),
        createdAt: assetForm.createdAt,
        ...assetTeamShareFields(assetForm, teamContext),
        payload,
      });
      setAssetForm(emptyAssetForm);
      setEditorOpen(false);
      setEditorMode("");
      await loadAllAssets();
      setLoadState("ready");
      setMessage(`${label}已保存。`);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || `${label}保存失败。`);
    } finally {
      setBusyAction("");
    }
  }

  function showAssetDeleteBlockedDialog(asset, error, label = "资产") {
    const detail = error?.payload?.detail || {};
    if (detail.code !== "ASSET_REFERENCED_BY_WORKFLOW") return;
    const references = Array.isArray(detail.references) ? detail.references : [];
    const workflowNames = references
      .map((workflow) => workflow?.name || "未命名工作流")
      .filter(Boolean)
      .slice(0, 5);
    setConfirmDialog({
      title: `无法删除${label}`,
      summary: error.message || `这个${label}正在被工作流引用，暂时无法删除。`,
      label: `当前${label}`,
      target: asset.name || `未命名${label}`,
      hint: workflowNames.length
        ? `引用工作流：${workflowNames.map((name) => `「${name}」`).join("、")}${references.length > workflowNames.length ? ` 等 ${references.length} 个` : ""}。请先删除引用它的工作流后再删除。`
        : "请先删除引用它的工作流后再删除。",
      confirmText: "知道了",
      noticeOnly: true,
    });
  }

  const isScriptAssetBasicEdit = activeType === "script" && Boolean(assetForm.id);
  const isTechniqueAssetBasicEdit = isVideoExtractedTechniqueAssetForm(activeType, assetForm);
  const isVideoAssetBasicEdit = isScriptAssetBasicEdit || isTechniqueAssetBasicEdit;

  return (
    <div className="assets-dashboard">
      {!activeType ? (
      <section className="assets-overview-panel asset-landing-panel-next">
        <div className="panel-title-row">
          <div>
            <h2>创意资产</h2>
            <p>统一管理图库、图风、文风、脚本、角色和提示词等可复用资产。</p>
          </div>
          <button className={`refresh-action ${loadState}`} type="button" onClick={() => loadAllAssets()}>
            {message}
          </button>
        </div>

        {showInitialLoading ? (
          <PageLoading label="正在读取创意资产" />
        ) : (
          <>
            <div className="asset-menu-grid-next">
              {assetTypes.map((type) => {
                const item = normalized[type.id];
                const count = type.id === "image-library" ? item.groups.length : item.assets.length;
                return (
                  <button className={`asset-menu-card ${type.color}`} type="button" onClick={() => switchAssetType(type.id)} key={type.id}>
                    <span className={`asset-menu-icon ${type.iconClass}`} aria-hidden="true"></span>
                    <strong>{type.label}</strong>
                    <small>{count} 个{type.unit}</small>
                  </button>
                );
              })}
              {futureAssets.map((item) => (
                <button className={`asset-menu-card future ${item.color}`} type="button" onClick={() => setPendingFeature(item)} key={item.id}>
                  <span className={`asset-menu-icon ${item.iconClass}`} aria-hidden="true"></span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </button>
              ))}
            </div>
            {pendingFeature ? (
              <PendingFeatureDialog feature={pendingFeature} onClose={() => setPendingFeature(null)} />
            ) : null}
          </>
        )}
      </section>
      ) : (
      <section className="asset-detail-panel asset-manager-panel-next">
        <div className="asset-manager-head-next">
          <div>
            <h2>{activeDefinition.label}</h2>
            <p>{assetLibraryMeta(activeType)}</p>
          </div>
          <div className="asset-manager-actions-next">
            <button className="secondary-action compact" type="button" onClick={() => switchAssetType("")}>
              返回资产
            </button>
            {canManageGroups ? (
              <button className="secondary-action compact" type="button" onClick={openGroupEditor}>
                {activeType === "image-library" ? "+ 创建图库" : "+ 分组"}
              </button>
            ) : null}
            {canEditActiveType ? (
              <button className="primary-action compact" type="button" onClick={openEditor}>
                {assetActionLabel(activeType)}
              </button>
            ) : null}
          </div>
        </div>

        {editorOpen && editorMode === "group" && canManageGroups ? (
          <AssetEditorDialog
            title={groupDialogTitle(activeType, groupForm.id)}
            onClose={() => {
              setGroupForm(emptyGroupForm);
              setEditorOpen(false);
              setEditorMode("");
            }}
          >
            <MediaGroupCrudPanel
              kind={activeType === "image-library" ? "image" : activeType}
              groupForm={groupForm}
              busyAction={busyAction}
              onGroupFormChange={setGroupForm}
              onSaveGroup={handleSaveGroup}
              onCancelGroup={() => {
                setGroupForm(emptyGroupForm);
                setEditorOpen(false);
                setEditorMode("");
              }}
            />
          </AssetEditorDialog>
        ) : null}

        {editorOpen && (editorMode === "image-asset" || editorMode === "music-asset") ? (
          <AssetEditorDialog
            title={editorMode === "music-asset" ? "编辑音频" : "编辑图片"}
            className="media-asset-dialog-next"
            onClose={() => {
              setAssetForm(emptyAssetForm);
              setEditorOpen(false);
              setEditorMode("");
            }}
          >
            <MediaAssetEditPanel
              kind={editorMode === "music-asset" ? "music" : "image"}
              assetForm={assetForm}
              teamContext={teamContext}
              busyAction={busyAction}
              onAssetFormChange={setAssetForm}
              onSave={handleSaveMediaAsset}
              onCancel={() => {
                setAssetForm(emptyAssetForm);
                setEditorOpen(false);
                setEditorMode("");
              }}
            />
          </AssetEditorDialog>
        ) : null}

        {editorOpen && editorMode === "asset" && canEditActiveType ? (
          <AssetEditorDialog
            title={assetDialogTitle(activeType, assetForm.id)}
            wide={videoAnalysisAssetTypes.has(activeType) && !isVideoAssetBasicEdit}
            className={[
              videoAnalysisAssetTypes.has(activeType) && !isVideoAssetBasicEdit ? "video-analysis-dialog-next" : "",
              activeType === "product" && assetForm.id && assetForm.analysisStatus === "done" ? "product-profile-dialog-next" : "",
              activeType === "role" && assetForm.id && assetForm.analysisStatus === "done" ? "role-profile-dialog-next" : "",
            ].filter(Boolean).join(" ")}
            onClose={() => {
              setAssetForm(emptyAssetForm);
              setEditorOpen(false);
              setEditorMode("");
            }}
          >
            <AssetCrudPanel
              type={activeType}
              groups={activeData.groups}
              apiKeys={apiKeys}
              teamContext={teamContext}
              canManageGroups={canManageGroups}
              assetForm={assetForm}
              busyAction={busyAction}
              onAssetFormChange={setAssetForm}
              onSaveAsset={handleSaveAsset}
              onSaveProductProfile={handleSaveProductProfile}
              onSaveRoleProfile={handleSaveRoleProfile}
              onPreviewImage={setPreviewImage}
              onCancelAsset={() => {
                setAssetForm(emptyAssetForm);
                setEditorOpen(false);
                setEditorMode("");
              }}
            />
          </AssetEditorDialog>
        ) : null}

        {editorOpen && editorMode === "writing-extract" && activeType === "writing-style" ? (
          <AssetEditorDialog
            title="添加文风"
            wide
            className="writing-extract-dialog-next"
            onClose={() => {
              setWritingStyleExtractForm(emptyWritingStyleExtractForm);
              setEditorOpen(false);
              setEditorMode("");
            }}
          >
            <WritingStyleExtractPanel
              form={writingStyleExtractForm}
              groups={activeData.groups}
              apiKeys={apiKeys}
              teamContext={teamContext}
              busyAction={busyAction}
              onChange={setWritingStyleExtractForm}
              onFilesChange={handleWritingStyleFiles}
              onSave={handleSaveWritingStyles}
              onCancel={() => {
                setWritingStyleExtractForm(emptyWritingStyleExtractForm);
                setEditorOpen(false);
                setEditorMode("");
              }}
            />
          </AssetEditorDialog>
        ) : null}

        {activeType === "image-library" ? (
          <ImageLibraryView
            libraries={activeData.groups}
            selectedGroupId={selectedGroupId}
            busyAction={busyAction}
            onSelectGroup={setSelectedGroupId}
            onEditGroup={(group) => {
              setGroupForm({ id: group.id, name: group.name, desc: group.desc || "" });
              setEditorOpen(true);
              setEditorMode("group");
            }}
            onDeleteGroup={handleDeleteGroup}
            onUploadImages={handleUploadImages}
            onPreviewImage={setPreviewImage}
            onEditImage={startEditImage}
            onDeleteImage={handleDeleteImage}
          />
        ) : activeType === "music" ? (
          <MusicLibraryView
            groups={activeData.groups}
            tracks={activeData.assets}
            selectedGroupId={selectedGroupId}
            busyAction={busyAction}
            onSelectGroup={setSelectedGroupId}
            onEditGroup={(group) => {
              setGroupForm({ id: group.id, name: group.name, desc: group.desc || "" });
              setEditorOpen(true);
              setEditorMode("group");
            }}
            onDeleteGroup={handleDeleteGroup}
            onUploadMusic={handleUploadMusic}
            onEditMusic={startEditMusic}
            onDeleteMusic={handleDeleteMusic}
          />
        ) : (
          <AssetListView
            type={activeType}
            groups={activeData.groups}
            assets={activeData.assets}
            selectedGroupId={selectedGroupId}
            editable={canEditActiveType}
            groupEditable={canManageGroups}
            busyAction={busyAction}
            onSelectGroup={setSelectedGroupId}
            onEditGroup={(group) => {
              setGroupForm({ id: group.id, name: group.name, desc: group.desc || "" });
              setEditorOpen(true);
              setEditorMode("group");
            }}
            onDeleteGroup={handleDeleteGroup}
            onEditAsset={startEditAsset}
            onDeleteAsset={handleDeleteAsset}
          />
        )}
        {confirmDialog ? (
          <AssetConfirmDialog
            payload={confirmDialog}
            busy={Boolean(busyAction && /delete/.test(busyAction))}
            onClose={() => {
              if (!busyAction) setConfirmDialog(null);
            }}
          />
        ) : null}
        {previewImage ? <ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} /> : null}
      </section>
      )}
    </div>
  );
}

function PendingFeatureDialog({ feature, onClose }) {
  return (
    <AssetEditorDialog title="功能待开发" onClose={onClose}>
      <section className="asset-pending-dialog-next">
        <h4>功能待开发</h4>
        <div className="asset-pending-detail-next">
          <span>当前模块</span>
          <strong>{feature?.label || "暂未开放"}</strong>
        </div>
        <p>这个资产模块还在规划中，后续会接入对应的管理能力。</p>
        <p>你可以先使用图片库、图风库、文风库、音乐库和提示词库。</p>
        <button className="primary-action compact" type="button" onClick={onClose}>
          知道了
        </button>
      </section>
    </AssetEditorDialog>
  );
}

function AssetConfirmDialog({ payload, busy, onClose }) {
  return (
    <AssetEditorDialog title={payload.title || "确认操作"} onClose={onClose}>
      <section className={`asset-confirm-dialog-next ${payload.danger ? "danger" : ""}`}>
        <h4>{payload.title || "确认操作"}</h4>
        <p>{payload.summary || "确认继续执行这个操作吗？"}</p>
        <div className="asset-pending-detail-next">
          <span>{payload.label || "操作对象"}</span>
          <strong>{payload.target || "当前项目"}</strong>
        </div>
        {payload.hint ? <p>{payload.hint}</p> : null}
        <div className="asset-form-actions">
          {payload.noticeOnly ? (
            <button className="primary-action compact" type="button" onClick={onClose} disabled={busy}>
              {payload.confirmText || "知道了"}
            </button>
          ) : (
            <>
              <button className="secondary-action" type="button" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button className={`primary-action compact ${payload.danger ? "danger" : ""}`} type="button" onClick={payload.onConfirm} disabled={busy}>
                {busy ? "处理中..." : payload.confirmText || "确认"}
              </button>
            </>
          )}
        </div>
      </section>
    </AssetEditorDialog>
  );
}

function MediaGroupCrudPanel({ kind, groupForm, busyAction, onGroupFormChange, onSaveGroup, onCancelGroup }) {
  const copy = groupPanelCopy(kind);
  const isImage = kind === "image";
  return (
    <section className="asset-crud-panel">
      <form className={`asset-inline-form group-form-next ${isImage ? "image-group-form-next" : ""}`} onSubmit={onSaveGroup}>
        <div>
          <h4>{groupForm.id ? copy.editTitle : copy.createTitle}</h4>
        </div>
        <label>
          {copy.nameLabel}
          <input value={groupForm.name} onChange={(event) => onGroupFormChange({ ...groupForm, name: event.target.value })} placeholder={copy.namePlaceholder} />
        </label>
        {isImage ? (
          <p className="asset-field-help-next">{copy.help}</p>
        ) : (
          <label>
            {copy.descLabel}
            <textarea value={groupForm.desc} onChange={(event) => onGroupFormChange({ ...groupForm, desc: event.target.value })} placeholder={copy.descPlaceholder} rows={4}></textarea>
          </label>
        )}
        <div className="asset-form-actions">
          <button className="secondary-action" type="button" onClick={onCancelGroup}>
            取消
          </button>
          <button className="primary-action compact" type="submit" disabled={busyAction === "save-group"}>
            {busyAction === "save-group" ? "保存中..." : copy.saveLabel}
          </button>
        </div>
      </form>
    </section>
  );
}

function MediaAssetEditPanel({ kind, assetForm, teamContext, busyAction, onAssetFormChange, onSave, onCancel }) {
  const isMusic = kind === "music";
  const title = isMusic ? "编辑音频" : "编辑图片";
  const nameLabel = isMusic ? "音乐名称" : "图片名称";
  const previewUrl = resolveFlowStudioFileUrl(assetForm.thumbnailUrl || assetForm.fileUrl || "");
  const fullUrl = resolveFlowStudioFileUrl(assetForm.fileUrl || "");
  const saving = busyAction === `save-${isMusic ? "music" : "image-library"}-asset`;

  return (
    <section className="asset-crud-panel">
      <form className="asset-inline-form media-asset-edit-form-next" onSubmit={onSave}>
        <div>
          <h4>{title}</h4>
        </div>
        {isMusic && fullUrl ? (
          <audio controls src={fullUrl}></audio>
        ) : previewUrl ? (
          <div className="media-asset-preview-next">
            <img src={previewUrl} alt={assetForm.name || "图片预览"} />
          </div>
        ) : null}
        <label>
          {nameLabel}
          <input
            value={assetForm.name}
            onChange={(event) => onAssetFormChange({ ...assetForm, name: event.target.value })}
            placeholder={isMusic ? "输入音乐名称" : "输入图片名称"}
          />
        </label>
        <AssetTeamShareField
          value={assetForm.shared}
          teamContext={teamContext}
          onChange={(shared) => onAssetFormChange({ ...assetForm, shared })}
        />
        <div className="asset-form-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="primary-action compact" type="submit" disabled={saving}>
            {saving ? "保存中..." : "保存修改"}
          </button>
        </div>
      </form>
    </section>
  );
}

function AssetEditorDialog({ children, onClose, title = "编辑资产", wide = false, className = "" }) {
  return createPortal(
    <div className="asset-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`asset-dialog-next asset-editor-dialog-shell-next ${wide ? "wide" : ""} ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}>
        <button className="asset-dialog-close" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div className="asset-dialog-scroll-next">
          <AssetDialogErrorBoundary onClose={onClose}>
            {children}
          </AssetDialogErrorBoundary>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ImagePreviewDialog({ image, onClose }) {
  const fullUrl = resolveFlowStudioFileUrl(image?.fileUrl || image?.dataUrl || "");
  const title = image?.name || "原图预览";

  return createPortal(
    <div className="asset-dialog-backdrop image-preview-backdrop-next" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="asset-dialog-next image-preview-dialog-next" role="dialog" aria-modal="true" aria-label={title}>
        <button className="asset-dialog-close" type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div className="image-preview-head-next">
          <h4>{title}</h4>
        </div>
        {fullUrl ? <img src={fullUrl} alt={title} /> : <div className="asset-image-fallback">Image</div>}
      </section>
    </div>,
    document.body,
  );
}

class AssetDialogErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <section className="asset-dialog-error-next">
          <h4>窗口加载失败</h4>
          <p>{this.state.error?.message || "当前弹窗遇到未知错误，请关闭后重试。"}</p>
          <button className="secondary-action" type="button" onClick={this.props.onClose}>
            关闭
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

function AssetTeamShareField({ value, teamContext, onChange }) {
  if (!teamContext?.team) {
    if (!canCreateTeamWithoutTeam(teamContext)) return null;
    return (
      <label className="asset-inline-check-next team-share-check-next disabled">
        <input type="checkbox" checked={false} disabled readOnly />
        <span>
          <strong>团队共享</strong>
          <small>先到团队空间创建团队后可用</small>
        </span>
      </label>
    );
  }
  if (!["owner", "member"].includes(teamContext.role)) return null;
  const isOwner = teamContext.role === "owner";
  return (
    <label className="asset-inline-check-next team-share-check-next">
      <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(Boolean(event.target.checked))} />
      <span>
        <strong>{isOwner ? "团队共享" : "申请共享到团队"}</strong>
        <small>{isOwner ? "保存后全体成员可用" : "提交后等待所有者审核"}</small>
      </span>
    </label>
  );
}

function assetTeamShareFields(form = {}, teamContext = null) {
  if (!form.shared || !teamContext?.team) return {};
  if (teamContext.role === "owner") return { teamShared: true };
  if (teamContext.role === "member") return { requestTeamShare: true };
  return {};
}

function canCreateTeamWithoutTeam(teamContext) {
  return !teamContext?.team && Boolean(teamContext?.canCreateTeam || teamContext?.membershipPlan === "team");
}

function WritingStyleExtractPanel({
  form,
  groups,
  apiKeys,
  teamContext,
  busyAction,
  onChange,
  onFilesChange,
  onSave,
  onCancel,
}) {
  const safeForm = normalizeWritingStyleExtractForm(form);
  const safeGroups = Array.isArray(groups) ? groups.filter(Boolean) : [];
  const safeApiKeys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [];
  const llmKeys = apiKeysForService(safeApiKeys, "llm");
  const selectedApiKey = llmKeys.find((key) => key.id === safeForm.llmKeyId);
  const models = workflowLlmModelOptions(selectedApiKey);
  const saving = busyAction === "save-writing-style";
  const reading = busyAction === "read-writing-files";

  function updateForm(key, value) {
    onChange((current) => {
      const next = { ...current, [key]: value };
      if (key === "llmKeyId") {
        const nextApiKey = llmKeys.find((item) => item.id === value);
        next.modelId = workflowLlmModelOptions(nextApiKey)[0]?.id || "";
      }
      return next;
    });
  }

  return (
    <section className="asset-crud-panel writing-extract-panel-next">
      <form className="asset-inline-form writing-extract-form-next" onSubmit={onSave}>
        <div className="writing-extract-head-next">
          <div>
            <h4>添加文风</h4>
          </div>
        </div>

        <div className="writing-extract-hint-next">
          写作风格的提取，选择 5-10 篇文章为佳。支持上传 md、txt、pdf 文件；多文件会保存为多个文风。
        </div>

        <div className="writing-extract-grid-next">
          <label>
            <span>文风名称</span>
            <input
              value={safeForm.name}
              onChange={(event) => updateForm("name", event.target.value)}
              placeholder="留空时使用文件名"
            />
          </label>
          <label>
            <span>保存分组</span>
            <select value={safeForm.groupId} onChange={(event) => updateForm("groupId", event.target.value)}>
              {safeGroups.length ? safeGroups.map((group) => (
                <option value={group.id} key={group.id}>{group.name}</option>
              )) : <option value="">请先添加分组</option>}
            </select>
          </label>
          <label>
            <span>LLM 渠道</span>
            <select value={safeForm.llmKeyId} onChange={(event) => updateForm("llmKeyId", event.target.value)}>
              {llmKeys.length ? llmKeys.map((key) => (
                <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
              )) : <option value="">请先添加 LLM API</option>}
            </select>
          </label>
          <label>
            <span>分析模型</span>
            <select value={safeForm.modelId} onChange={(event) => updateForm("modelId", event.target.value)}>
              {models.length ? models.map((model) => (
                <option value={model.id} key={model.id}>{model.name}</option>
              )) : <option value="">请先选择可用渠道</option>}
            </select>
          </label>
        </div>

        <label className="writing-upload-field-next">
          <span>上传样本文档</span>
          <span className="writing-upload-control-next">
            <strong>选择文件</strong>
            <small>支持 md、txt、pdf，可多选</small>
          </span>
          <input
            type="file"
            accept=".md,.txt,.pdf,text/markdown,text/plain,application/pdf"
            multiple
            onChange={(event) => {
              onFilesChange(event.target.files);
              event.target.value = "";
            }}
          />
        </label>

        <WritingFilePreview files={safeForm.files} reading={reading} />

        <AssetTeamShareField
          value={safeForm.shared}
          teamContext={teamContext}
          onChange={(shared) => updateForm("shared", shared)}
        />

        <div className="asset-form-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="primary-action compact" type="submit" disabled={saving || reading}>
            {saving ? "分析并保存中..." : "保存"}
          </button>
        </div>
      </form>
    </section>
  );
}

function WritingFilePreview({ files, reading }) {
  const safeFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  if (reading) {
    return (
      <div className="writing-file-preview-next">
        <p>正在读取样本文档...</p>
      </div>
    );
  }
  if (!safeFiles.length) {
    return (
      <div className="writing-file-preview-next">
        <p>尚未选择文件。建议上传 5-10 篇风格稳定、质量较高的文章。</p>
      </div>
    );
  }
  const qualityNote = safeFiles.length >= 5 && safeFiles.length <= 10
    ? "样本数量合适，适合提取稳定文风。"
    : "建议选择 5-10 篇文章，样本过少或过多都可能让风格不够集中。";
  return (
    <div className="writing-file-preview-next">
      <div className="writing-file-note-next">{qualityNote}</div>
      {safeFiles.map((file) => (
        <div className="writing-file-row-next" key={file.id}>
          <span>{file.name}</span>
          <small>{formatBytes(file.size)} · {file.status}</small>
        </div>
      ))}
    </div>
  );
}

function MusicLibraryView({ groups, tracks, selectedGroupId, busyAction, onSelectGroup, onEditGroup, onDeleteGroup, onUploadMusic, onEditMusic, onDeleteMusic }) {
  const fileInputRef = useRef(null);
  const displayGroups = musicLibraryDisplayGroups(groups, tracks);
  const selectedGroup = displayGroups.find((group) => group.id === selectedGroupId)
    || displayGroups.find((group) => musicTracksForDisplayGroup(group, groups, tracks).length > 0)
    || displayGroups[0]
    || null;
  const selectedTracks = selectedGroup ? musicTracksForDisplayGroup(selectedGroup, groups, tracks) : [];
  const canUploadToSelectedGroup = Boolean(selectedGroup && !selectedGroup.synthetic);
  const isUploading = canUploadToSelectedGroup ? busyAction === `upload-music-${selectedGroup.id}` : false;

  return (
    <div className="asset-library-layout">
      <div className="asset-group-list">
        <p className="asset-group-label">音乐分组</p>
        {displayGroups.length ? (
          displayGroups.map((group) => {
            const count = musicTracksForDisplayGroup(group, groups, tracks).length;
            return (
              <article className={`asset-group-card ${selectedGroup?.id === group.id ? "active" : ""}`} key={group.id}>
                <div>
                  <button type="button" onClick={() => onSelectGroup(group.id)}>
                    <strong>{group.name}</strong>
                  </button>
                </div>
                <div className="asset-card-actions">
                  <span className="asset-count-pill">{count}</span>
                  {!group.synthetic ? (
                    <>
                      <button type="button" onClick={() => onEditGroup(group)}>
                        ✎
                      </button>
                      <button type="button" onClick={() => onDeleteGroup(group)} disabled={busyAction === `delete-group-${group.id}`}>
                        ×
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            );
          })
        ) : (
          <EmptyAsset title="暂无音乐分组" detail="先添加一个分组，再上传音频。" />
        )}
      </div>

      <section className="asset-library-main-next">
        <div className="asset-library-toolbar-next">
          <div>
            <h3>{selectedGroup?.name || "音乐库"}</h3>
            <p>
              {selectedGroup
                ? `${selectedTracks.length} 个音频 · ${selectedGroup.desc || "自定义音乐分组"}`
                : "添加音乐分组后，可以上传 mp3、wav、m4a 等音频文件。"}
            </p>
          </div>
          <button className="primary-action compact" type="button" onClick={() => fileInputRef.current?.click()} disabled={!canUploadToSelectedGroup || isUploading}>
            {isUploading ? "上传中" : "上传音频"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            multiple
            hidden
            onChange={(event) => {
              if (canUploadToSelectedGroup) onUploadMusic(selectedGroup, event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        <div className="asset-card-grid asset-card-grid-plain-next">
          {selectedTracks.length ? (
            selectedTracks.map((track) => (
              <AssetCard
                type="music"
                asset={track}
                groups={groups}
                editable={canEditAssetRecord(track)}
                deleting={busyAction === `delete-music-${track.id}`}
                onEdit={() => onEditMusic(track)}
                onDelete={() => onDeleteMusic(track)}
                key={track.id}
              />
            ))
          ) : (
            <EmptyAsset
              title={selectedGroup ? "还没有音乐素材" : "暂无音乐分组"}
              detail={selectedGroup?.synthetic ? "团队共享音频会在这里显示。" : selectedGroup ? "上传音频后会在这里显示。" : "先添加一个分组，再上传音频。"}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function musicLibraryDisplayGroups(groups = [], tracks = []) {
  const normalizedGroups = Array.isArray(groups) ? groups : [];
  const normalizedTracks = Array.isArray(tracks) ? tracks : [];
  const knownGroupIds = new Set(normalizedGroups.map((group) => group.id).filter(Boolean));
  const missingGroupTracks = normalizedTracks.filter((track) => !track.groupId || !knownGroupIds.has(track.groupId));
  const hasTeamSharedTracks = missingGroupTracks.some(isTeamAssetRecord);
  const hasPersonalUngroupedTracks = missingGroupTracks.some((track) => !isTeamAssetRecord(track));
  return [
    ...normalizedGroups,
    ...(hasTeamSharedTracks ? [{
      id: "music-team-shared",
      name: "团队共享",
      desc: "来自团队共享的音频素材",
      synthetic: true,
      teamShared: true,
    }] : []),
    ...(hasPersonalUngroupedTracks ? [{
      id: ungroupedAssetGroupId("music"),
      name: "未分组",
      desc: "未归入任何音乐分组",
      synthetic: true,
      ungrouped: true,
    }] : []),
  ];
}

function musicTracksForDisplayGroup(group, groups = [], tracks = []) {
  const normalizedTracks = Array.isArray(tracks) ? tracks : [];
  if (!group) return [];
  if (!group.synthetic) return normalizedTracks.filter((track) => track.groupId === group.id);
  const knownGroupIds = new Set((Array.isArray(groups) ? groups : []).map((item) => item.id).filter(Boolean));
  const missingGroupTracks = normalizedTracks.filter((track) => !track.groupId || !knownGroupIds.has(track.groupId));
  if (group.teamShared) return missingGroupTracks.filter(isTeamAssetRecord);
  if (group.ungrouped) return missingGroupTracks.filter((track) => !isTeamAssetRecord(track));
  return [];
}

function AssetCrudPanel({
  type,
  groups,
  apiKeys,
  teamContext,
  canManageGroups,
  assetForm,
  busyAction,
  onAssetFormChange,
  onSaveAsset,
  onSaveProductProfile,
  onSaveRoleProfile,
  onPreviewImage,
  onCancelAsset,
}) {
  const isPrompt = type === "prompt";
  const isVisualStyle = type === "visual-style";
  const isWritingStyle = type === "writing-style";
  const isEcommerceAsset = ecommerceAssetTypes.has(type);
  const assetLabel = assetUnitLabel(type);

  if (type === "product" && (assetForm.entryMode === "manual" || (assetForm.id && assetForm.prompt && assetForm.analysisStatus === "done" && !isMissingVideoAnalysisResponse(assetForm.prompt)))) {
    return (
      <ProductAnalysisDetailPanel
        assetForm={assetForm}
        groups={groups}
        canManageGroups={canManageGroups}
        teamContext={teamContext}
        busyAction={busyAction}
        onSaveProfile={onSaveProductProfile}
        onAssetFormChange={onAssetFormChange}
        onPreviewImage={onPreviewImage}
        onReanalyze={() => onAssetFormChange({ ...assetForm, prompt: "", files: [] })}
        onSwitchToVideo={() => onAssetFormChange({ ...assetForm, entryMode: "video" })}
        onCancelAsset={onCancelAsset}
        showModeSwitch={!assetForm.id}
      />
    );
  }

  if (type === "role" && assetForm.id && assetForm.analysisStatus === "done" && (assetForm.roleProfile || assetForm.prompt) && !isMissingVideoAnalysisResponse(assetForm.prompt)) {
    return (
      <RoleAnalysisDetailPanel
        assetForm={assetForm}
        apiKeys={apiKeys}
        teamContext={teamContext}
        busyAction={busyAction}
        onSaveProfile={onSaveRoleProfile}
        onAssetFormChange={onAssetFormChange}
        onPreviewImage={onPreviewImage}
        onReanalyze={() => onAssetFormChange({ ...assetForm, prompt: "", files: [] })}
        onCancelAsset={onCancelAsset}
      />
    );
  }

  if (videoAnalysisAssetTypes.has(type)) {
    return (
      <VideoAnalysisAssetPanel
        type={type}
        groups={groups}
        apiKeys={apiKeys}
        teamContext={teamContext}
        canManageGroups={canManageGroups}
        assetForm={assetForm}
        busyAction={busyAction}
        onAssetFormChange={onAssetFormChange}
        onSaveAsset={onSaveAsset}
        onCancelAsset={onCancelAsset}
      />
    );
  }

  return (
    <section className="asset-crud-panel">
      <form className={`asset-inline-form asset-form-next ${isVisualStyle ? "visual-style-form-next" : ""} ${isPrompt ? "prompt-form-next" : ""} ${isWritingStyle ? "writing-edit-form-next" : ""}`} onSubmit={onSaveAsset}>
        <div>
          <h4>{assetFormTitle(type, assetForm.id)}</h4>
        </div>
        <label>
          {isPrompt ? "提示词名称" : isVisualStyle ? "风格名称 *" : "文风名称"}
          <input
            value={assetForm.name}
            onChange={(event) => onAssetFormChange({ ...assetForm, name: event.target.value })}
            placeholder={assetNamePlaceholder(type)}
          />
        </label>
        {canManageGroups ? (
          <label>
            保存分组
            <select value={assetForm.groupId} onChange={(event) => onAssetFormChange({ ...assetForm, groupId: event.target.value })}>
              <option value="">未分组</option>
              {groups.map((group) => (
                <option value={group.id} key={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {isVisualStyle ? (
          <>
            <label>
              简介
              <input value={assetForm.desc} onChange={(event) => onAssetFormChange({ ...assetForm, desc: event.target.value })} placeholder="一句话描述这个风格（可选）" />
            </label>
            <label className="asset-textarea-field">
              风格描述 *
              <textarea value={assetForm.prompt} onChange={(event) => onAssetFormChange({ ...assetForm, prompt: event.target.value })} placeholder="如：融合了强烈3D动画渲染质感的超写实摄影风格，cinematic lighting, 8k, ultra-realistic, vibrant colors" rows={6}></textarea>
            </label>
            <p className="asset-field-help-next">这段描述将自动应用到所有生成的图片提示词中</p>
          </>
        ) : isPrompt ? (
          <label className="asset-textarea-field">
            提示词内容
            <textarea value={assetForm.prompt} onChange={(event) => onAssetFormChange({ ...assetForm, prompt: event.target.value })} placeholder="输入可复用的提示词内容..." rows={8}></textarea>
          </label>
        ) : isEcommerceAsset ? (
          <>
            <label>
              摘要
              <input value={assetForm.desc} onChange={(event) => onAssetFormChange({ ...assetForm, desc: event.target.value })} placeholder={assetDescPlaceholder(type)} />
            </label>
            <label>
              标签
              <input value={assetForm.tag} onChange={(event) => onAssetFormChange({ ...assetForm, tag: event.target.value })} placeholder="例如：测评、反差、痛点、强转化" />
            </label>
            <label className="asset-textarea-field">
              分析结果 / 可复用内容
              <textarea value={assetForm.prompt} onChange={(event) => onAssetFormChange({ ...assetForm, prompt: event.target.value })} placeholder={assetPromptPlaceholder(type)} rows={8}></textarea>
            </label>
            <p className="asset-field-help-next">MVP 阶段可手动粘贴视频分析、商品卖点或模板内容；后续自动分析会写入同一字段。</p>
          </>
        ) : null}
        <AssetTeamShareField
          value={assetForm.shared}
          teamContext={teamContext}
          onChange={(shared) => onAssetFormChange({ ...assetForm, shared })}
        />
        <div className="asset-form-actions">
          <button className="secondary-action" type="button" onClick={onCancelAsset}>
            取消
          </button>
          <button className="primary-action compact" type="submit" disabled={busyAction === "save-asset"}>
            {busyAction === "save-asset" ? "保存中..." : assetFormSaveLabel(type, assetForm.id, assetLabel)}
          </button>
        </div>
      </form>
    </section>
  );
}

function VideoAnalysisAssetPanel({
  type,
  groups,
  apiKeys,
  teamContext,
  canManageGroups,
  assetForm,
  busyAction,
  onAssetFormChange,
  onSaveAsset,
  onCancelAsset,
}) {
  const nameInputRef = useRef(null);
  const llmKeys = apiKeysForService(apiKeys, "llm").filter(apiKeySupportsVideoAnalysis);
  const imageKeys = apiKeysForService(apiKeys, "image");
  const selectedKey = llmKeys.find((key) => key.id === assetForm.llmKeyId) || null;
  const selectedImageKey = imageKeys.find((key) => key.id === assetForm.imageKeyId) || null;
  const models = videoAnalysisModelsForApiKey(selectedKey);
  const imageModels = roleImageModelOptions(selectedImageKey);
  const activeImageModel = imageModels.find((model) => model.id === assetForm.imageModelId || model.modelId === assetForm.imageModelId) || imageModels[0] || null;
  const modelOptions = models;
  const supportsYoutubeSource = youtubeVideoAnalysisAssetTypes.has(type);
  const videoSourceMode = supportsYoutubeSource && assetForm.videoSourceMode === "youtube" ? "youtube" : "upload";
  const selectedFile = Array.isArray(assetForm.files) ? assetForm.files[0] : null;
  const file = videoSourceMode === "youtube" ? null : selectedFile;
  const saving = busyAction === "save-asset";
  const hasFailedAnalysis = isMissingVideoAnalysisResponse(assetForm.prompt || assetForm.analysisError || "");
  const hasValidSavedAnalysis = Boolean(assetForm.prompt && !hasFailedAnalysis);
  const supportsManualEntry = type === "hook" || type === "product";
  const isManualTechniqueForm = (type === "hook" || type === "element") && assetForm.entryMode === "manual";
  const isScriptBasicEdit = type === "script" && Boolean(assetForm.id);
  const isTechniqueBasicEdit = isVideoExtractedTechniqueAssetForm(type, assetForm);
  const copy = type === "script"
    ? {
      title: assetForm.id ? "重新分析脚本视频" : "添加脚本视频",
      nameLabel: "脚本资产名称",
      fileLabel: "上传对标视频",
      help: "请上传 20M 以内的视频。提交后会调用模型并可能产生渠道费用，提取中请勿重复提交。",
      accept: "video/*,.mp4,.mov,.m4v,.webm",
    }
    : type === "role"
      ? {
        title: assetForm.id ? "重新分析角色视频" : "添加角色视频",
        nameLabel: "角色资产名称",
        fileLabel: "上传角色视频",
        help: "请上传 20M 以内的视频。默认只解析角色资料；勾选生成角色图后才会调用绘画模型。",
        accept: "video/*,.mp4,.mov,.m4v,.webm",
      }
      : type === "hook"
        ? {
          title: assetForm.id ? "编辑爆款开头" : "添加爆款开头",
          nameLabel: "视频素材名称",
          fileLabel: "上传开头参考视频",
          help: "上传 20M 以内的视频，AI 会提取多个可复用开头技巧，并拆成独立卡片。",
          accept: "video/*,.mp4,.mov,.m4v,.webm",
        }
        : type === "element"
          ? {
            title: assetForm.id ? "编辑爆款元素" : "添加爆款元素",
            nameLabel: "视频素材名称",
            fileLabel: "上传元素参考视频",
            help: "上传 20M 以内的视频，AI 会提取多个爆款元素，并拆成独立卡片。",
            accept: "video/*,.mp4,.mov,.m4v,.webm",
          }
          : {
            title: assetForm.id ? "重新分析产品视频" : "添加产品视频",
            nameLabel: "产品资产名称",
            fileLabel: "上传产品视频",
            help: "请上传 20M 以内的视频。提交后会调用模型并可能产生渠道费用，提取中请勿重复提交。",
            accept: "video/*,.mp4,.mov,.m4v,.webm",
          };
  const youtubeSourceAction = assetForm.id ? "重新分析" : "添加";
  const youtubeSourceTitle = type === "script"
    ? `${youtubeSourceAction} YouTube 脚本视频`
    : type === "role"
      ? `${youtubeSourceAction} YouTube 角色视频`
      : type === "hook"
        ? `${youtubeSourceAction} YouTube 开头参考`
        : `${youtubeSourceAction} YouTube 元素参考`;
  const panelTitle = videoSourceMode === "youtube" ? youtubeSourceTitle : copy.title;
  const panelHelp = videoSourceMode === "youtube"
    ? "粘贴公开的 YouTube 视频链接。提交后会调用 Gemini 并可能产生渠道费用，提取中请勿重复提交。"
    : copy.help;

  useEffect(() => {
    if (!assetForm.nameError || !nameInputRef.current) return;
    nameInputRef.current.focus({ preventScroll: true });
    nameInputRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [assetForm.nameError]);

  async function handleVideoSelection(fileList) {
    const nextFile = Array.from(fileList || []).find((item) => item.type.startsWith("video/")) || null;
    if (!nextFile) {
      onAssetFormChange({ ...assetForm, files: [], videoDurationSeconds: 0, fileError: "" });
      return;
    }
    if (nextFile.size > videoAnalysisMaxBytes) {
      onAssetFormChange({
        ...assetForm,
        files: [],
        videoDurationSeconds: 0,
        fileError: "请上传 20M 以内的视频。",
      });
      return;
    }
    onAssetFormChange({
      ...assetForm,
      videoSourceMode: "upload",
      files: [nextFile],
      videoDurationSeconds: 0,
      fileError: "",
      nameError: "",
    });
    const durationSeconds = await readVideoDuration(nextFile).catch(() => 0);
    onAssetFormChange((current) => ({
      ...current,
      videoDurationSeconds: current.files?.[0] === nextFile ? durationSeconds : current.videoDurationSeconds,
    }));
  }

  function updateVideoSourceMode(mode) {
    onAssetFormChange({
      ...assetForm,
      videoSourceMode: mode === "youtube" && supportsYoutubeSource ? "youtube" : "upload",
      fileError: "",
    });
  }

  function updateLlmKey(llmKeyId) {
    const key = llmKeys.find((item) => item.id === llmKeyId);
    const nextModels = videoAnalysisModelsForApiKey(key);
    onAssetFormChange({
      ...assetForm,
      llmKeyId,
      modelId: nextModels[0]?.id || "",
    });
  }

  function updateImageKey(imageKeyId) {
    const key = imageKeys.find((item) => item.id === imageKeyId);
    const nextModels = roleImageModelOptions(key);
    const nextModel = nextModels[0] || null;
    onAssetFormChange({
      ...assetForm,
      imageKeyId,
      imageModelId: nextModel?.id || defaultRoleImageModel,
      imageRatio: nextModel?.ratios?.[0]?.value || "1:1",
      imageResolution: nextModel?.resolutions?.[0] || "1k",
      imageFormat: nextModel?.formats?.[0] || "png",
    });
  }

  function updateImageModel(imageModelId) {
    const nextModel = imageModels.find((model) => model.id === imageModelId || model.modelId === imageModelId) || imageModels[0] || null;
    onAssetFormChange({
      ...assetForm,
      imageModelId,
      imageRatio: nextModel?.ratios?.some((ratio) => ratio.value === assetForm.imageRatio) ? assetForm.imageRatio : nextModel?.ratios?.[0]?.value || "1:1",
      imageResolution: nextModel?.resolutions?.includes(assetForm.imageResolution) ? assetForm.imageResolution : nextModel?.resolutions?.[0] || "1k",
      imageFormat: nextModel?.formats?.includes(assetForm.imageFormat) ? assetForm.imageFormat : nextModel?.formats?.[0] || "png",
    });
  }

  if (isScriptBasicEdit || isTechniqueBasicEdit) {
    const basicNameLabel = type === "script" ? "脚本资产名称" : type === "hook" ? "开头名称" : "元素名称";
    return (
      <section className="asset-crud-panel">
        <form className="asset-inline-form video-analysis-asset-form-next script-basic-edit-form-next" onSubmit={onSaveAsset}>
          <div className="video-analysis-field-grid-next">
            <label>
              {basicNameLabel}
              <input value={assetForm.name} onChange={(event) => onAssetFormChange({ ...assetForm, name: event.target.value })} placeholder={assetNamePlaceholder(type)} />
            </label>
            {canManageGroups ? (
              <label>
                保存分组
                <select value={assetForm.groupId} onChange={(event) => onAssetFormChange({ ...assetForm, groupId: event.target.value })}>
                  <option value="">未分组</option>
                  {groups.map((group) => (
                    <option value={group.id} key={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <AssetTeamShareField
            value={assetForm.shared}
            teamContext={teamContext}
            onChange={(shared) => onAssetFormChange({ ...assetForm, shared })}
          />
          <div className="asset-form-actions">
            <button className="secondary-action" type="button" onClick={onCancelAsset} disabled={saving}>
              取消
            </button>
            <button className="primary-action compact" type="submit" disabled={saving}>
              {saving ? "保存中..." : "保存修改"}
            </button>
          </div>
        </form>
      </section>
    );
  }

  if (isManualTechniqueForm) {
    return (
      <section className="asset-crud-panel">
        <form className="asset-inline-form video-analysis-asset-form-next technique-manual-form-next" onSubmit={onSaveAsset}>
          <div className="video-analysis-form-head-next">
            <h4>{assetForm.id ? (type === "hook" ? "编辑爆款开头" : "编辑爆款元素") : "手动填写爆款开头"}</h4>
            <span>{type === "hook" ? "手动沉淀可复用开头技巧；视频提取会自动拆成多张卡片。" : "编辑已提取的爆款元素内容。"}</span>
          </div>
          {supportsManualEntry && !assetForm.id ? (
            <div className="asset-entry-mode-tabs-next" role="tablist" aria-label="爆款开头添加方式">
              <button type="button" className={assetForm.entryMode !== "manual" ? "active" : ""} onClick={() => onAssetFormChange({ ...assetForm, entryMode: "video" })}>
                视频提取
              </button>
              <button type="button" className={assetForm.entryMode === "manual" ? "active" : ""}>
                手动填写
              </button>
            </div>
          ) : null}
          <div className="video-analysis-field-grid-next">
            <label>
              {type === "hook" ? "开头名称" : "元素名称"}
              <input value={assetForm.name} onChange={(event) => onAssetFormChange({ ...assetForm, name: event.target.value })} placeholder={assetNamePlaceholder(type)} />
            </label>
            {canManageGroups ? (
              <label>
                保存分组
                <select value={assetForm.groupId} onChange={(event) => onAssetFormChange({ ...assetForm, groupId: event.target.value })}>
                  <option value="">未分组</option>
                  {groups.map((group) => (
                    <option value={group.id} key={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              摘要
              <input value={assetForm.desc} onChange={(event) => onAssetFormChange({ ...assetForm, desc: event.target.value })} placeholder={assetDescPlaceholder(type)} />
            </label>
            <label>
              标签
              <input value={assetForm.tag} onChange={(event) => onAssetFormChange({ ...assetForm, tag: event.target.value })} placeholder="例如：反差、痛点、价格锚点" />
            </label>
          </div>
          <label className="asset-textarea-field technique-manual-content-next">
            分析结果 / 可复用内容
            <textarea value={assetForm.prompt} onChange={(event) => onAssetFormChange({ ...assetForm, prompt: event.target.value })} placeholder={assetPromptPlaceholder(type)} rows={8}></textarea>
          </label>
          <AssetTeamShareField
            value={assetForm.shared}
            teamContext={teamContext}
            onChange={(shared) => onAssetFormChange({ ...assetForm, shared })}
          />
          <div className="asset-form-actions">
            <button className="secondary-action" type="button" onClick={onCancelAsset} disabled={saving}>
              取消
            </button>
            <button className="primary-action compact" type="submit" disabled={saving}>
              {saving ? "保存中..." : assetForm.id ? "保存修改" : "保存开头"}
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="asset-crud-panel">
      <form className="asset-inline-form video-analysis-asset-form-next" onSubmit={onSaveAsset}>
        <div className="video-analysis-form-head-next">
          <h4>{panelTitle}</h4>
          <span>{panelHelp}</span>
        </div>
        {supportsManualEntry && !assetForm.id ? (
          <div className="asset-entry-mode-tabs-next" role="tablist" aria-label={type === "product" ? "产品添加方式" : "爆款开头添加方式"}>
            <button type="button" className={assetForm.entryMode !== "manual" ? "active" : ""}>
              视频提取
            </button>
            <button type="button" className={assetForm.entryMode === "manual" ? "active" : ""} onClick={() => onAssetFormChange({ ...assetForm, entryMode: "manual" })}>
              {type === "product" ? "手动录入" : "手动填写"}
            </button>
          </div>
        ) : null}
        <div className="video-analysis-field-grid-next">
          <label>
            {copy.nameLabel}
            <input
              ref={nameInputRef}
              value={assetForm.name}
              onChange={(event) => onAssetFormChange({
                ...assetForm,
                name: event.target.value,
                nameError: "",
              })}
              placeholder={assetNamePlaceholder(type)}
              aria-invalid={Boolean(assetForm.nameError)}
              aria-describedby={assetForm.nameError ? "video-analysis-name-error" : undefined}
            />
            {assetForm.nameError ? (
              <em id="video-analysis-name-error" className="video-analysis-field-error-next" role="alert">
                {assetForm.nameError}
              </em>
            ) : null}
          </label>
          {canManageGroups ? (
            <label>
              保存分组
              <select value={assetForm.groupId} onChange={(event) => onAssetFormChange({ ...assetForm, groupId: event.target.value })}>
                <option value="">未分组</option>
                {groups.map((group) => (
                  <option value={group.id} key={group.id}>{group.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            LLM 渠道
            <select value={assetForm.llmKeyId} onChange={(event) => updateLlmKey(event.target.value)}>
              <option value="">请选择 LLM 渠道</option>
              {llmKeys.map((key) => (
                <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
              ))}
            </select>
          </label>
          <label>
            分析模型
            <select value={assetForm.modelId || defaultVideoAnalysisModel} onChange={(event) => onAssetFormChange({ ...assetForm, modelId: event.target.value })}>
              {modelOptions.length ? modelOptions.map((model) => (
                <option value={model.id} key={model.id}>{model.name}</option>
              )) : <option value={defaultVideoAnalysisModel}>{defaultVideoAnalysisModel}</option>}
            </select>
          </label>
        </div>
        {type === "script" ? (
          <div className="video-analysis-field-grid-next role-image-config-next">
            <label>
              角色数量
              <select value={assetForm.roleCountMode || "auto"} onChange={(event) => onAssetFormChange({ ...assetForm, roleCountMode: event.target.value })}>
                <option value="auto">默认：AI 提取核心人物</option>
                <option value="custom">自定义数量</option>
              </select>
            </label>
            {assetForm.roleCountMode === "custom" ? (
              <label>
                自定义角色数量
                <input
                  type="number"
                  min="1"
                  max="20"
                  step="1"
                  value={assetForm.roleCount || 1}
                  onChange={(event) => onAssetFormChange({ ...assetForm, roleCount: event.target.value })}
                  placeholder="例如：4"
                />
              </label>
            ) : null}
            <label>
              目标时长
              <select value={assetForm.targetDurationMode || "source"} onChange={(event) => onAssetFormChange({ ...assetForm, targetDurationMode: event.target.value })}>
                <option value="source">跟随原视频时长</option>
                <option value="custom">自定义目标时长</option>
              </select>
            </label>
            {assetForm.targetDurationMode === "custom" ? (
              <label>
                自定义时长（秒）
                <input
                  type="number"
                  min="30"
                  max="3600"
                  step="5"
                  value={assetForm.targetDurationSeconds || ""}
                  onChange={(event) => onAssetFormChange({ ...assetForm, targetDurationSeconds: event.target.value })}
                  placeholder="例如：1000"
                />
              </label>
            ) : null}
          </div>
        ) : null}
        {type === "role" ? (
          <div className="role-video-config-next">
            <div className="video-analysis-field-grid-next role-image-config-next">
              <label>
                角色数量
                <select value={assetForm.roleCountMode || "auto"} onChange={(event) => onAssetFormChange({ ...assetForm, roleCountMode: event.target.value })}>
                  <option value="auto">默认：AI 提取核心人物</option>
                  <option value="custom">自定义数量</option>
                </select>
              </label>
              {assetForm.roleCountMode === "custom" ? (
                <label>
                  自定义数量
                  <input
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={assetForm.roleCount || 1}
                    onChange={(event) => onAssetFormChange({ ...assetForm, roleCount: event.target.value })}
                    placeholder="例如：2"
                  />
                </label>
              ) : null}
            </div>
            <label className="asset-inline-check-next role-generate-check-next">
              <input
                type="checkbox"
                checked={Boolean(assetForm.generateRoleImages)}
                onChange={(event) => onAssetFormChange({
                  ...assetForm,
                  generateRoleImages: Boolean(event.target.checked),
                  roleImageDesignCount: clampRoleImageDesignCount(assetForm.roleImageDesignCount || 1),
                  roleImageType: normalizeRoleImageType(assetForm.roleImageType),
                  roleImageCustomPrompt: assetForm.roleImageCustomPrompt || "",
                })}
              />
              <span>
                <strong>同时设计并生成角色图</strong>
                <small>默认关闭；勾选后会为每个角色自动生成 1-5 套参考图。</small>
              </span>
            </label>
            {assetForm.generateRoleImages ? (
              <>
                <div className="role-image-type-grid-next" role="radiogroup" aria-label="角色图片类型">
                  {roleImageTypeOptions.map((option) => {
                    const selected = normalizeRoleImageType(assetForm.roleImageType) === option.id;
                    return (
                      <button className={selected ? "selected" : ""} type="button" role="radio" aria-checked={selected} onClick={() => onAssetFormChange({ ...assetForm, roleImageType: option.id })} key={option.id}>
                        <strong>{option.title}</strong>
                        <span>{option.desc}</span>
                      </button>
                    );
                  })}
                </div>
                {normalizeRoleImageType(assetForm.roleImageType) === "custom" ? (
                  <label className="role-image-custom-prompt-next">
                    自定义角色图要求
                    <textarea
                      value={assetForm.roleImageCustomPrompt || ""}
                      onChange={(event) => onAssetFormChange({ ...assetForm, roleImageCustomPrompt: event.target.value })}
                      rows={3}
                      placeholder="例如：现代商务单人全身照，正常清晰人脸，纯灰白摄影棚背景；如果需要三视图或马赛克请在这里明确写出。"
                    />
                  </label>
                ) : null}
                <div className="video-analysis-field-grid-next role-image-config-next">
                  <label>
                    每个角色生成几套设计
                    <select value={clampRoleImageDesignCount(assetForm.roleImageDesignCount || 1)} onChange={(event) => onAssetFormChange({ ...assetForm, roleImageDesignCount: clampRoleImageDesignCount(event.target.value) })}>
                      {[1, 2, 3, 4, 5].map((count) => (
                        <option value={count} key={count}>{count} 套</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    绘画渠道
                    <select value={assetForm.imageKeyId || ""} onChange={(event) => updateImageKey(event.target.value)}>
                      <option value="">请选择绘画渠道</option>
                      {imageKeys.map((key) => (
                        <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    绘画模型
                    <select value={assetForm.imageModelId || defaultRoleImageModel} onChange={(event) => updateImageModel(event.target.value)} disabled={!assetForm.imageKeyId}>
                      {imageModels.length ? imageModels.map((model) => (
                        <option value={model.id} key={model.id}>{model.name}</option>
                      )) : <option value={defaultRoleImageModel}>{defaultRoleImageModel}</option>}
                    </select>
                  </label>
                  <label>
                    画面比例
                    <select value={assetForm.imageRatio || "1:1"} onChange={(event) => onAssetFormChange({ ...assetForm, imageRatio: event.target.value })} disabled={!assetForm.imageKeyId}>
                      {(activeImageModel?.ratios || [{ value: "1:1", label: "正方形" }]).map((ratio) => (
                        <option value={ratio.value} key={ratio.value}>{ratio.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    清晰度
                    <select value={assetForm.imageResolution || "1k"} onChange={(event) => onAssetFormChange({ ...assetForm, imageResolution: event.target.value })} disabled={!assetForm.imageKeyId}>
                      {(activeImageModel?.resolutions || ["1k"]).map((resolution) => (
                        <option value={resolution} key={resolution}>{resolution}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    输出格式
                    <select value={assetForm.imageFormat || "png"} onChange={(event) => onAssetFormChange({ ...assetForm, imageFormat: event.target.value })} disabled={!assetForm.imageKeyId}>
                      {(activeImageModel?.formats || ["png"]).map((format) => (
                        <option value={format} key={format}>{format}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {supportsYoutubeSource ? (
          <div className="video-source-selector-next">
            <span>视频来源</span>
            <div className="asset-entry-mode-tabs-next" role="tablist" aria-label="视频来源">
              <button type="button" className={videoSourceMode === "upload" ? "active" : ""} onClick={() => updateVideoSourceMode("upload")}>本地上传</button>
              <button type="button" className={videoSourceMode === "youtube" ? "active" : ""} onClick={() => updateVideoSourceMode("youtube")}>YouTube 链接</button>
            </div>
          </div>
        ) : null}
        {videoSourceMode === "youtube" ? (
          <label className="youtube-video-url-field-next">
            <span>YouTube 视频链接</span>
            <input
              type="text"
              inputMode="url"
              value={assetForm.youtubeUrl || ""}
              onChange={(event) => onAssetFormChange({ ...assetForm, youtubeUrl: event.target.value, fileError: "" })}
              placeholder="https://www.youtube.com/watch?v=..."
              autoComplete="off"
            />
            <small>仅支持公开的 YouTube 视频；私密和不公开列出的视频无法解析。需使用 Gemini 模型。</small>
            {assetForm.fileError ? <em>{assetForm.fileError}</em> : null}
          </label>
        ) : (
          <label className="video-analysis-upload-field-next">
            <span>{copy.fileLabel}</span>
            <span className="video-analysis-upload-control-next">
              <strong>{file ? file.name : assetForm.id ? "可重新选择视频" : "选择视频"}</strong>
              <small>
                {file
                  ? `${formatBytes(file.size)}${assetForm.videoDurationSeconds ? ` · ${formatVideoDuration(assetForm.videoDurationSeconds)}` : ""}`
                  : assetForm.sourceFile?.name || "MP4 / MOV / WEBM，20M 以内"}
              </small>
            </span>
            {assetForm.fileError ? <em>{assetForm.fileError}</em> : null}
            <input
              type="file"
              accept={copy.accept}
              onChange={(event) => {
                handleVideoSelection(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
        )}
        {hasValidSavedAnalysis ? (
          <div className="video-analysis-status-next">
            <strong>已有分析结果</strong>
            <span>分析结果已保存，完整内容不会在卡片列表外显。</span>
          </div>
        ) : null}
        <AssetTeamShareField
          value={assetForm.shared}
          teamContext={teamContext}
          onChange={(shared) => onAssetFormChange({ ...assetForm, shared })}
        />
        <div className="asset-form-actions">
          <button className="secondary-action" type="button" onClick={onCancelAsset} disabled={saving}>
            取消
          </button>
          <button className="primary-action compact" type="submit" disabled={saving}>
            {saving
              ? "分析中..."
              : videoSourceMode === "youtube"
                ? "添加并分析"
                : assetForm.id && !file && hasValidSavedAnalysis ? "保存" : "上传并分析"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ProductAnalysisDetailPanel({ assetForm, groups = [], canManageGroups = false, teamContext, busyAction, onSaveProfile, onAssetFormChange, onPreviewImage, onReanalyze, onSwitchToVideo, onCancelAsset, showModeSwitch = false }) {
  const [fields, setFields] = useState(() => assetForm.entryMode === "manual" && !assetForm.id ? emptyProductProfileFields() : productProfileFromAsset(assetForm));
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState("");
  const [saveFeedback, setSaveFeedback] = useState({ type: "", message: "" });
  const fileInputRef = useRef(null);
  const saving = busyAction === "save-asset";
  const productImageUrl = resolveFlowStudioFileUrl(fields.productImageUrl || "");
  const productThumbnailUrl = resolveFlowStudioFileUrl(fields.productImageThumbnailUrl || "") || productImageUrl;

  useEffect(() => {
    setSaveFeedback({ type: "", message: "" });
  }, [assetForm.id]);

  function updateField(key, value) {
    setFields((current) => ({ ...current, [key]: value }));
    if (saveFeedback.type === "error") setSaveFeedback({ type: "", message: "" });
  }

  async function handleProductImage(files) {
    const file = Array.from(files || []).find((item) => item?.type?.startsWith("image/"));
    if (!file) {
      setImageError("请选择一张产品图片。");
      return;
    }
    setImageUploading(true);
    setImageError("");
    try {
      const result = await uploadAssetFiles([file]);
      const uploaded = normalizeUploadedFile(Array.isArray(result.files) ? result.files[0] : null);
      const imageUrl = resolveFlowStudioFileUrl(uploaded?.url || "");
      if (!imageUrl) throw new Error("图片已上传，但没有返回可用地址。");
      setFields((current) => ({
        ...current,
        productImageUrl: uploaded.url || imageUrl,
        productImageThumbnailUrl: uploaded.thumbnailUrl || "",
        productImageKey: uploaded.key || "",
        productImageName: uploaded.originalName || file.name || "产品图片",
        productImageMimeType: uploaded.mimeType || file.type || "",
        productImageSizeBytes: Number(uploaded.sizeBytes || file.size || 0),
      }));
    } catch (error) {
      setImageError(error.message || "产品图片上传失败。");
    } finally {
      setImageUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function clearProductImage() {
    setFields((current) => ({
      ...current,
      productImageUrl: "",
      productImageThumbnailUrl: "",
      productImageKey: "",
      productImageName: "",
      productImageMimeType: "",
      productImageSizeBytes: 0,
    }));
    setImageError("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const nextFields = normalizeProductProfileFields(fields, assetForm.name || "");
    const productName = nextFields.productName && nextFields.productName !== "视频未提及" ? nextFields.productName : "";
    if (!productName) {
      setSaveFeedback({ type: "error", message: "请填写产品名称。" });
      return;
    }
    setSaveFeedback({ type: "loading", message: "正在保存产品资料..." });
    try {
      const result = await onSaveProfile?.(nextFields);
      if (result?.ok === false) {
        setSaveFeedback({ type: "error", message: result.message || "产品资料保存失败。" });
      }
    } catch (error) {
      setSaveFeedback({ type: "error", message: error.message || "产品资料保存失败。" });
    }
  }

  return (
    <section className="asset-crud-panel">
      <form className="product-analysis-detail-next" onSubmit={handleSubmit}>
        <div className="product-analysis-detail-head-next">
          <h4>{fields.productName || assetForm.name || "带货产品资料"}</h4>
          <span>以下为带货产品资料，可直接修改每个字段后保存。</span>
        </div>
        {showModeSwitch ? (
          <div className="asset-entry-mode-tabs-next" role="tablist" aria-label="产品添加方式">
            <button type="button" className={assetForm.entryMode !== "manual" ? "active" : ""} onClick={onSwitchToVideo}>
              视频提取
            </button>
            <button type="button" className={assetForm.entryMode === "manual" ? "active" : ""}>
              手动录入
            </button>
          </div>
        ) : null}
        {canManageGroups ? (
          <div className="product-profile-top-grid-next">
            <span aria-hidden="true"></span>
            <label className="product-profile-group-field-next">
              保存分组
              <select value={assetForm.groupId || ""} onChange={(event) => onAssetFormChange?.({ ...assetForm, groupId: event.target.value })}>
                <option value="">未分组</option>
                {groups.map((group) => (
                  <option value={group.id} key={group.id}>{group.name}</option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        <div className="product-profile-layout-next">
          <div className="product-image-panel-next">
            <div className="product-image-head-next">
              <span>产品图片</span>
              {fields.productImageName ? <small>{fields.productImageName}</small> : null}
            </div>
            {productImageUrl ? (
              <div className="product-image-preview-next">
                <img src={productThumbnailUrl} alt={fields.productName || "产品图片"} loading="lazy" />
                <div className="product-image-overlay-next">
                  <button className="workflow-shot-overlay-action-next preview" type="button" onClick={() => onPreviewImage?.({ fileUrl: productImageUrl, name: fields.productImageName || fields.productName || "产品图片" })}>
                    预览
                  </button>
                  <button className="workflow-shot-overlay-action-next regenerate" type="button" onClick={() => fileInputRef.current?.click()} disabled={imageUploading}>
                    替换
                  </button>
                  <button className="workflow-shot-overlay-action-next danger" type="button" onClick={clearProductImage}>
                    删除
                  </button>
                </div>
              </div>
            ) : (
              <button className="product-image-upload-next" type="button" onClick={() => fileInputRef.current?.click()} disabled={imageUploading}>
                <strong>{imageUploading ? "上传中..." : "上传产品图片"}</strong>
                <span>只能上传 1 张图片</span>
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => handleProductImage(event.target.files)} />
            {imageError ? <p className="product-image-error-next">{imageError}</p> : null}
          </div>
          <div className="product-analysis-grid-next editable product-profile-fields-next">
            {productAnalysisFieldDefinitions.map((field) => (
              <label className={field.long ? "long" : ""} key={field.key}>
                <span>{field.label}</span>
                <textarea
                  value={fields[field.key] || ""}
                  onChange={(event) => updateField(field.key, event.target.value)}
                  rows={1}
                  placeholder="视频未提及"
                />
              </label>
            ))}
          </div>
        </div>
        <AssetTeamShareField
          value={assetForm.shared}
          teamContext={teamContext}
          onChange={(shared) => onAssetFormChange?.({ ...assetForm, shared })}
        />
        <div className="asset-form-actions product-analysis-actions-next">
          <button className="secondary-action" type="button" onClick={onCancelAsset}>
            关闭
          </button>
          {assetForm.id ? (
          <button className="secondary-action" type="button" onClick={onReanalyze}>
            重新上传分析
          </button>
          ) : null}
          <button className="primary-action compact" type="submit" disabled={saving}>
            {saving ? "保存中..." : "保存资料"}
          </button>
        </div>
        {saveFeedback.message ? (
          <p className={`product-save-feedback-next ${saveFeedback.type}`.trim()}>{saveFeedback.message}</p>
        ) : null}
      </form>
    </section>
  );
}

function RoleAnalysisDetailPanel({ assetForm, apiKeys, teamContext, busyAction, onSaveProfile, onAssetFormChange, onPreviewImage, onReanalyze, onCancelAsset }) {
  const [profiles, setProfiles] = useState(() => roleProfilesFromAsset(assetForm));
  const fileInputRefs = useRef({});
  const imageKeys = apiKeysForService(apiKeys, "image");
  const initialImageKeyId = assetForm.imageKeyId || imageKeys[0]?.id || "";
  const initialImageModels = roleImageModelOptions(imageKeys.find((key) => key.id === initialImageKeyId));
  const initialImageModel = initialImageModels.find((model) => model.id === assetForm.imageModelId || model.modelId === assetForm.imageModelId) || initialImageModels[0] || null;
  const [imageSettings, setImageSettings] = useState(() => ({
    imageKeyId: initialImageKeyId,
    imageModelId: initialImageModel?.id || assetForm.imageModelId || defaultRoleImageModel,
    imageRatio: assetForm.imageRatio || initialImageModel?.ratios?.[0]?.value || "1:1",
    imageResolution: assetForm.imageResolution || initialImageModel?.resolutions?.[0] || "1k",
    imageFormat: assetForm.imageFormat || initialImageModel?.formats?.[0] || "png",
  }));
  const [regeneratingImageIds, setRegeneratingImageIds] = useState([]);
  const [uploadingRoleIndexes, setUploadingRoleIndexes] = useState([]);
  const [imagePanelError, setImagePanelError] = useState("");
  const saving = busyAction === "save-asset";
  const selectedImageKey = imageKeys.find((key) => key.id === imageSettings.imageKeyId) || null;
  const imageModels = roleImageModelOptions(selectedImageKey);
  const activeImageModel = imageModels.find((model) => model.id === imageSettings.imageModelId || model.modelId === imageSettings.imageModelId) || imageModels[0] || null;

  function updateProfile(index, key, value) {
    setProfiles((current) => current.map((profile, profileIndex) => (
      profileIndex === index ? { ...profile, [key]: value } : profile
    )));
  }

  function updateImageKey(imageKeyId) {
    const key = imageKeys.find((item) => item.id === imageKeyId);
    const nextModels = roleImageModelOptions(key);
    const nextModel = nextModels[0] || null;
    setImageSettings({
      imageKeyId,
      imageModelId: nextModel?.id || defaultRoleImageModel,
      imageRatio: nextModel?.ratios?.[0]?.value || "1:1",
      imageResolution: nextModel?.resolutions?.[0] || "1k",
      imageFormat: nextModel?.formats?.[0] || "png",
    });
  }

  function updateImageModel(imageModelId) {
    const nextModel = imageModels.find((model) => model.id === imageModelId || model.modelId === imageModelId) || imageModels[0] || null;
    setImageSettings((current) => ({
      ...current,
      imageModelId,
      imageRatio: nextModel?.ratios?.some((ratio) => ratio.value === current.imageRatio) ? current.imageRatio : nextModel?.ratios?.[0]?.value || "1:1",
      imageResolution: nextModel?.resolutions?.includes(current.imageResolution) ? current.imageResolution : nextModel?.resolutions?.[0] || "1k",
      imageFormat: nextModel?.formats?.includes(current.imageFormat) ? current.imageFormat : nextModel?.formats?.[0] || "png",
    }));
  }

  function updateImageSetting(key, value) {
    setImageSettings((current) => ({ ...current, [key]: value }));
  }

  function addRoleProfile() {
    setProfiles((current) => [
      ...current,
      {
        name: `角色${current.length + 1}`,
        traits: "",
        realisticImagePrompt: "",
        roleImages: [],
        defaultImageId: "",
        imageUrl: "",
        thumbnailUrl: "",
        imageError: "",
      },
    ]);
  }

  function deleteRoleProfile(index) {
    setProfiles((current) => current.filter((_, profileIndex) => profileIndex !== index));
  }

  function syncProfileImages(profile = {}, images = [], defaultImageId = "") {
    return normalizeRoleProfileFields({
      ...profile,
      roleImages: images,
      defaultImageId,
      imageUrl: "",
      thumbnailUrl: "",
      imageError: "",
    }, profile.name || "");
  }

  function updateRoleImages(roleIndex, updater) {
    setProfiles((current) => current.map((profile, profileIndex) => {
      if (profileIndex !== roleIndex) return profile;
      const currentImages = Array.isArray(profile.roleImages) ? profile.roleImages : [];
      const nextImages = typeof updater === "function" ? updater(currentImages, profile) : currentImages;
      const defaultImageId = nextImages.find((item) => item.isDefault)?.id || nextImages[0]?.id || "";
      return syncProfileImages(profile, nextImages.map((item) => ({ ...item, isDefault: item.id === defaultImageId })), defaultImageId);
    }));
  }

  function updateRoleImageField(roleIndex, imageId, key, value) {
    updateRoleImages(roleIndex, (images) => images.map((image) => (
      image.id === imageId ? { ...image, [key]: value, updatedAt: new Date().toISOString() } : image
    )));
  }

  function setDefaultRoleImage(roleIndex, imageId) {
    updateRoleImages(roleIndex, (images) => images.map((image) => ({ ...image, isDefault: image.id === imageId })));
  }

  function deleteRoleImage(roleIndex, imageId) {
    updateRoleImages(roleIndex, (images) => images.filter((image) => image.id !== imageId));
  }

  async function regenerateRoleImage(roleIndex, imageId) {
    const profile = profiles[roleIndex];
    const roleImage = (profile?.roleImages || []).find((image) => image.id === imageId);
    if (!profile || !roleImage || regeneratingImageIds.includes(imageId)) return;
    const prompt = String(roleImage.prompt || profile.realisticImagePrompt || "").trim();
    setRegeneratingImageIds((current) => current.includes(imageId) ? current : [...current, imageId]);
    updateRoleImageField(roleIndex, imageId, "imageError", "");
    try {
      const nextRoleImage = await generateRoleProfileImage({
        profile,
        prompt,
        imageKeyId: imageSettings.imageKeyId,
        imageModelId: imageSettings.imageModelId,
        imageRatio: imageSettings.imageRatio,
        imageResolution: imageSettings.imageResolution,
        imageFormat: imageSettings.imageFormat,
      });
      updateRoleImages(roleIndex, (images) => images.map((image) => (
        image.id === imageId ? {
          ...image,
          source: "generated",
          prompt,
          imageUrl: nextRoleImage.imageUrl || "",
          thumbnailUrl: nextRoleImage.thumbnailUrl || "",
          imageError: "",
          status: "done",
          imageKeyId: imageSettings.imageKeyId,
          imageModelId: imageSettings.imageModelId,
          imageRatio: imageSettings.imageRatio,
          imageResolution: imageSettings.imageResolution,
          imageFormat: imageSettings.imageFormat,
          updatedAt: new Date().toISOString(),
        } : image
      )));
    } catch (error) {
      updateRoleImages(roleIndex, (images) => images.map((image) => (
        image.id === imageId ? {
          ...image,
          imageUrl: "",
          thumbnailUrl: "",
          imageError: error.message || "角色图片重生失败。",
          status: "error",
          updatedAt: new Date().toISOString(),
        } : image
      )));
    } finally {
      setRegeneratingImageIds((current) => current.filter((item) => item !== imageId));
    }
  }

  async function handleManualRoleImages(roleIndex, fileList) {
    const selected = Array.from(fileList || []).filter((file) => file.type?.startsWith("image/"));
    if (!selected.length) return;
    const currentCount = profiles[roleIndex]?.roleImages?.length || 0;
    const availableSlots = Math.max(0, roleImageTotalMaxCount - currentCount);
    if (!availableSlots) {
      setImagePanelError("每个角色最多保留 10 张角色图。");
      return;
    }
    const files = selected.slice(0, availableSlots);
    setImagePanelError("");
    setUploadingRoleIndexes((current) => current.includes(roleIndex) ? current : [...current, roleIndex]);
    try {
      const result = await uploadAssetFiles(files);
      const uploadedFiles = Array.isArray(result.files) ? result.files.map(normalizeUploadedFile).filter(Boolean) : [];
      const now = new Date().toISOString();
      updateRoleImages(roleIndex, (images) => {
        const startIndex = images.length;
        const manualImages = uploadedFiles.map((file, index) => normalizeRoleImageItem({
          id: crypto.randomUUID(),
          source: "manual",
          designIndex: startIndex + index + 1,
          imageUrl: file.url || "",
          thumbnailUrl: file.thumbnailUrl || "",
          note: "",
          status: "done",
          createdAt: now,
          updatedAt: now,
          isDefault: images.length === 0 && index === 0,
        }, startIndex + index, ""));
        return [...images, ...manualImages].slice(0, roleImageTotalMaxCount);
      });
      if (selected.length > files.length) setImagePanelError(`已添加 ${files.length} 张，单个角色总数最多 10 张。`);
    } catch (error) {
      setImagePanelError(error.message || "角色图片上传失败。");
    } finally {
      setUploadingRoleIndexes((current) => current.filter((item) => item !== roleIndex));
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    onSaveProfile(profiles, imageSettings);
  }

  return (
    <section className="asset-crud-panel">
      <form className="product-analysis-detail-next role-analysis-detail-next" onSubmit={handleSubmit}>
        <div className="product-analysis-detail-head-next">
          <label className="role-asset-name-field-next">
            <span>角色库名称</span>
            <input
              value={assetForm.name || ""}
              onChange={(event) => onAssetFormChange?.({ ...assetForm, name: event.target.value })}
              placeholder={profiles[0]?.name || "角色资料"}
            />
          </label>
          <span>以下为视频提取出的 {profiles.length} 个角色，可修改字段后保存。</span>
          <button className="secondary-action compact role-add-action-next" type="button" onClick={addRoleProfile}>
            新增角色
          </button>
        </div>
        <div className="role-image-toolbar-next">
          <label>
            绘画渠道
            <select value={imageSettings.imageKeyId || ""} onChange={(event) => updateImageKey(event.target.value)}>
              <option value="">请选择绘画渠道</option>
              {imageKeys.map((key) => (
                <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
              ))}
            </select>
          </label>
          <label>
            绘画模型
            <select value={imageSettings.imageModelId || defaultRoleImageModel} onChange={(event) => updateImageModel(event.target.value)} disabled={!imageSettings.imageKeyId}>
              {imageModels.length ? imageModels.map((model) => (
                <option value={model.id} key={model.id}>{model.name}</option>
              )) : <option value={defaultRoleImageModel}>{defaultRoleImageModel}</option>}
            </select>
          </label>
          <label>
            画面比例
            <select value={imageSettings.imageRatio || "1:1"} onChange={(event) => updateImageSetting("imageRatio", event.target.value)} disabled={!imageSettings.imageKeyId}>
              {(activeImageModel?.ratios || [{ value: "1:1", label: "正方形" }]).map((ratio) => (
                <option value={ratio.value} key={ratio.value}>{ratio.label}</option>
              ))}
            </select>
          </label>
          <label>
            清晰度
            <select value={imageSettings.imageResolution || "1k"} onChange={(event) => updateImageSetting("imageResolution", event.target.value)} disabled={!imageSettings.imageKeyId}>
              {(activeImageModel?.resolutions || ["1k"]).map((resolution) => (
                <option value={resolution} key={resolution}>{resolution}</option>
              ))}
            </select>
          </label>
          <label>
            格式
            <select value={imageSettings.imageFormat || "png"} onChange={(event) => updateImageSetting("imageFormat", event.target.value)} disabled={!imageSettings.imageKeyId}>
              {(activeImageModel?.formats || ["png"]).map((format) => (
                <option value={format} key={format}>{format}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="role-analysis-list-next">
          {profiles.map((profile, index) => {
            const roleImages = Array.isArray(profile.roleImages) ? profile.roleImages : [];
            const canAddImages = roleImages.length < roleImageTotalMaxCount;
            const uploading = uploadingRoleIndexes.includes(index);
            return (
              <article className="role-analysis-item-next" key={`role-profile-${index}`}>
                <div className="role-analysis-item-head-next">
                  <div>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{profile.name || `角色${index + 1}`}</strong>
                    <small>{roleImages.length}/{roleImageTotalMaxCount} 张角色图</small>
                  </div>
                  <button className="secondary-action compact role-delete-action-next" type="button" onClick={() => deleteRoleProfile(index)}>
                    删除角色
                  </button>
                </div>
                <div className="product-analysis-grid-next editable role-analysis-fields-next">
                  <label>
                    <span>角色名字</span>
                    <textarea value={profile.name || ""} onChange={(event) => updateProfile(index, "name", event.target.value)} rows={1} placeholder="角色名字或代号" />
                  </label>
                  <label>
                    <span>角色定义</span>
                    <textarea value={profile.traits || ""} onChange={(event) => updateProfile(index, "traits", event.target.value)} rows={2} placeholder="身份、性格和行为描述" />
                  </label>
                  <label>
                    <span>角色绘画提示词</span>
                    <textarea value={profile.realisticImagePrompt || ""} onChange={(event) => updateProfile(index, "realisticImagePrompt", event.target.value)} rows={2} placeholder={roleImagePromptExample} />
                  </label>
                </div>
                <div className="role-image-gallery-next">
                  <div className="role-image-gallery-head-next">
                    <strong>参考图片</strong>
                    <span>{roleImages.length ? "点击图片可设为默认图，左上角标记当前默认。" : "暂无角色图片，可手动添加。"}</span>
                  </div>
                  <div className="role-image-thumbs-next">
                    {roleImages.map((image, imageIndex) => {
                      const imageUrl = resolveFlowStudioFileUrl(image.imageUrl || "");
                      const thumbUrl = resolveFlowStudioFileUrl(image.thumbnailUrl || "") || imageUrl;
                      const isDefault = image.id === profile.defaultImageId || image.isDefault;
                      return (
                        <div className={`role-image-thumb-next ${isDefault ? "default" : ""} ${image.imageError && !imageUrl ? "error" : ""}`} key={image.id || imageIndex}>
                          <button type="button" onClick={() => setDefaultRoleImage(index, image.id)} aria-label="设为默认角色图">
                            {imageUrl ? <img src={thumbUrl} alt={`${profile.name || "角色"}参考图 ${imageIndex + 1}`} loading="lazy" /> : <span>{image.imageError || roleImagePendingText(image)}</span>}
                            {isDefault ? <b>默认</b> : null}
                          </button>
                          <div>
                            {imageUrl ? (
                              <button type="button" onClick={() => onPreviewImage?.({ fileUrl: imageUrl, name: `${profile.name || "角色"}参考图 ${imageIndex + 1}` })}>
                                预览
                              </button>
                            ) : null}
                            <button className="danger" type="button" onClick={() => deleteRoleImage(index, image.id)}>
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {canAddImages ? (
                      <button className="role-image-add-next" type="button" onClick={() => fileInputRefs.current[index]?.click()} disabled={uploading}>
                        <strong>{uploading ? "上传中" : "+"}</strong>
                        <span>{uploading ? "请稍候" : "手动添加"}</span>
                      </button>
                    ) : null}
                    <input
                      ref={(node) => {
                        fileInputRefs.current[index] = node;
                      }}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(event) => {
                        handleManualRoleImages(index, event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </div>
                </div>
                <div className="role-image-records-next">
                  {roleImages.length ? roleImages.map((image, imageIndex) => {
                    const imageUrl = resolveFlowStudioFileUrl(image.imageUrl || "");
                    const thumbUrl = resolveFlowStudioFileUrl(image.thumbnailUrl || "") || imageUrl;
                    const regenerating = regeneratingImageIds.includes(image.id);
                    const isGenerated = image.source !== "manual";
                    const isDefault = image.id === profile.defaultImageId || image.isDefault;
                    return (
                      <article className={`role-image-record-next ${image.imageError && !imageUrl ? "error" : ""}`} key={image.id || imageIndex}>
                        <div className="role-image-record-meta-next">
                          <span>{isGenerated ? image.variantLabel || `设计 ${image.designIndex || imageIndex + 1}` : `手动图 ${imageIndex + 1}`}</span>
                          <b>{roleImageRecordStatusLabel(image, imageUrl)}</b>
                          {isDefault ? <em>默认图</em> : null}
                          {image.imageModelId ? <small>{image.imageModelId}</small> : null}
                        </div>
                        {imageUrl ? (
                          <button className="role-image-record-preview-next" type="button" onClick={() => onPreviewImage?.({ fileUrl: imageUrl, name: `${profile.name || "角色"}参考图 ${imageIndex + 1}` })}>
                            <img src={thumbUrl} alt={`${profile.name || "角色"}参考图 ${imageIndex + 1}`} loading="lazy" />
                          </button>
                        ) : (
                          <div className="role-image-record-preview-next empty">
                            <span>{image.imageError || roleImagePendingText(image)}</span>
                          </div>
                        )}
                        <label>
                          <span>{isGenerated ? "生成提示词" : "备注 / 描述"}</span>
                          <textarea
                            value={isGenerated ? image.prompt || "" : image.note || ""}
                            onChange={(event) => updateRoleImageField(index, image.id, isGenerated ? "prompt" : "note", event.target.value)}
                            rows={2}
                            placeholder={isGenerated ? roleImagePromptExample : "说明这张手动图的造型、用途或来源"}
                          />
                        </label>
                        <div className="role-image-record-actions-next">
                          {isGenerated ? (
                            <button className="secondary-action compact" type="button" disabled={!imageSettings.imageKeyId || regenerating} onClick={() => regenerateRoleImage(index, image.id)}>
                              {regenerating ? "生成中" : "编辑并重新生成"}
                            </button>
                          ) : null}
                          <button className="secondary-action compact role-delete-action-next" type="button" onClick={() => deleteRoleImage(index, image.id)}>
                            删除
                          </button>
                        </div>
                      </article>
                    );
                  }) : (
                    <p className="role-image-empty-next">这个角色当前没有参考图。</p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {imagePanelError ? <p className="product-image-error-next">{imagePanelError}</p> : null}
        <AssetTeamShareField
          value={assetForm.shared}
          teamContext={teamContext}
          onChange={(shared) => onAssetFormChange?.({ ...assetForm, shared })}
        />
        <div className="asset-form-actions product-analysis-actions-next">
          <button className="secondary-action" type="button" onClick={onCancelAsset}>
            关闭
          </button>
          <button className="secondary-action" type="button" onClick={onReanalyze}>
            重新上传分析
          </button>
          <button className="primary-action compact" type="submit" disabled={saving}>
            {saving ? "保存中..." : "保存资料"}
          </button>
        </div>
      </form>
    </section>
  );
}

const productAnalysisFieldDefinitions = [
  { key: "productName", label: "产品名称", aliases: ["核心产品", "商品名称", "产品"] },
  { key: "highlights", label: "产品亮点", long: true, aliases: ["核心卖点", "卖点", "产品卖点", "产品特点"] },
  { key: "effects", label: "使用效果", long: true, aliases: ["效果", "产品效果", "功效", "解决效果"] },
  { key: "usageMotion", label: "使用动态描述", long: true, aliases: ["使用动态", "展示动作", "产品展示", "使用过程"] },
  { key: "painPoints", label: "用户痛点", long: true, aliases: ["痛点", "目标痛点", "需求痛点", "剧情冲突"] },
  { key: "audience", label: "面向人群", aliases: ["主要受众", "目标人群", "目标用户", "适用人群"] },
  { key: "priceText", label: "价格文本", aliases: ["价格", "活动价", "价格信息", "优惠信息"] },
];

function ImageLibraryView({ libraries, selectedGroupId, busyAction, onSelectGroup, onEditGroup, onDeleteGroup, onUploadImages, onPreviewImage, onEditImage, onDeleteImage }) {
  const fileInputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const selectedLibrary = libraries.find((library) => library.id === selectedGroupId) || libraries[0] || null;
  const isUploading = selectedLibrary ? busyAction === `upload-images-${selectedLibrary.id}` : false;

  function uploadFiles(files) {
    if (!selectedLibrary) return;
    onUploadImages(selectedLibrary, files);
  }

  return (
    <div className="asset-library-layout">
      <div className="asset-group-list">
        <p className="asset-group-label">图库分组</p>
        {libraries.length ? (
          libraries.map((library) => (
            <article className={`asset-group-card ${selectedLibrary?.id === library.id ? "active" : ""}`} key={library.id}>
              <div>
                <button type="button" onClick={() => onSelectGroup(library.id)}>
                  <strong>{library.name}</strong>
                </button>
              </div>
              <div className="asset-card-actions">
                <span className="asset-count-pill">{library.images.length}</span>
                <button type="button" onClick={() => onEditGroup(library)}>
                  ✎
                </button>
                <button type="button" onClick={() => onDeleteGroup(library)} disabled={busyAction === `delete-group-${library.id}`}>
                  ×
                </button>
              </div>
            </article>
          ))
        ) : (
          <EmptyAsset title="暂无图库" detail="旧前端创建图库后，这里会同步显示。" />
        )}
      </div>

      <section className="asset-library-main-next image-library-detail-next">
        <div className="asset-library-toolbar-next">
          <div>
            <h3>{selectedLibrary?.name || "图片库"}</h3>
            <p>
              {selectedLibrary
                ? `${selectedLibrary.images.length} 张图片 · ${selectedLibrary.desc || "私有图库"}`
                : "创建图库后，可以上传 JPG、PNG、GIF、BMP、WEBP 图片。"}
            </p>
          </div>
          <button className="primary-action compact" type="button" onClick={() => fileInputRef.current?.click()} disabled={!selectedLibrary || isUploading}>
            {isUploading ? "上传中" : "上传图片"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              uploadFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>

        <div
          className={`image-library-dropzone-next ${dragging ? "dragging" : ""} ${!selectedLibrary ? "disabled" : ""} ${isUploading ? "uploading" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => {
            if (selectedLibrary && !isUploading) fileInputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (!["Enter", " "].includes(event.key)) return;
            event.preventDefault();
            if (selectedLibrary && !isUploading) fileInputRef.current?.click();
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            if (selectedLibrary && !isUploading) setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (selectedLibrary && !isUploading) setDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!selectedLibrary || isUploading) return;
            uploadFiles(event.dataTransfer?.files);
          }}
        >
          <div className="dropzone-copy-next">
            <strong>{selectedLibrary ? "拖拽图片到这里" : "先创建图库"}</strong>
            <span>{selectedLibrary ? "或点击上传图片" : "创建图库后即可上传图片"}</span>
          </div>
        </div>

        <div className="image-library-grid-next">
          {selectedLibrary?.images?.length ? (
            selectedLibrary.images.map((image) => {
              const editable = canEditAssetRecord(image);
              return (
                <figure className="asset-image-card" key={image.id}>
                  {image.fileUrl || image.thumbnailUrl ? (
                    <button className="asset-image-preview-button-next" type="button" onClick={() => onPreviewImage?.(image)} aria-label={`预览原图：${image.name}`}>
                      <img src={image.thumbnailUrl || image.fileUrl} alt={image.name} loading="lazy" decoding="async" />
                    </button>
                  ) : (
                    <div className="asset-image-fallback">Image</div>
                  )}
                  <figcaption>
                    <strong>{image.name}</strong>
                    <span>{image.thumbnailUrl ? "WebP 缩略图 · 点击预览原图" : "原图缩略图 · 点击预览"}</span>
                    {editable ? (
                      <div className="asset-image-actions-next">
                        <button type="button" onClick={() => onEditImage(image)}>
                          编辑
                        </button>
                        <button className="danger" type="button" onClick={() => onDeleteImage(image)} disabled={busyAction === `delete-image-${image.id}`}>
                          {busyAction === `delete-image-${image.id}` ? "删除中" : "删除"}
                        </button>
                      </div>
                    ) : null}
                  </figcaption>
                </figure>
              );
            })
          ) : (
            <EmptyAsset title={selectedLibrary ? "图库为空" : "还没有图库"} detail={selectedLibrary ? "上传第一张图片后，可在创作工具中作为参考图导入。" : "请先创建图库分组。"} />
          )}
        </div>
      </section>
    </div>
  );
}

function AssetListView({
  type,
  groups,
  assets,
  selectedGroupId,
  editable = false,
  groupEditable = false,
  busyAction = "",
  onSelectGroup,
  onEditGroup,
  onDeleteGroup,
  onEditAsset,
  onDeleteAsset,
}) {
  if (type === "visual-style") {
    return (
      <div className="visual-style-list-next">
        {assets.length ? (
          assets.map((asset) => (
            <AssetCard
              type={type}
              asset={asset}
              groups={groups}
              editable={editable && canEditAssetRecord(asset)}
              deleting={busyAction === `delete-asset-${asset.id}`}
              onEdit={() => onEditAsset(asset)}
              onDelete={() => onDeleteAsset(asset)}
              key={asset.id}
            />
          ))
        ) : (
          <EmptyAsset title="暂无图风" detail="保存图风后会在这里显示。" />
        )}
      </div>
    );
  }

  const displayGroups = groupedAssetDisplayGroups(type, groups, assets);
  const selectedGroup = displayGroups.find((group) => group.id === selectedGroupId) || displayGroups[0] || null;
  const knownGroupIds = new Set(groups.map((group) => group.id));
  const selectedAssets = selectedGroup
    ? selectedGroup.ungrouped
      ? assets.filter((asset) => !asset.groupId || !knownGroupIds.has(asset.groupId))
      : assets.filter((asset) => asset.groupId === selectedGroup.id)
    : assets.filter((asset) => !asset.groupId || !knownGroupIds.has(asset.groupId));
  const copy = groupedAssetCopy(type);

  return (
    <div className="asset-library-layout">
      <div className="asset-group-list">
        <p className="asset-group-label">{copy.groupName}</p>
        {displayGroups.length ? (
          displayGroups.map((group) => {
            const count = group.ungrouped ? assets.filter((asset) => !asset.groupId || !knownGroupIds.has(asset.groupId)).length : assets.filter((asset) => asset.groupId === group.id).length;
            return (
              <article className={`asset-group-card ${selectedGroup?.id === group.id ? "active" : ""}`} key={group.id}>
                <div>
                  <button type="button" onClick={() => onSelectGroup(group.id)}>
                    <strong>{group.name}</strong>
                  </button>
                </div>
                <div className="asset-card-actions">
                  <span className="asset-count-pill">{count}</span>
                  {groupEditable && !group.ungrouped ? (
                    <>
                      <button type="button" onClick={() => onEditGroup(group)}>
                        ✎
                      </button>
                      <button type="button" onClick={() => onDeleteGroup(group)} disabled={busyAction === `delete-group-${group.id}`}>
                        ×
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            );
          })
        ) : (
          <EmptyAsset title="暂无分组" detail="添加分组后，这里会同步显示。" />
        )}
      </div>

      <section className="asset-library-main-next">
        <div className="asset-library-toolbar-next">
          <div>
            <h3>{selectedGroup?.name || copy.title}</h3>
            <p>
              {selectedGroup
                ? `${selectedAssets.length} 个${copy.unit} · ${selectedGroup.desc || copy.groupDesc}`
                : `添加${copy.groupName}后，可以管理${copy.unit}。`}
            </p>
          </div>
        </div>
        <div className="asset-card-grid asset-card-grid-plain-next">
          {selectedAssets.length ? (
            selectedAssets.map((asset) => (
              <AssetCard
                type={type}
                asset={asset}
                groups={groups}
                editable={editable && canEditAssetRecord(asset)}
                deleting={busyAction === `delete-asset-${asset.id}`}
                onEdit={() => onEditAsset(asset)}
                onDelete={() => onDeleteAsset(asset)}
                key={asset.id}
              />
            ))
          ) : (
            <EmptyAsset title={selectedGroup ? `暂无${copy.unit}` : "暂无分组"} detail={selectedGroup ? `添加${copy.unit}后会在这里显示。` : `先添加${copy.groupName}。`} />
          )}
        </div>
      </section>
    </div>
  );
}

function ungroupedAssetGroupId(type) {
  return `${type || "asset"}-ungrouped`;
}

function groupedAssetDisplayGroups(type, groups, assets) {
  const normalizedGroups = Array.isArray(groups) ? groups : [];
  const normalizedAssets = Array.isArray(assets) ? assets : [];
  const knownGroupIds = new Set(normalizedGroups.map((group) => group.id));
  const ungroupedCount = normalizedAssets.filter((asset) => !asset.groupId || !knownGroupIds.has(asset.groupId)).length;
  if (!ungroupedCount) return normalizedGroups;
  return [
    ...normalizedGroups,
    {
      id: ungroupedAssetGroupId(type),
      name: "未分组",
      desc: "未归入任何自定义分组",
      ungrouped: true,
    },
  ];
}

function AssetCard({ type, asset, groups, editable = false, showEdit = true, deleting = false, onEdit, onDelete }) {
  const group = groups.find((item) => item.id === asset.groupId);
  const isVideoAnalysis = videoAnalysisAssetTypes.has(type);
  const isWritingStyleAnalysis = type === "writing-style" && ["running", "error", "done"].includes(asset.analysisStatus);
  const videoFailed = isVideoAnalysisFailed(asset);
  const detail = group?.name || (isVideoAnalysis ? videoAnalysisStatusLabel(asset) : asset.tag || asset.mimeType || (asset.system ? "系统预设" : "未分组"));
  const preview = previewText(type, asset);
  const ownerLabel = assetOwnerLabel(type, asset);
  const badgeAnimated = isAnimatedAssetBadge(type, asset);

  return (
    <article className={`asset-record-card ${type === "visual-style" ? "wide" : ""} ${isVideoAnalysis ? `video-analysis-card-next ${videoFailed ? "error" : asset.analysisStatus || "idle"}` : ""} ${isWritingStyleAnalysis ? `writing-analysis-card-next ${asset.analysisStatus}` : ""}`}>
      <div className="asset-record-head">
        <div>
          <h4>{asset.name}</h4>
          <p>{detail}</p>
        </div>
        <span className={badgeAnimated ? "asset-status-pill-next active" : "asset-status-pill-next"}>
          {ownerLabel}
          {badgeAnimated ? <AnimatedStatusDots /> : null}
        </span>
      </div>
      {type === "music" && asset.fileUrl ? <audio controls src={asset.fileUrl}></audio> : null}
      {preview ? <p className="asset-record-preview">{preview}</p> : null}
      <div className="asset-record-meta">
        <span>{formatAssetDate(asset.createdAt)}</span>
        <span>{asset.storedOnServer || asset.system ? "可用" : "待同步"}</span>
      </div>
      {editable ? (
        <div className="asset-card-actions">
          {showEdit ? (
            <button type="button" onClick={onEdit}>
              编辑
            </button>
          ) : null}
          <button type="button" onClick={onDelete} disabled={deleting}>
            {deleting ? "删除中" : "删除"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function canEditAssetRecord(asset = {}) {
  if (asset.system) return false;
  if (asset.scope !== "team" && !asset.teamId) return true;
  if (asset.reviewStatus === "approved") return asset.teamRole === "owner";
  return true;
}

function isTeamAssetRecord(asset = {}) {
  return Boolean(asset.teamId || asset.scope === "team" || asset.shared);
}

function AnimatedStatusDots() {
  return (
    <span className="asset-status-dots-next" aria-hidden="true">
      <i></i>
      <i></i>
      <i></i>
    </span>
  );
}

function isAnimatedAssetBadge(type, asset = {}) {
  if (type === "writing-style") return asset.analysisStatus === "running";
  return videoAnalysisAssetTypes.has(type) && (
    asset.analysisStatus === "running" ||
    (type === "role" && asset.analysisStatus === "done" && effectiveRoleImageGenerationStatus(asset) === "running")
  );
}

function assetOwnerLabel(type, asset = {}) {
  if (asset.reviewStatus === "pending") return "待审核";
  if (asset.reviewStatus === "rejected") return "已拒绝";
  if (asset.system) return "系统";
  if (type === "writing-style") {
    if (asset.analysisStatus === "running") return "分析中";
    if (asset.analysisStatus === "error") return "失败";
  }
  if (asset.shared || asset.scope === "team") return "团队";
  if (videoAnalysisAssetTypes.has(type)) return videoAnalysisCardBadge(asset);
  return "个人";
}

function EmptyAsset({ title, detail }) {
  return (
    <article className="asset-empty-card">
      <strong>{title}</strong>
      <span>{detail}</span>
    </article>
  );
}

function assetLibraryMeta(type) {
  if (type === "image-library") return "创建不同类型的图库，手动上传并保存参考图素材。";
  if (type === "music") return "上传并保存可复用的背景音乐、音效和配乐素材。";
  if (type === "prompt") return "按分组保存可复用提示词，可在工作流文案创意配置中导入。";
  if (type === "writing-style") return "上传代表性文章，提取并沉淀可复用的写作风格。写作风格的提取，选择 5-10 篇文章为佳。";
  if (type === "visual-style") return "管理图片生成风格。系统预设不可删除，自定义风格会自动应用到图片提示词中。";
  if (type === "script") return "沉淀对标视频的脚本结构、节奏、转折和 CTA，用于带货视频工作流复用。";
  if (type === "role") return "管理主播、人物、口播角色和镜头表现，作为带货视频的表达主体。";
  if (type === "hook") return "保存可复用的爆款开头、钩子逻辑和前 3 秒表达模板。";
  if (type === "element") return "管理痛点放大、反差对比、用户证言、价格锚点等爆款元素。";
  if (type === "product") return "保存带货产品的卖点、使用场景、目标人群和合规约束。";
  return "管理可复用创意资产。";
}

function assetActionLabel(type) {
  if (type === "image-library") return "+ 创建图库";
  if (type === "music") return "+ 添加分组";
  if (type === "visual-style") return "+ 新建风格";
  if (type === "prompt") return "+ 添加提示词";
  if (type === "writing-style") return "+ 添加文风";
  if (type === "script") return "+ 添加脚本";
  if (type === "role") return "+ 添加角色";
  if (type === "hook") return "+ 添加开头";
  if (type === "element") return "+ 添加元素";
  if (type === "product") return "+ 添加产品";
  return "+ 添加资产";
}

function groupDialogTitle(type, editing) {
  if (type === "image-library") return editing ? "编辑图库" : "创建图库";
  if (type === "music") return editing ? "编辑音乐分组" : "添加音乐分组";
  if (type === "prompt") return editing ? "编辑提示词分组" : "添加提示词分组";
  if (type === "writing-style") return editing ? "编辑文风分组" : "添加文风分组";
  if (type === "script") return editing ? "编辑脚本分组" : "添加脚本分组";
  if (type === "role") return editing ? "编辑角色分组" : "添加角色分组";
  if (type === "hook") return editing ? "编辑开头分组" : "添加开头分组";
  if (type === "element") return editing ? "编辑元素分组" : "添加元素分组";
  if (type === "product") return editing ? "编辑产品分组" : "添加产品分组";
  return editing ? "编辑分组" : "添加分组";
}

function assetDialogTitle(type, editing) {
  if (type === "visual-style") return editing ? "编辑风格" : "新建风格";
  if (type === "prompt") return editing ? "编辑提示词" : "添加提示词";
  if (type === "writing-style") return "修改文风";
  if (type === "script") return editing ? "编辑脚本资产" : "添加脚本资产";
  if (type === "role") return editing ? "编辑角色资产" : "添加角色资产";
  if (type === "hook") return editing ? "编辑爆款开头" : "添加爆款开头";
  if (type === "element") return editing ? "编辑爆款元素" : "添加爆款元素";
  if (type === "product") return editing ? "编辑带货产品" : "添加带货产品";
  return editing ? "编辑资产" : "添加资产";
}

function assetFormTitle(type, editing) {
  if (type === "visual-style") return editing ? "编辑风格" : "新建风格";
  if (type === "prompt") return editing ? "编辑提示词" : "添加提示词";
  if (type === "writing-style") return "修改文风";
  if (type === "script") return editing ? "编辑脚本资产" : "添加脚本资产";
  if (type === "role") return editing ? "编辑角色资产" : "添加角色资产";
  if (type === "hook") return editing ? "编辑爆款开头" : "添加爆款开头";
  if (type === "element") return editing ? "编辑爆款元素" : "添加爆款元素";
  if (type === "product") return editing ? "编辑带货产品" : "添加带货产品";
  return editing ? "编辑资产" : "添加资产";
}

function assetNamePlaceholder(type) {
  if (type === "visual-style") return "如：3D动画超写实风格";
  if (type === "prompt") return "例如：长视频口播禁用句式";
  if (type === "writing-style") return "输入文风名称";
  if (type === "script") return "例如：测评类对标脚本结构";
  if (type === "role") return "例如：理性测评主播";
  if (type === "hook") return "例如：用了 3 年才发现";
  if (type === "element") return "例如：价格锚点 + 前后对比";
  if (type === "product") return "例如：便携式蒸汽挂烫机";
  return "输入资产名称";
}

function assetFormSaveLabel(type, editing, assetLabel) {
  if (type === "writing-style") return "保存修改";
  if (type === "visual-style" || type === "prompt") return "保存";
  return editing ? "保存修改" : `保存${assetLabel}`;
}

function deleteGroupDialogTitle(type) {
  if (type === "image-library") return "删除图库";
  if (type === "music") return "删除音乐分组";
  if (type === "prompt") return "删除提示词分组";
  if (type === "writing-style") return "删除文风分组";
  return "删除分组";
}

function deleteGroupDialogSummary(type, group) {
  const name = group?.name || "未命名分组";
  if (type === "image-library") return `确定删除“${name}”图库吗？图库内图片会变为未分组。`;
  if (type === "music") return `确定删除“${name}”音乐分组吗？分组内音频会变为未分组。`;
  return `确定删除“${name}”分组吗？分组内资产会变为未分组。`;
}

function deleteGroupDialogHint(type) {
  if (type === "image-library") return "删除图库不会自动删除已生成的历史图片文件，但会移除这个分组。";
  if (type === "music") return "删除分组后，音频记录会保留但不再归属于该分组。";
  return "删除分组后，组内资产会保留但不再归属于该分组。";
}

function groupPanelCopy(kind) {
  const copies = {
    image: {
      createTitle: "创建图库",
      editTitle: "编辑图库",
      nameLabel: "图库分组名称",
      descLabel: "图库说明",
      namePlaceholder: "例如：KPOP剧情、产品参考、人物角色",
      help: "用于整理图片资产；创作工具中的参考图、首帧图可以从这里导入。",
      saveLabel: "保存图库",
    },
    music: {
      createTitle: "添加音乐分组",
      editTitle: "编辑音乐分组",
      nameLabel: "分组名称",
      descLabel: "分组说明",
      namePlaceholder: "例如：背景音乐、转场音效、产品配乐",
      descPlaceholder: "可选：这个分组适合存放哪些音频？",
      saveLabel: "保存分组",
    },
    prompt: {
      createTitle: "添加提示词分组",
      editTitle: "编辑提示词分组",
      nameLabel: "分组名称",
      descLabel: "分组说明",
      namePlaceholder: "例如：文案结构、口播禁忌、账号人设",
      descPlaceholder: "可选：这个分组适合存放哪些提示词？",
      saveLabel: "保存分组",
    },
    "writing-style": {
      createTitle: "添加文风分组",
      editTitle: "编辑文风分组",
      nameLabel: "分组名称",
      descLabel: "分组说明",
      namePlaceholder: "例如：历史口播、带货测评、纪录片旁白",
      descPlaceholder: "可选：这个分组适合存放哪些文风？",
      saveLabel: "保存分组",
    },
    script: {
      createTitle: "添加脚本分组",
      editTitle: "编辑脚本分组",
      nameLabel: "分组名称",
      descLabel: "分组说明",
      namePlaceholder: "例如：测评脚本、剧情脚本、老板口播",
      descPlaceholder: "可选：这个分组适合存放哪些对标脚本？",
      saveLabel: "保存分组",
    },
    role: {
      createTitle: "添加角色分组",
      editTitle: "编辑角色分组",
      nameLabel: "分组名称",
      descLabel: "分组说明",
      namePlaceholder: "例如：主播人设、专家角色、素人角色",
      descPlaceholder: "可选：这个分组适合存放哪些角色？",
      saveLabel: "保存分组",
    },
    hook: {
      createTitle: "添加开头分组",
      editTitle: "编辑开头分组",
      nameLabel: "分组名称",
      descLabel: "分组说明",
      namePlaceholder: "例如：痛点型、反差型、结果型",
      descPlaceholder: "可选：这个分组适合存放哪些开头？",
      saveLabel: "保存分组",
    },
    element: {
      createTitle: "添加元素分组",
      editTitle: "编辑元素分组",
      nameLabel: "分组名称",
      descLabel: "分组说明",
      namePlaceholder: "例如：转化元素、信任元素、情绪元素",
      descPlaceholder: "可选：这个分组适合存放哪些爆款元素？",
      saveLabel: "保存分组",
    },
    product: {
      createTitle: "添加产品分组",
      editTitle: "编辑产品分组",
      nameLabel: "分组名称",
      descLabel: "分组说明",
      namePlaceholder: "例如：家居百货、美妆个护、数码配件",
      descPlaceholder: "可选：这个分组适合存放哪些带货产品？",
      saveLabel: "保存分组",
    },
  };
  return copies[kind] || copies.prompt;
}

function groupedAssetCopy(type) {
  if (type === "prompt") {
    return {
      title: "提示词库",
      unit: "提示词",
      groupName: "提示词分组",
      groupDesc: "自定义提示词分组",
    };
  }
  if (type === "script") return { title: "脚本库", unit: "脚本资产", groupName: "脚本分组", groupDesc: "对标脚本分组" };
  if (type === "role") return { title: "角色库", unit: "角色资产", groupName: "角色分组", groupDesc: "角色资产分组" };
  if (type === "hook") return { title: "爆款开头", unit: "开头资产", groupName: "开头分组", groupDesc: "爆款开头分组" };
  if (type === "element") return { title: "爆款元素", unit: "元素资产", groupName: "元素分组", groupDesc: "爆款元素分组" };
  if (type === "product") return { title: "带货产品库", unit: "产品资产", groupName: "产品分组", groupDesc: "带货产品分组" };
  return {
    title: "文风库",
    unit: "文风",
    groupName: "文风分组",
    groupDesc: "自定义文风分组",
  };
}

function normalizeAssetState(rawAssets) {
  const normalized = {};
  assetTypes.forEach((type) => {
    const data = rawAssets[type.id] || { groups: [], assets: [] };
    normalized[type.id] = {
      groups: data.groups.map(normalizeGroup),
      assets: data.assets.map(normalizeAsset),
    };
  });
  normalized["visual-style"].assets = [...systemVisualStyles, ...normalized["visual-style"].assets];
  normalized["image-library"].groups = normalizeImageLibraries(rawAssets["image-library"] || { groups: [], assets: [] });
  normalized["image-library"].assets = normalized["image-library"].groups.flatMap((group) => group.images);
  return normalized;
}

function normalizeImageLibraries(data) {
  const libraries = data.groups.map((group) => ({
    ...normalizeGroup(group),
    images: [],
  }));
  const libraryMap = new Map(libraries.map((library) => [library.id, library]));

  data.assets.map(normalizeAsset).forEach((asset) => {
    if (Array.isArray(asset.images) && asset.images.length) {
      const library = libraryMap.get(asset.id) || {
        id: asset.id,
        name: asset.name,
        desc: asset.desc || "",
        images: [],
        createdAt: asset.createdAt,
      };
      library.images.push(...asset.images.map((image) => normalizeImageAsset(image, library.id)));
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
        createdAt: asset.createdAt,
      });
    }
    libraryMap.get(groupId).images.push(normalizeImageAsset(asset, groupId));
  });

  return Array.from(libraryMap.values());
}

function normalizeGroup(group) {
  return {
    id: group.id,
    name: group.name || "未命名分组",
    desc: group.desc || "",
    createdAt: group.createdAt || "",
  };
}

function normalizeAsset(asset) {
  const payload = asset.payload && typeof asset.payload === "object" ? asset.payload : {};
  return {
    ...payload,
    id: asset.id,
    type: asset.type || payload.type || "",
    groupId: asset.groupId || payload.groupId || "",
    name: asset.name || payload.name || "未命名资产",
    desc: asset.desc || payload.desc || "",
    tag: payload.tag || "",
    prompt: payload.prompt || "",
    fileUrl: resolveFlowStudioFileUrl(asset.fileUrl || payload.fileUrl || payload.dataUrl || ""),
    thumbnailUrl: resolveFlowStudioFileUrl(asset.thumbnailUrl || payload.thumbnailUrl || payload.thumbUrl || ""),
    mimeType: asset.mimeType || payload.mimeType || payload.type || "",
    sizeBytes: Number(asset.sizeBytes || payload.sizeBytes || payload.size || 0),
    createdAt: asset.createdAt || payload.createdAt || "",
    updatedAt: asset.updatedAt || payload.updatedAt || "",
    userId: asset.userId || payload.userId || "",
    teamId: asset.teamId || payload.teamId || "",
    scope: asset.scope || payload.scope || (asset.teamId || payload.teamId ? "team" : "personal"),
    reviewStatus: asset.reviewStatus || payload.reviewStatus || payload.teamReviewStatus || "approved",
    teamRole: asset.teamRole || "none",
    shared: Boolean(asset.shared || payload.shared || asset.scope === "team"),
    storedOnServer: asset.storedOnServer !== false,
  };
}

function normalizeImageAsset(image, groupId) {
  return {
    ...image,
    id: image.id,
    groupId,
    name: image.name || "未命名图片",
    fileUrl: resolveFlowStudioFileUrl(image.fileUrl || image.dataUrl || ""),
    thumbnailUrl: resolveFlowStudioFileUrl(image.thumbnailUrl || image.thumbUrl || ""),
    createdAt: image.createdAt || "",
    storedOnServer: image.storedOnServer !== false,
  };
}

function createMediaAssetForm(asset = {}) {
  return {
    ...emptyAssetForm,
    ...asset,
    id: asset.id || "",
    name: asset.name || "",
    groupId: asset.groupId || "",
    fileUrl: asset.fileUrl || asset.dataUrl || "",
    fileKey: asset.fileKey || "",
    thumbnailUrl: asset.thumbnailUrl || asset.thumbUrl || "",
    thumbnailKey: asset.thumbnailKey || "",
    thumbnailMimeType: asset.thumbnailMimeType || "",
    thumbnailSizeBytes: Number(asset.thumbnailSizeBytes || 0),
    mimeType: asset.mimeType || asset.type || "",
    sizeBytes: Number(asset.sizeBytes || 0),
    createdAt: asset.createdAt || "",
    shared: Boolean(asset.shared || asset.scope === "team"),
  };
}

function normalizeWritingStyleExtractForm(form) {
  const value = form && typeof form === "object" ? form : {};
  return {
    ...emptyWritingStyleExtractForm,
    ...value,
    name: String(value.name || ""),
    groupId: String(value.groupId || ""),
    llmKeyId: String(value.llmKeyId || ""),
    modelId: String(value.modelId || ""),
    files: Array.isArray(value.files) ? value.files : [],
    shared: Boolean(value.shared),
  };
}

function createVideoAnalysisAssetForm(asset, apiKeys = [], selectedGroupId = "", type = "") {
  const llmKeys = apiKeysForService(apiKeys, "llm");
  const imageKeys = apiKeysForService(apiKeys, "image");
  const imageKey = imageKeys.find((key) => key.id === asset?.imageKeyId) || imageKeys[0] || null;
  const imageModels = roleImageModelOptions(imageKey);
  const imageModel = imageModels.find((model) => model.id === asset?.imageModelId || model.modelId === asset?.imageModelId) || imageModels[0] || null;
  const defaultEntryMode = inferTechniqueEntryMode(asset, type);
  const storedYoutubeUrl = normalizeYoutubeVideoUrl(asset?.youtubeUrl || asset?.sourceFile?.sourceUrl || asset?.sourceFile?.fileUrl || asset?.fileUrl || "");
  return {
    ...emptyAssetForm,
    ...(asset || {}),
    id: asset?.id || "",
    name: asset?.name || "",
    groupId: asset?.groupId || selectedGroupId || "",
    desc: asset?.desc || "",
    prompt: asset?.prompt || "",
    tag: asset?.tag || "",
    shared: Boolean(asset?.shared || asset?.scope === "team"),
    entryMode: defaultEntryMode,
    videoSourceMode: youtubeVideoAnalysisAssetTypes.has(type) && storedYoutubeUrl ? "youtube" : "upload",
    youtubeUrl: storedYoutubeUrl,
    nameError: "",
    llmKeyId: asset?.llmKeyId || llmKeys[0]?.id || "",
    modelId: asset?.analysisModelId || asset?.modelId || defaultVideoAnalysisModel,
    generateRoleImages: Boolean(asset?.generateRoleImages),
    roleImageDesignCount: clampRoleImageDesignCount(asset?.roleImageDesignCount || 1),
    roleImageType: normalizeRoleImageType(asset?.roleImageType),
    roleImageCustomPrompt: String(asset?.roleImageCustomPrompt || ""),
    imageKeyId: asset?.imageKeyId || imageKey?.id || "",
    imageModelId: asset?.imageModelId || imageModel?.id || defaultRoleImageModel,
    imageRatio: asset?.imageRatio || imageModel?.ratios?.[0]?.value || "1:1",
    imageResolution: asset?.imageResolution || imageModel?.resolutions?.[0] || "1k",
    imageFormat: asset?.imageFormat || imageModel?.formats?.[0] || "png",
    roleCountMode: asset?.roleCountMode || "auto",
    roleCount: Number(asset?.roleCount || 1),
    targetDurationMode: asset?.targetDurationMode || (Number(asset?.durationSeconds || 0) && Number(asset?.sourceFile?.durationSeconds || 0) && Number(asset.durationSeconds) !== Number(asset.sourceFile.durationSeconds) ? "custom" : "source"),
    targetDurationSeconds: asset?.targetDurationSeconds || asset?.durationSeconds || "",
    files: [],
    sourceFile: asset?.sourceFile || (asset?.fileUrl ? {
      name: asset.name || "已上传视频",
      fileUrl: asset.fileUrl,
      mimeType: asset.mimeType || "",
      sizeBytes: asset.sizeBytes || 0,
      durationSeconds: asset.durationSeconds || 0,
    } : null),
    videoDurationSeconds: Number(asset?.sourceFile?.durationSeconds || asset?.durationSeconds || 0),
    fileError: "",
    createdAt: asset?.createdAt || "",
  };
}

function inferTechniqueEntryMode(asset, type = "") {
  if (!asset?.id) return asset?.entryMode || "video";
  if (type !== "hook" && type !== "element") return asset?.entryMode || "video";
  if (asset.entryMode) return asset.entryMode;
  return isVideoExtractedTechniqueAssetForm(type, asset) ? "video" : "manual";
}

function isVideoExtractedTechniqueAssetForm(type, form = {}) {
  if (type !== "hook" && type !== "element") return false;
  if (!form?.id) return false;
  if (form.entryMode === "video") return true;
  const hasVideoMarkers = Boolean(
    form.sourceTechniqueIndex ||
    form.sourceFile ||
    form.sourceVideoName ||
    form.rawAnalysis ||
    form.analysisModelId ||
    form.llmKeyId ||
    form.fileUrl,
  );
  if (hasVideoMarkers) return true;
  if (form.entryMode === "manual") return false;
  return false;
}

function createWritingStyleExtractDefaults(groups = [], selectedGroupId = "", apiKeys = []) {
  const safeGroups = Array.isArray(groups) ? groups.filter(Boolean) : [];
  const safeApiKeys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [];
  const llmKeys = apiKeysForService(safeApiKeys, "llm");
  const llmKeyId = llmKeys[0]?.id || "";
  const modelId = workflowLlmModelOptions(llmKeys[0])[0]?.id || "";
  return {
    ...emptyWritingStyleExtractForm,
    groupId: safeGroups.some((group) => group.id === selectedGroupId) ? selectedGroupId : safeGroups[0]?.id || "",
    llmKeyId,
    modelId,
  };
}

function isWritingStyleSourceFile(file) {
  const ext = String(file?.name || "").split(".").pop()?.toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return ["md", "txt", "pdf"].includes(ext) || ["text/markdown", "text/plain", "application/pdf"].includes(type);
}

async function readWritingStyleSourceFile(file, uploaded = null) {
  const ext = String(file.name || "").split(".").pop()?.toLowerCase();
  const isPdf = file.type === "application/pdf" || ext === "pdf";
  return {
    id: crypto.randomUUID(),
    name: file.name,
    type: isPdf ? "pdf" : ext || "text",
    size: file.size,
    fileUrl: uploaded?.url || "",
    fileKey: uploaded?.key || "",
    mimeType: uploaded?.mimeType || file.type || "",
    sizeBytes: uploaded?.sizeBytes || file.size,
    text: isPdf ? "" : await file.text(),
    status: isPdf ? "PDF 已保存，后续接入解析器后可自动提取正文" : "已读取正文",
  };
}

function normalizeUploadedFile(file) {
  if (!file) return null;
  return {
    ...file,
    url: resolveFlowStudioFileUrl(file.url || ""),
  };
}

function writingStyleFileSelectionMessage(files = []) {
  if (!files.length) return "尚未选择文件。";
  const unreadable = files.filter((file) => !file.text?.trim()).length;
  if (unreadable) return `${files.length} 个文件已选择，其中 ${unreadable} 个暂未读取到正文。`;
  return `${files.length} 个样本文档已读取。`;
}

function workflowLlmModelOptions(apiKey) {
  if (!apiKey) return [];
  const knownModels = llmModelsForApiKey(apiKey);
  if (knownModels.length) return knownModels;
  return workflowCustomModelOptions(apiKey.model);
}

function roleImageModelOptions(apiKey) {
  if (!apiKey) return [];
  const knownModels = imageModelsForApiKey(apiKey, { workflow: true });
  if (knownModels.length) return knownModels;
  return workflowCustomModelOptions(apiKey.model).map((model) => ({
    ...model,
    modelId: model.id,
    resolutions: ["默认"],
    ratios: [{ value: "1:1", label: "正方形" }],
    formats: ["png"],
  }));
}

function workflowCustomModelOptions(value = "") {
  return String(value)
    .split(/[,，;\n]/)
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => ({ id: model, name: model }));
}

function apiKeyDisplayName(apiKey) {
  return apiKey?.name || formatApiChannelName(apiKey?.channel) || apiKey?.serviceType || "未命名渠道";
}

function formatApiChannelName(channel = "") {
  const value = String(channel || "").trim();
  if (/^canvas$/i.test(value)) return "Canvas";
  return value;
}

function extractWorkflowLlmContent(data) {
  const message = data?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => part.text || part.content || "")
      .join("\n")
      .trim();
  }
  return String(data?.choices?.[0]?.text || data?.output_text || "").trim();
}

function videoAnalysisRetryAttempts(type = "") {
  return type === "script" || type === "role" ? 3 : 2;
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

async function withVideoAnalysisRetry(task, { type = "", label = "视频分析", onRetry = null } = {}) {
  const maxAttempts = videoAnalysisRetryAttempts(type);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientVideoAnalysisError(error)) throw error;
      if (typeof onRetry === "function") {
        await onRetry({
          attempt,
          nextAttempt: attempt + 1,
          retryCount: attempt,
          maxAttempts,
          error,
        }).catch(() => {});
      }
      await delay(videoAnalysisRetryDelayMs * attempt);
    }
  }
  throw lastError || new Error(`${label}失败，请稍后重试。`);
}

async function analyzeVideoAssetText({ type, llmKeyId, modelId, videoContentUrl, sourceFile, roleCountMode = "auto", roleCount = 1, targetDurationMode = "source", targetDurationSeconds = 0, onRetry = null }) {
  if (type === "script") {
    return requestScriptStructureAnalysis({ llmKeyId, modelId, videoContentUrl, sourceFile, roleCountMode, roleCount, targetDurationMode, targetDurationSeconds, onRetry });
  }
  return requestVideoAnalysisText({
    type,
    llmKeyId,
    modelId,
    videoContentUrl,
    sourceFile,
    instruction: buildVideoAnalysisUserInstruction(type, { roleCountMode, roleCount }),
    timeoutMs: videoAnalysisRequestTimeoutMs({ type }),
    onRetry,
  });
}

async function requestScriptStructureAnalysis({ llmKeyId, modelId, videoContentUrl, sourceFile, roleCountMode = "auto", roleCount = 1, targetDurationMode = "source", targetDurationSeconds = 0, onRetry = null }) {
  const durationSeconds = Number(sourceFile?.durationSeconds || 0);
  const finalTargetDurationSeconds = Math.max(0, Math.round(Number(targetDurationSeconds || durationSeconds || 0)));
  const timeoutMs = videoAnalysisRequestTimeoutMs({
    type: "script",
    sourceDurationSeconds: durationSeconds,
    targetDurationSeconds: finalTargetDurationSeconds,
  });
  return await withVideoAnalysisRetry(async () => {
    const result = await withTimeout(generateText({
      apiKeyId: llmKeyId,
      model: modelId,
      taskType: videoAnalysisTaskType("script"),
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
                sourceDurationSeconds: durationSeconds,
                roleCountMode,
                roleCount,
                targetDurationMode,
                targetDurationSeconds: finalTargetDurationSeconds,
              }),
            },
            videoAnalysisMessagePart(videoContentUrl, sourceFile),
          ],
        },
      ],
    }), timeoutMs + 30000, `脚本资产解析超过 ${Math.ceil(timeoutMs / (60 * 1000))} 分钟未完成，已自动标记为失败。请稍后重试。`);
    const rawText = stripTextCodeFence(extractWorkflowLlmContent(result?.data) || String(result?.content || "").trim());
    if (!rawText) throw transientVideoAnalysisError("模型没有返回脚本资产。");
    if (isTransientVideoAnalysisText(rawText)) throw transientVideoAnalysisError("模型当前处于高峰或临时繁忙，已自动重试；请稍后再试。");
    if (isMissingVideoAnalysisResponse(rawText)) throw new Error("脚本资产解析失败：模型没有返回可用结果。");
    const profile = normalizeScriptStructureProfile(rawText, {
      sourceFile,
      roleCountMode,
      roleCount,
      targetDurationMode,
      targetDurationSeconds: finalTargetDurationSeconds,
    });
    return {
      text: rawText,
      rawText,
      profile,
    };
  }, { type: "script", label: "脚本资产解析", onRetry });
}

function videoAnalysisMessagePart(videoContentUrl = "", sourceFile = {}) {
  const mimeType = normalizeVideoMimeType(sourceFile?.mimeType, [
    sourceFile?.name,
    sourceFile?.fileUrl,
    sourceFile?.fileKey,
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

async function requestVideoAnalysisText({ type, llmKeyId, modelId, videoContentUrl, sourceFile, instruction, timeoutMs = videoAnalysisTimeoutMs, onRetry = null }) {
  return await withVideoAnalysisRetry(async () => {
    const result = await withTimeout(generateText({
      apiKeyId: llmKeyId,
      model: modelId,
      taskType: videoAnalysisTaskType(type),
      timeoutMs,
      messages: [
        {
          role: "system",
          content: videoAnalysisSystemPrompt(type),
        },
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            videoAnalysisMessagePart(videoContentUrl, sourceFile),
          ],
        },
      ],
    }), timeoutMs + 30000, `视频分析超过 ${Math.ceil(timeoutMs / (60 * 1000))} 分钟未完成，已自动标记为失败。请确认渠道支持视频输入后再重试。`);
    const analysis = extractWorkflowLlmContent(result?.data) || String(result?.content || "").trim();
    if (!analysis) throw transientVideoAnalysisError("模型没有返回可保存的分析结果。");
    if (isTransientVideoAnalysisText(analysis)) throw transientVideoAnalysisError("模型当前处于高峰或临时繁忙，已自动重试；请稍后再试。");
    if (isMissingVideoAnalysisResponse(analysis)) {
      throw new Error("视频分析失败：模型没有收到可解析的视频，请确认 LLM 渠道支持视频输入后重试。");
    }
    return analysis;
  }, { type, label: "视频分析", onRetry });
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
3. 必须按“角色数量设置”统计人物：角色数量必须等于角色清单实际条目数。AI 分析模式只列主角、核心角色和重要配角；自定义模式下以目标数量为主，先列主角/核心角色/重要配角，如果不足目标数量，再补充视频里真实出现且外观可确认的边缘人物；如果全部可确认人物仍不足目标数量，就按实际人数填写。禁止凭空捏造人物。角色清单请按主角、核心角色、重要配角、可确认边缘人物的优先级排序，并在括号里标注类型。角色数量只统计人物，绝对不能填写镜头数量、分镜数量、对白条数、台词行数或剧情节点数量；角色数量通常不会超过 20。
4. 必须判断整个视频“有无对白”：有台词、旁白或口播就写“有”；几乎没有台词就写“无”。
5. 必须识别产品首次明确出场的时间点和占比；如果视频没有明确产品，写“未识别明确产品”。
6. 原视频里出现的产品名、价格、卖点、使用效果等信息请如实保留，不要替换成占位符。
7. 如果本次设置了自定义目标时长，不要输出目标时长版完整脚本，只在【扩写规则】里说明如何保持原结构进行扩写。
8. 【扩写规则】必须明确强调：保持原视频结构比例、保持产品首次出场比例、扩充每个阶段内部内容、保留角色关系和说话风格；不要用空镜、重复对白、无意义等待、黑场或纯情绪拉扯来凑目标时长。`;
}

const scriptFallbackSecondsPerShot = 5;
const sourceShotCountLabels = ["sourceShotCount", "originalShotCount", "rawShotCount", "原镜头", "原镜头数量", "原视频镜头", "原视频镜头数", "原视频总镜头数量"];
const targetShotCountLabels = ["targetShotCount", "目标镜头", "目标镜头数量", "目标视频镜头", "目标视频镜头数"];
const estimatedShotCountLabels = ["estimatedShotCount", "shotCount", "storyboardCount", "分镜数量", "镜头数量", "总镜头数量", "总分镜数量"];
const coreRoleCountLabels = ["coreCharacters.totalCount", "totalCount", "roleCount", "角色数量", "核心角色数量", "核心人物数量", "核心角色数", "核心人物数"];
const sourceDurationLabels = ["原时长", "原视频时长", "视频时长", "sourceDurationSeconds"];
const targetDurationLabels = ["目标时长", "目标视频时长", "targetDurationSeconds"];
const leadRoleCountLabels = ["主角数量", "主角数", "leadCount", "mainCount"];
const supportingRoleCountLabels = ["配角数量", "配角数", "supportingCount", "supportCount"];
const scriptMaxDisplayRoleCount = 20;

function estimateSourceScriptShotCount(sourceDurationSeconds = 0) {
  const sourceSeconds = positiveNumber(sourceDurationSeconds);
  return sourceSeconds ? Math.max(1, Math.round(sourceSeconds / scriptFallbackSecondsPerShot)) : 0;
}

function estimateTargetScriptShotCount(sourceShotCount = 0, sourceDurationSeconds = 0, targetDurationMode = "source", targetDurationSeconds = 0) {
  const sourceCount = positiveInteger(sourceShotCount);
  const sourceSeconds = positiveNumber(sourceDurationSeconds);
  const targetSeconds = positiveNumber(targetDurationSeconds);
  if (!sourceCount) return targetSeconds ? Math.max(1, Math.round(targetSeconds / scriptFallbackSecondsPerShot)) : 0;
  if (targetDurationMode !== "custom") return sourceCount;
  if (!targetSeconds) return sourceCount;
  if (!sourceSeconds) return Math.max(1, Math.round(targetSeconds / scriptFallbackSecondsPerShot));
  return Math.max(1, Math.round(sourceCount * (targetSeconds / sourceSeconds)));
}

function normalizeScriptStructureProfile(input, fallback = {}) {
  const parsed = typeof input === "string" ? parseJsonObjectFromText(input) : input;
  const data = parsed && typeof parsed === "object" ? parsed : {};
  const rawText = typeof input === "string" ? input : "";
  const textSourceShotCount = labeledPositiveIntegerFromText(rawText, sourceShotCountLabels);
  const textTargetShotCount = labeledPositiveIntegerFromText(rawText, targetShotCountLabels);
  const textEstimatedShotCount = labeledPositiveIntegerFromText(rawText, estimatedShotCountLabels);
  const textRoleCount = labeledPositiveIntegerFromText(rawText, coreRoleCountLabels);
  const textLeadCount = labeledPositiveIntegerFromText(rawText, leadRoleCountLabels);
  const textSupportingCount = labeledPositiveIntegerFromText(rawText, supportingRoleCountLabels);
  const sourceDurationSeconds = positiveInteger(data.sourceDurationSeconds || data.source_duration_seconds || data.原时长 || data.原视频时长秒数 || fallback.sourceDurationSeconds || fallback.sourceFile?.durationSeconds || durationSecondsFromText(rawText, sourceDurationLabels));
  const targetDurationSeconds = positiveInteger(fallback.targetDurationSeconds || data.targetDurationSeconds || data.target_duration_seconds || data.目标时长 || data.目标时长秒数 || durationSecondsFromText(rawText, targetDurationLabels) || sourceDurationSeconds);
  const targetDurationMode = fallback.targetDurationMode || data.targetDurationMode || data.target_duration_mode || "source";
  const roleCountMode = normalizeScriptRoleCountMode(data.roleCountMode || data.role_count_mode || data.角色数量模式 || fallback.roleCountMode);
  const requestedRoleCount = positiveInteger(fallback.roleCount || data.requestedRoleCount || data.requested_role_count || data.roleCountTarget || data.role_count_target || data.自定义角色数量);
  const roleCountLimit = scriptRoleCountLimit(roleCountMode, requestedRoleCount);
  const rawCharacters = objectValue(data.coreCharacters || data.core_characters || data.核心人物 || data.核心角色);
  const characters = normalizeScriptCharacters(rawCharacters.characters || rawCharacters.list || rawCharacters.角色列表 || rawCharacters.人物列表 || data.characters || data.角色列表 || data.人物列表);
  const textCharacters = normalizeScriptCharactersFromText(rawText);
  const finalCharacters = scriptCharactersWithinRoleLimit(characters.length ? characters : textCharacters, roleCountLimit, roleCountMode);
  const explicitLeadCount = positiveInteger(rawCharacters.leadCount || rawCharacters.lead_count || rawCharacters.mainCount || rawCharacters.main_count || rawCharacters.主角数量 || data.leadCount || data.主角数量 || textLeadCount);
  const explicitSupportingCount = positiveInteger(rawCharacters.supportingCount || rawCharacters.supporting_count || rawCharacters.supportCount || rawCharacters.support_count || rawCharacters.配角数量 || data.supportingCount || data.配角数量 || textSupportingCount);
  const hasExplicitRoleBreakdown = Boolean(rawCharacters.hasExplicitRoleBreakdown || rawCharacters.has_explicit_role_breakdown || explicitLeadCount || explicitSupportingCount);
  const leadCount = explicitLeadCount || finalCharacters.filter((item) => /主角|主线|lead|main/i.test(item.roleType)).length;
  const supportingCount = explicitSupportingCount || finalCharacters.filter((item) => /配角|support|secondary/i.test(item.roleType)).length;
  const estimatedShotCount = positiveInteger(data.estimatedShotCount || data.estimated_shot_count || data.shotCount || data.shot_count || data.storyboardCount || data.storyboard_count || data.分镜数量 || data.镜头数量 || data.总镜头数量 || data.总分镜数量 || textEstimatedShotCount || fallback.estimatedShotCount);
  const sourceShotCount = positiveInteger(data.sourceShotCount || data.source_shot_count || data.originalShotCount || data.original_shot_count || data.rawShotCount || data.raw_shot_count || data.原镜头 || data.原镜头数量 || data.原视频镜头数 || data.原视频总镜头数量 || textSourceShotCount || estimatedShotCount || fallback.sourceShotCount || estimateSourceScriptShotCount(sourceDurationSeconds) || 1);
  const targetShotCount = positiveInteger(data.targetShotCount || data.target_shot_count || data.目标镜头 || data.目标镜头数量 || data.目标视频镜头数 || textTargetShotCount || fallback.targetShotCount) || estimateTargetScriptShotCount(sourceShotCount, sourceDurationSeconds, targetDurationMode, targetDurationSeconds);
  const totalCount = normalizeScriptRoleTotalCount({
    explicitCount: positiveInteger(rawCharacters.totalCount || rawCharacters.total_count || rawCharacters.角色数量 || rawCharacters.核心角色数量 || data.totalCount || data.roleCount || data.角色数量 || data.核心角色数量 || textRoleCount || fallback.coreRoleCount),
    characterCount: finalCharacters.length,
    leadCount,
    supportingCount,
    roleCountMode,
    preferLeadSupportingCount: hasExplicitRoleBreakdown,
    limit: roleCountLimit,
  });
  const dataProductFirstAppearance = normalizeProductFirstAppearance(data.productFirstAppearance || data.product_first_appearance || data.productReveal || data.product_reveal);
  const textProductFirstAppearance = normalizeProductFirstAppearanceFromText(rawText, sourceDurationSeconds);
  const productFirstAppearance = dataProductFirstAppearance.appears ? {
    ...textProductFirstAppearance,
    ...dataProductFirstAppearance,
    evidence: dataProductFirstAppearance.evidence || textProductFirstAppearance.evidence,
  } : textProductFirstAppearance;
  const explicitHasDialogue = normalizeScriptDialogueValue(data.hasDialogue ?? data.has_dialogue ?? data.有无对白 ?? data.是否有对白, rawText);
  const fallbackHasDialogue = normalizeScriptDialogueValue(fallback.hasDialogue, rawText);
  return {
    assetType: normalizeText(data.assetType || data.asset_type) || "reference_script_asset",
    sourceDurationSeconds,
    targetDurationMode,
    targetDurationSeconds,
    roleCountMode,
    requestedRoleCount,
    hasDialogue: explicitHasDialogue ?? fallbackHasDialogue,
    sourceShotCount,
    targetShotCount,
    estimatedShotCount: estimatedShotCount || sourceShotCount,
    shotCountBasis: normalizeText(data.shotCountBasis || data.shot_count_basis || data.shotBasis || ""),
    coreCharacters: {
      leadCount,
      supportingCount,
      totalCount,
      characters: finalCharacters,
      hasExplicitRoleBreakdown,
    },
    structureRatio: normalizeScriptStructureRatio(data.structureRatio || data.structure_ratio || data.structures),
    productFirstAppearance,
    coreConflictPath: normalizeStringList(data.coreConflictPath || data.core_conflict_path),
    characterRelationships: normalizeStringList(data.characterRelationships || data.character_relationships),
    sceneRhythm: normalizeText(data.sceneRhythm || data.scene_rhythm),
    cameraStyle: normalizeText(data.cameraStyle || data.camera_style),
    hooksReversalsConversionNodes: normalizeScriptNodes(data.hooksReversalsConversionNodes || data.hooks_reversals_conversion_nodes || data.keyNodes || data.key_nodes),
    scriptDna: normalizeText(data.scriptDna || data.scriptDNA || data.script_dna),
    expansionRules: normalizeStringList(data.expansionRules || data.expansion_rules),
    riskNotes: normalizeStringList(data.riskNotes || data.risk_notes),
  };
}

function buildScriptStructureCardText(profile = {}) {
  const sourceDurationSeconds = Number(profile.sourceDurationSeconds || 0);
  const targetDurationSeconds = Number(profile.targetDurationSeconds || sourceDurationSeconds || 0);
  const characters = profile.coreCharacters || {};
  const product = profile.productFirstAppearance || {};
  const coreRoleCount = Number(characters.totalCount || 0);
  const lines = [
    "【脚本资产摘要】",
    `原时长：${sourceDurationSeconds ? formatVideoDuration(sourceDurationSeconds) : "未识别"}`,
    `目标时长：${targetDurationSeconds ? formatVideoDuration(targetDurationSeconds) : "跟随原视频"}`,
    `角色数量：${coreRoleCount || "未识别"}`,
    `有无对白：${scriptDialogueStatusLabel(profile.hasDialogue)}`,
    product.appears
      ? `产品首次出场：${formatPercent(product.percent)}，${product.timeSeconds ? formatVideoDuration(product.timeSeconds) : "时间未识别"}；依据：${product.evidence || "未说明"}`
      : "产品首次出场：未识别明确产品",
    "",
    "【核心人物】",
    `主角数量：${Number(characters.leadCount || 0)}`,
    `配角数量：${Number(characters.supportingCount || 0)}`,
    "角色清单：",
    ...(Array.isArray(characters.characters) && characters.characters.length
      ? characters.characters.map((item, index) => `${index + 1}. ${item.name || "未命名角色"}（${item.roleType || "角色"}）：${[item.description, item.functionInConflict].filter(Boolean).join("；")}`)
      : ["未识别"]),
    "",
    "【结构比例】",
    ...(Array.isArray(profile.structureRatio) && profile.structureRatio.length
      ? profile.structureRatio.map((item, index) => `${index + 1}. ${item.stage || "未命名阶段"}：${formatPercentRange(item.startPercent, item.endPercent)}｜${formatSecondsRange(item.startSeconds, item.endSeconds)}｜${[item.purpose, item.keyEvents].filter(Boolean).join("；")}`)
      : ["未识别"]),
    "",
    "【核心冲突路径】",
    ...formatListLines(profile.coreConflictPath),
    "",
    "【人物关系】",
    ...formatListLines(profile.characterRelationships),
    "",
    "【场景节奏】",
    profile.sceneRhythm || "未识别",
    "",
    "【镜头风格】",
    profile.cameraStyle || "未识别",
    "",
    "【爆点 / 反转 / 转化节点】",
    ...(Array.isArray(profile.hooksReversalsConversionNodes) && profile.hooksReversalsConversionNodes.length
      ? profile.hooksReversalsConversionNodes.map((item, index) => `${index + 1}. ${item.type || "节点"}：${formatPercent(item.percent)}｜${item.timeSeconds ? formatVideoDuration(item.timeSeconds) : "时间未识别"}｜${[item.description, item.function].filter(Boolean).join("；")}`)
      : ["未识别"]),
    "",
    "【脚本 DNA】",
    profile.scriptDna || "未识别",
    "",
    "【扩写规则】",
    ...formatListLines(profile.expansionRules),
    "",
    "【风险提示】",
    ...formatListLines(profile.riskNotes),
  ];
  return lines.filter((line) => line !== "").join("\n").trim();
}

function parseJsonObjectFromText(text = "") {
  const value = String(text || "").trim();
  if (!value) return {};
  const candidates = [
    value,
    value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || "",
    value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1),
  ].filter((item) => item && item.includes("{") && item.includes("}"));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction candidate.
    }
  }
  return {};
}

function stripTextCodeFence(text = "") {
  const value = String(text || "").trim();
  if (!value) return "";
  const match = value.match(/^```(?:text|txt|markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] || value).trim();
}

function normalizeScriptCharactersFromText(text = "") {
  const section = extractBracketSection(text, "核心人物");
  if (!section) return [];
  const listText = section.match(/角色清单\s*[:：]?\s*([\s\S]*)/i)?.[1] || section;
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
    .filter((item) => item.name || item.description);
}

function normalizeProductFirstAppearanceFromText(text = "", sourceDurationSeconds = 0) {
  const line = String(text || "").match(/产品首次出场[^\n]*/)?.[0] || "";
  if (!line || /未识别明确产品|未识别|未出现|没有|无明确|不出现/.test(line)) {
    return { appears: false, timeSeconds: 0, percent: 0, evidence: "" };
  }
  const timeSeconds = durationSecondsFromLooseText(line);
  const percentText = line.match(/(\d+(?:\.\d+)?)\s*%/)?.[1] || "";
  const sourceSeconds = positiveNumber(sourceDurationSeconds);
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
  if (typeof value === "boolean") return value;
  const explicit = normalizeText(value);
  const explicitResult = explicit ? parseScriptDialogueStatus(explicit) : null;
  if (explicitResult !== null) return explicitResult;
  const textResult = parseScriptDialogueStatus(labeledTextFromText(text, ["有无对白", "是否有对白", "对白状态"]));
  if (textResult !== null) return textResult;
  const dialogueBlocks = scriptDialogueBlocksFromText(text);
  if (dialogueBlocks.length) {
    const meaningfulBlocks = dialogueBlocks.filter((item) => item && !isPlaceholderDialogueText(item));
    if (meaningfulBlocks.some((item) => !isNoDialogueText(item))) return true;
    if (meaningfulBlocks.some((item) => isNoDialogueText(item))) return false;
  }
  const scriptSection = extractBracketSection(text, "原视频脚本复原") || text;
  if (scriptTextHasSpeakerDialogue(scriptSection)) return true;
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

function scriptDialogueBlocksFromText(text = "") {
  const body = String(text || "");
  const bracketBlocks = [...body.matchAll(/【(?:角色对白|对白|角色台词|台词|旁白|口播)】\s*[:：]?\s*([\s\S]*?)(?=\n\s*【(?:画面内容|角色对白|对白|角色台词|台词|旁白|口播|备注)】|\n\s*第\s*\d+\s*镜|$)/g)]
    .map((match) => normalizeText(match[1]).replace(/\s+/g, " ").trim());
  const lineBlocks = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => !/^有无对白\s*[:：]/.test(line))
    .map((line) => line.match(/^(?:[-*•\d.、\s]*)?(?:角色对白|对白|角色台词|台词|旁白|口播)\s*[:：]\s*(.+)$/)?.[1] || "")
    .map((value) => normalizeText(value).replace(/\s+/g, " ").trim());
  return [...bracketBlocks, ...lineBlocks].filter(Boolean);
}

function isPlaceholderDialogueText(value = "") {
  const text = normalizeText(value);
  return !text ||
    /^(?:\.\.\.|待补充|未识别|角色名[（(]语气[）)]|角色名[：:]|示例|按原视频复原)$/i.test(text) ||
    /还原台词意思|这一镜没有对白就写|角色名（语气）|角色名\(语气\)/.test(text);
}

function isNoDialogueText(value = "") {
  return /^(无|无对白|没有对白|无台词|没有台词|无旁白|没有旁白|无对话|没有对话|none|no dialogue|silent|未识别|待补充|\.\.\.)$/i.test(normalizeText(value));
}

function scriptTextHasSpeakerDialogue(text = "") {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.、\s]+/, "").trim())
    .some((line) => {
      if (!line || /^【|^第\s*\d+\s*镜/.test(line)) return false;
      if (/^(?:原时长|目标时长|角色数量|有无对白|镜头粒度|镜头数量|画面内容|备注|产品首次出场|人物关系|主角数量|配角数量|角色清单)\s*[:：]/.test(line)) return false;
      const match = line.match(/^([\u4e00-\u9fa5A-Za-z0-9_·]{1,12}|旁白|口播|画外音|男声|女声|主播)(?:[（(][^）)]{1,16}[）)])?\s*[:：]\s*(.+)$/);
      if (!match) return false;
      const dialogue = normalizeText(match[2]);
      return dialogue.length >= 2 && !isNoDialogueText(dialogue) && !isPlaceholderDialogueText(dialogue);
    });
}

function extractBracketSection(text = "", title = "") {
  const value = String(text || "");
  if (!value || !title) return "";
  const pattern = new RegExp(`【${escapeRegExp(title)}】\\s*([\\s\\S]*?)(?=\\n\\s*【[^】]+】|$)`);
  return normalizeText(value.match(pattern)?.[1] || "");
}

function labeledTextFromText(text = "", labels = []) {
  const value = String(text || "");
  if (!value.trim()) return "";
  for (const label of labels) {
    const match = value.match(new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*([^\\n]+)`));
    if (match?.[1]) return normalizeText(match[1]);
  }
  return "";
}

function normalizeScriptCharacters(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => ({
    name: normalizeText(item?.name || item?.角色名字 || item?.角色名 || ""),
    roleType: normalizeText(item?.roleType || item?.role_type || item?.类型 || item?.角色类型 || ""),
    description: normalizeText(item?.description || item?.角色定义 || item?.desc || ""),
    functionInConflict: normalizeText(item?.functionInConflict || item?.function_in_conflict || item?.冲突作用 || item?.剧情作用 || ""),
  })).filter((item) => item.name || item.description || item.functionInConflict);
}

function normalizeScriptRoleCountMode(value = "") {
  return normalizeText(value) === "custom" || /自定义/.test(normalizeText(value)) ? "custom" : "auto";
}

function scriptRoleCountLimit(roleCountMode = "auto", requestedRoleCount = 0) {
  const requested = positiveInteger(requestedRoleCount);
  if (roleCountMode === "custom" && requested) return Math.min(scriptMaxDisplayRoleCount, requested);
  return scriptMaxDisplayRoleCount;
}

function scriptCharactersWithinRoleLimit(characters = [], limit = scriptMaxDisplayRoleCount, roleCountMode = "auto") {
  const normalized = normalizeScriptCharacters(characters);
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

function normalizeScriptStructureRatio(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => ({
    stage: normalizeText(item?.stage || item?.阶段 || ""),
    startSeconds: positiveNumber(item?.startSeconds || item?.start_seconds || item?.开始秒数),
    endSeconds: positiveNumber(item?.endSeconds || item?.end_seconds || item?.结束秒数),
    startPercent: normalizePercentValue(item?.startPercent ?? item?.start_percent ?? item?.开始占比),
    endPercent: normalizePercentValue(item?.endPercent ?? item?.end_percent ?? item?.结束占比),
    purpose: normalizeText(item?.purpose || item?.作用 || ""),
    keyEvents: normalizeText(item?.keyEvents || item?.key_events || item?.关键事件 || ""),
  })).filter((item) => item.stage || item.purpose || item.keyEvents);
}

function normalizeProductFirstAppearance(value = {}) {
  const data = value && typeof value === "object" ? value : {};
  const timeSeconds = positiveNumber(data.timeSeconds || data.time_seconds || data.出场秒数);
  const percent = normalizePercentValue(data.percent ?? data.占比 ?? data.ratio);
  const evidence = normalizeText(data.evidence || data.依据 || "");
  return {
    appears: Boolean(data.appears || data.出现 || data.hasProduct || timeSeconds || percent || evidence),
    timeSeconds,
    percent,
    evidence,
  };
}

function normalizeScriptNodes(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => ({
    type: normalizeText(item?.type || item?.类型 || ""),
    timeSeconds: positiveNumber(item?.timeSeconds || item?.time_seconds || item?.秒数),
    percent: normalizePercentValue(item?.percent ?? item?.占比 ?? item?.ratio),
    description: normalizeText(item?.description || item?.节点内容 || item?.desc || ""),
    function: normalizeText(item?.function || item?.作用 || ""),
  })).filter((item) => item.type || item.description || item.function);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeText(item)).filter(Boolean);
  const text = normalizeText(value);
  return text ? [text] : [];
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return String(value || "").trim();
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

function positiveInteger(value) {
  const number = Math.round(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1000) / 1000 : 0;
}

function labeledPositiveIntegerFromText(text = "", labels = []) {
  const body = String(text || "");
  if (!body.trim()) return 0;
  for (const label of labels) {
    const escapedLabel = escapeRegExp(label);
    const patterns = [
      new RegExp(`["'\`]?${escapedLabel}["'\`]?\\s*[:：=]\\s*["'\`]?(\\d{1,5})`, "i"),
      new RegExp(`${escapedLabel}\\s*(?:为|是|共|约|大约)?\\s*(\\d{1,5})\\s*(?:镜|个|人|位)?`, "i"),
    ];
    for (const pattern of patterns) {
      const value = positiveInteger(body.match(pattern)?.[1]);
      if (value) return value;
    }
  }
  return 0;
}

function durationSecondsFromText(text = "", labels = []) {
  const body = String(text || "");
  if (!body.trim()) return 0;
  for (const label of labels) {
    const escapedLabel = escapeRegExp(label);
    const nearby = body.match(new RegExp(`${escapedLabel}[^\\n]{0,40}`, "i"))?.[0] || "";
    const duration = durationSecondsFromLooseText(nearby);
    if (duration) return duration;
  }
  return 0;
}

function durationSecondsFromLooseText(text = "") {
  const body = String(text || "");
  const clock = body.match(/(\d{1,2})(?::(\d{1,2}))(?::(\d{1,2}))?/);
  if (clock) {
    const first = Number(clock[1] || 0);
    const second = Number(clock[2] || 0);
    const third = Number(clock[3] || 0);
    return third ? first * 3600 + second * 60 + third : first * 60 + second;
  }
  const minuteSecond = body.match(/(\d+(?:\.\d+)?)\s*(?:分|分钟)\s*(\d+(?:\.\d+)?)?\s*(?:秒|秒钟)?/);
  if (minuteSecond) return Math.round(Number(minuteSecond[1] || 0) * 60 + Number(minuteSecond[2] || 0));
  const seconds = body.match(/(\d+(?:\.\d+)?)\s*(?:秒|秒钟|s\b)/i);
  if (seconds) return Math.round(Number(seconds[1] || 0));
  return 0;
}

function normalizePercentValue(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  const percent = number <= 1 ? number * 100 : number;
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}

function formatPercent(value) {
  const percent = normalizePercentValue(value);
  return percent ? `${percent}%` : "占比未识别";
}

function formatPercentRange(start, end) {
  return `${formatPercent(start)}-${formatPercent(end)}`;
}

function formatSecondsRange(start, end) {
  const startText = start ? formatVideoDuration(start) : "开始未识别";
  const endText = end ? formatVideoDuration(end) : "结束未识别";
  return `${startText}-${endText}`;
}

function formatListLines(items = []) {
  return Array.isArray(items) && items.length ? items.map((item, index) => `${index + 1}. ${item}`) : ["未识别"];
}

function buildVideoAnalysisUserInstruction(type, options = {}) {
  if (type === "role") {
    const count = Math.max(1, Math.min(20, Number(options.roleCount || 1)));
    const countRule = options.roleCountMode === "custom"
      ? `本次自定义角色数量为 ${count} 个。请把 ${count} 当作目标输出数量：优先提取核心角色；核心角色不足 ${count} 个时，继续提取重要配角；仍不足时，可以提取外观可确认、能生成角色图的边缘人物来补足。禁止凭空捏造没有出现在视频中的人物；如果核心角色、配角和可确认边缘人物加起来仍少于 ${count} 个，就只输出实际可确认的人物数量。`
      : "请由 AI 判断核心人物数量，只提取真正推动剧情、反复出现、有明确台词或承担主要冲突的核心人物。";
    const countExample = options.roleCountMode === "custom" ? count : 1;
    const roleListExample = Array.from({ length: countExample }, (_, index) => `    {
      "角色名字": "角色${index + 1}名字或代号",
      "角色定义": "国籍/民族观感、性别、年龄段、身份、性格特征和行为描述（中文，简明扼要）",
      "角色绘画提示词": "${roleImagePromptExample}"
    }`).join(",\n");
    return `${countRule}

请严格分析这个上传视频，并且只能输出下面这种中文 JSON。不要输出解释、问候、准备话术或 Markdown 代码块。

{
  "角色数量": ${countExample},
  "角色列表": [
${roleListExample}
  ]
}

硬性要求：
1. 顶层必须有“角色数量”和“角色列表”；“角色数量”必须等于“角色列表”的实际条目数。
2. “角色列表”必须是数组。
3. 每个角色必须包含“角色名字”“角色定义”“角色绘画提示词”。
4. 不知道真实姓名时，请使用角色代号，不能留空。
5. 角色定义必须包含：国籍/民族观感、性别、年龄段、身份、性格特征和行为描述。
6. 绘画提示词必须按此结构输出：${roleImagePromptTemplate}。
7. “国籍/民族观感+性别”必须合并成“中国女性”“中国男性”等短语；不要拆成“中国籍，女性”。
8. 必须把模板中的“国籍/民族观感+性别”“身形特征+外貌特征+具体穿着”替换成视频里可观察到的具体描述，不要原样输出占位词。
9. 绘画提示词必须包含：全身照、身形特征、外貌特征、具体穿着、无表情、双手下垂、正常清晰人脸、真实摄影、纯灰白色无缝摄影棚背景、背景中没有任何物体或人物。不要在基础角色绘画提示词里加入人脸马赛克、脸部打码或三视图要求，图片类型会在后续生成阶段单独控制。
10. 不要输出“写实风格、电影级光影、8k分辨率、超高细节”等旧版风格词。
11. 不要输出剧情分析、分镜、产品信息、补充说明或任何 JSON 之外的文字；角色定义控制在 120 字以内，角色绘画提示词控制在 180 字以内。
12. ${options.roleCountMode === "custom" ? `目标是尽量输出 ${count} 个角色，不能只因为某些人物不是核心角色就提前停止；但也不能为了凑数编造视频里不存在的人。` : "自动模式下不要用边缘人物凑数。"}`;
  }
  if (type === "product") {
    return `请严格按系统提示词分析这个上传视频，只输出以下纯文本模板，不要输出任何额外章节、解释、标题、剧情大纲或营销建议：

【带货产品资料】
产品名称：
产品亮点：
使用效果：
使用动态描述：
用户痛点：
面向人群：
价格文本：

如果某项视频未提及，填写“视频未提及”。`;
  }
  if (type === "hook") {
    return `请严格分析这个上传视频，提取可复用的爆款开头技巧。必须只输出中文 JSON，格式如下：

{
  "爆款开头列表": [
    {
      "开头名称": "一句话命名这个开头技巧",
      "摘要": "一句话说明这个开头为什么抓人",
      "标签": "反差, 痛点, 悬念",
      "可复用内容": "原始开头：...\\n开头类型：...\\n钩子逻辑：...\\n可替换模板：...\\n适用品类/场景：...\\n使用注意：..."
    }
  ]
}

如果视频里有多个可复用开头技巧，请全部列入数组。`;
  }
  if (type === "element") {
    return `请严格分析这个上传视频，提取可复用的爆款元素。必须只输出中文 JSON，格式如下：

{
  "爆款元素列表": [
    {
      "元素名称": "一句话命名这个爆款元素",
      "摘要": "一句话说明这个元素的作用",
      "标签": "痛点, 反差, 转化",
      "可复用内容": "元素类型：...\\n适用阶段：...\\n插入方式：...\\n示例文案/画面：...\\n适用品类/场景：...\\n风险提示：..."
    }
  ]
}

如果视频里有多个可复用爆款元素，请全部列入数组。`;
  }
  return "请按系统提示词分析这个上传视频，并直接输出可保存到资产库的纯文本分析结果。不要输出准备提示；如果无法读取视频，请直接返回“视频读取失败”。";
}

function videoAnalysisSystemPrompt(type) {
  if (type === "script") return scriptVideoAnalysisPrompt;
  if (type === "role") return roleVideoAnalysisPrompt;
  if (type === "hook") return hookVideoAnalysisPrompt;
  if (type === "element") return elementVideoAnalysisPrompt;
  return productVideoAnalysisPrompt;
}

function videoAnalysisTaskType(type) {
  if (type === "script") return "asset-script-video-analysis";
  if (type === "role") return "asset-role-video-analysis";
  if (type === "hook") return "asset-hook-video-analysis";
  if (type === "element") return "asset-element-video-analysis";
  return "asset-product-video-analysis";
}

function videoAnalysisTotalTimeoutMs({ type = "", sourceDurationSeconds = 0 } = {}) {
  return videoAnalysisTimeoutMs;
}

function videoAnalysisRequestTimeoutMs({ type = "", sourceDurationSeconds = 0 } = {}) {
  return videoAnalysisTimeoutMs;
}

function videoAnalysisTimeoutMsForAsset(asset = {}) {
  const savedTimeoutMs = Number(asset.analysisTimeoutMs || 0);
  const perAttemptTimeoutMs = savedTimeoutMs > 0 ? clampVideoAnalysisTimeoutMs(savedTimeoutMs) : videoAnalysisTotalTimeoutMs({
    type: asset.type,
    sourceDurationSeconds: asset.sourceFile?.durationSeconds || asset.videoDurationSeconds || 0,
    targetDurationSeconds: asset.targetDurationSeconds || asset.durationSeconds || 0,
  });
  return videoAnalysisEffectiveTimeoutMs(asset, perAttemptTimeoutMs);
}

function videoAnalysisEffectiveTimeoutMs(asset = {}, perAttemptTimeoutMs = videoAnalysisTimeoutMs) {
  const maxAttempts = positiveInteger(asset.analysisMaxAttempts) || videoAnalysisRetryAttempts(asset.type);
  const attemptsUsed = Math.max(1, Math.min(maxAttempts, positiveInteger(asset.analysisRetryCount) + 1));
  return perAttemptTimeoutMs * attemptsUsed;
}

function clampVideoAnalysisTimeoutMs(value, minMs = videoAnalysisTimeoutMs, maxMs = videoAnalysisMaxTimeoutMs) {
  const timeoutMs = Number(value || 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return minMs;
  return Math.max(minMs, Math.min(timeoutMs, maxMs));
}

function formatVideoAnalysisTimeout(asset = {}) {
  return `${Math.ceil(videoAnalysisTimeoutMsForAsset(asset) / (60 * 1000))} 分钟`;
}

function collectTimedOutVideoAnalysisAssets(assetState = {}) {
  return Array.from(videoAnalysisAssetTypes).flatMap((type) => {
    const assets = Array.isArray(assetState[type]?.assets) ? assetState[type].assets : [];
    return assets
      .map((rawAsset) => ({ type, asset: { ...normalizeAsset(rawAsset), type } }))
      .filter(({ asset }) => isVideoAnalysisTimedOut(asset));
  });
}

function markTimedOutVideoAnalysisAssets(assetState = {}, timedOutItems = []) {
  if (!timedOutItems.length) return assetState;
  const timeoutIds = new Set(timedOutItems.map((item) => `${item.type}:${item.asset.id}`));
  const now = new Date().toISOString();
  const nextState = { ...assetState };
  Array.from(videoAnalysisAssetTypes).forEach((type) => {
    const data = assetState[type] || { groups: [], assets: [] };
    nextState[type] = {
      ...data,
      assets: (Array.isArray(data.assets) ? data.assets : []).map((rawAsset) => {
        const key = `${type}:${rawAsset.id}`;
        if (!timeoutIds.has(key)) return rawAsset;
        const asset = { ...normalizeAsset(rawAsset), type };
        return {
          ...rawAsset,
          payload: {
            ...(rawAsset.payload || {}),
            desc: "视频分析超时",
            analysisStatus: "error",
            analysisError: videoAnalysisTimeoutMessage(asset),
            updatedAt: now,
          },
          updatedAt: now,
        };
      }),
    };
  });
  return nextState;
}

function isAmbiguousVideoAnalysisError(error) {
  const message = String(error?.message || error || "");
  return isTransientVideoAnalysisError(error) || /网络连接失败|请求超时|超过\s*\d+\s*分钟|模型请求可能已经提交|模型服务连接失败|fetch|load failed|network/i.test(message);
}

function isMissingVideoAnalysisResponse(text = "") {
  const value = String(text || "").trim();
  if (!value) return true;
  return /(?:未(?:收到|接收|获取|提供|上传)|没有(?:收到|接收|获取|看到)|无法(?:访问|读取|解析|查看)|不能(?:访问|读取|解析|查看)|请(?:重新)?上传|视频读取失败|视频文件|视频链接)/i.test(value) &&
    /(?:视频|文件|链接|素材)/i.test(value) &&
    !/(?:产品名称|产品亮点|使用效果|使用动态描述|用户痛点|面向人群|价格文本|爆款开头列表|开头名称|爆款元素列表|元素名称|可复用内容|script_structure_card|reference_script_asset|sourceDurationSeconds|targetDurationSeconds|sourceShotCount|targetShotCount|estimatedShotCount|structureRatio|productFirstAppearance|scriptDna|对标视频结构卡片|可复用脚本 DNA|脚本资产摘要|原视频脚本复原|扩写规则|有无对白|原时长|目标时长|原镜头|目标镜头|分镜数量|镜头数量|产品首次出场|产品首次出场比例|第一部分|逐镜头|画面内容|角色对白|备注|画面[:：]|台词[:：]|音效[:：])/.test(value);
}

function previewText(type, asset) {
  if (type === "prompt" || type === "visual-style") return "";
  if (type === "writing-style") {
    if (asset.analysisStatus === "running") return "文风正在后台分析，完成后会自动更新为可用状态。";
    if (asset.analysisStatus === "error") return asset.analysisError || "文风分析失败，请重新上传。";
    return asset.sourceFiles?.length ? "已完成 AI 文风分析，可用于工作流文案生成。" : "自定义文风";
  }
  if (type === "music") return `${formatBytes(asset.sizeBytes)} · ${asset.mimeType || "音频文件"}`;
  if (videoAnalysisAssetTypes.has(type)) {
    if (isVideoAnalysisTimedOut(asset)) return asset.analysisError || videoAnalysisTimeoutMessage(asset);
    if (asset.analysisStatus === "running") return videoAnalysisRunningText(asset);
    if (isVideoAnalysisFailed(asset)) return asset.analysisError || "视频提取失败：模型没有收到可解析的视频，请重新上传。";
    if (type === "script") return scriptAnalysisCardSummary(asset);
    if (type === "role") return roleAnalysisCardSummary(asset);
    if (type === "product") return "";
    if (isVideoExtractedTechniqueAsset(type, asset)) return techniqueAssetCardSummary(asset);
    if (type === "hook" || type === "element") return asset.tag ? compactText(`标签：${asset.tag}`) : "";
    return "已完成视频提取，分析全文已保存但不会在卡片外显。";
  }
  if (ecommerceAssetTypes.has(type)) return compactText(asset.prompt || asset.desc || asset.tag || "待补充分结构化分析内容。");
  return compactText(asset.desc || "创意资产");
}

function isVideoExtractedTechniqueAsset(type, asset = {}) {
  if (type !== "hook" && type !== "element") return false;
  return asset.entryMode === "video" || Boolean(asset.sourceTechniqueIndex || asset.sourceVideoName || asset.sourceFile);
}

function techniqueAssetCardSummary(asset = {}) {
  const parts = [
    asset.tag ? `标签：${asset.tag}` : "",
    asset.sourceVideoName ? `来源：${asset.sourceVideoName}` : "",
  ].filter(Boolean);
  return parts.map((part) => compactText(part)).join("\n");
}

function roleAnalysisCardSummary(asset = {}) {
  const profiles = roleProfilesFromAsset(asset);
  const roleNames = profiles.map((profile) => profile.name).filter(Boolean);
  const names = roleNames.slice(0, 4).join("、");
  const roleLine = `${profiles.length} 个角色${names ? `：${names}${roleNames.length > 4 ? "等" : ""}` : ""}`;
  const imageProgress = roleImageProgressFromProfiles(profiles);
  const imageStatus = [
    `${imageProgress.completed}/${imageProgress.total} 张角色图已生成`,
    imageProgress.pending ? `${imageProgress.pending} 张生成中` : "",
    imageProgress.failed ? `${imageProgress.failed} 张失败` : "",
    roleImageGenerationStatusText(asset, imageProgress),
  ].filter(Boolean).join("，");
  return `${roleLine}\n${imageStatus}`;
}

function roleImageGenerationStatusText(asset = {}, imageProgress = null) {
  const status = effectiveRoleImageGenerationStatus(asset, imageProgress);
  if (status === "running") return "后台生成中";
  if (status === "partial") return "部分完成";
  if (status === "error") return asset.imageGenerationError ? "角色图生成失败" : "图片失败";
  return "";
}

function effectiveRoleImageGenerationStatus(asset = {}, imageProgress = null) {
  const profiles = imageProgress ? [] : roleProfilesFromAsset(asset);
  const progress = imageProgress || roleImageProgressFromProfiles(profiles);
  return roleImageGenerationStatusFromProgress(asset.imageGenerationStatus, progress);
}

function roleImageProgressFromProfiles(profiles = []) {
  const safeProfiles = Array.isArray(profiles) ? profiles : [];
  const imageItems = safeProfiles.flatMap((profile) => Array.isArray(profile.roleImages) ? profile.roleImages : []);
  const total = imageItems.length || safeProfiles.length;
  const completed = imageItems.length
    ? imageItems.filter((item) => item.imageUrl).length
    : safeProfiles.filter((profile) => profile.imageUrl).length;
  const failed = imageItems.length
    ? imageItems.filter((item) => item.imageError && !item.imageUrl).length
    : safeProfiles.filter((profile) => profile.imageError && !profile.imageUrl).length;
  const pending = imageItems.length ? Math.max(0, total - completed - failed) : 0;
  return { total, completed, failed, pending };
}

function roleImageGenerationStatusFromProgress(status = "", progress = {}) {
  const currentStatus = String(status || "").trim();
  const total = Number(progress.total || 0);
  const completed = Number(progress.completed || 0);
  const failed = Number(progress.failed || 0);
  const pending = Math.max(0, Number(progress.pending ?? Math.max(0, total - completed - failed)));
  if (!total) return ["running", "partial", "error", "done"].includes(currentStatus) ? "" : currentStatus;
  if (!pending && completed >= total && !failed) return "done";
  if (!pending && failed) return completed ? "partial" : "error";
  if (currentStatus === "partial" && failed && completed) return "partial";
  if (currentStatus === "error" && failed && !completed) return "error";
  return currentStatus;
}

function roleImagePendingText(image = {}) {
  if (image.status === "running") return "生成中";
  if (image.status === "pending") return "排队中";
  return "待生成";
}

function roleImageRecordStatusLabel(image = {}, imageUrl = "") {
  if (image.imageError && !imageUrl) return "失败";
  if (imageUrl) return "已完成";
  return roleImagePendingText(image);
}

function scriptAnalysisText(asset = {}) {
  return [...new Set([asset.rawAnalysis, asset.prompt, asset.desc].map((item) => String(item || "").trim()).filter(Boolean))].join("\n");
}

function scriptSourceShotCount(profile = {}, asset = {}) {
  const text = scriptAnalysisText(asset);
  const sourceDurationSeconds = positiveNumber(profile.sourceDurationSeconds || asset.sourceFile?.durationSeconds || asset.videoDurationSeconds || durationSecondsFromText(text, sourceDurationLabels));
  return positiveInteger(
    profile.sourceShotCount ||
    profile.estimatedShotCount ||
    asset.sourceShotCount ||
    asset.estimatedShotCount ||
    labeledPositiveIntegerFromText(text, sourceShotCountLabels) ||
    labeledPositiveIntegerFromText(text, estimatedShotCountLabels) ||
    estimateSourceScriptShotCount(sourceDurationSeconds) ||
    1,
  );
}

function scriptTargetShotCount(profile = {}, asset = {}, sourceShotCount = 0) {
  const text = scriptAnalysisText(asset);
  const explicitCount = positiveInteger(profile.targetShotCount || asset.targetShotCount || labeledPositiveIntegerFromText(text, targetShotCountLabels));
  if (explicitCount) return explicitCount;
  const sourceDurationSeconds = positiveNumber(profile.sourceDurationSeconds || asset.sourceFile?.durationSeconds || asset.videoDurationSeconds || durationSecondsFromText(text, sourceDurationLabels));
  const targetDurationSeconds = positiveNumber(profile.targetDurationSeconds || asset.targetDurationSeconds || asset.durationSeconds || sourceDurationSeconds);
  const targetDurationMode = profile.targetDurationMode || asset.targetDurationMode || (targetDurationSeconds && sourceDurationSeconds && targetDurationSeconds !== sourceDurationSeconds ? "custom" : "source");
  return estimateTargetScriptShotCount(sourceShotCount, sourceDurationSeconds, targetDurationMode, targetDurationSeconds) || sourceShotCount;
}

function scriptCoreRoleCount(profile = {}, asset = {}) {
  const text = scriptAnalysisText(asset);
  const roleCountMode = normalizeScriptRoleCountMode(profile.roleCountMode || asset.roleCountMode);
  const requestedRoleCount = positiveInteger(profile.requestedRoleCount || asset.roleCount);
  const limit = scriptRoleCountLimit(roleCountMode, requestedRoleCount);
  const fallbackProfile = normalizeScriptStructureProfile(text, {
    sourceFile: asset.sourceFile || null,
    sourceDurationSeconds: asset.sourceFile?.durationSeconds || asset.videoDurationSeconds || 0,
    roleCountMode,
    roleCount: requestedRoleCount,
    targetDurationMode: asset.targetDurationMode,
    targetDurationSeconds: asset.targetDurationSeconds || asset.durationSeconds || 0,
  });
  const profileCharacters = Array.isArray(profile.coreCharacters?.characters) ? profile.coreCharacters.characters : [];
  const fallbackCharacters = Array.isArray(fallbackProfile.coreCharacters?.characters) ? fallbackProfile.coreCharacters.characters : [];
  const explicitCount = [
    profile.coreCharacters?.totalCount,
    fallbackProfile.coreCharacters?.totalCount,
    scriptRoleCount(text, { roleCountMode, roleCount: requestedRoleCount }),
    labeledPositiveIntegerFromText(text, coreRoleCountLabels),
  ].map(positiveInteger).find((count) => count > 0 && count <= limit) || 0;
  return normalizeScriptRoleTotalCount({
    explicitCount,
    characterCount: profileCharacters.length || fallbackCharacters.length,
    leadCount: profile.coreCharacters?.leadCount || fallbackProfile.coreCharacters?.leadCount,
    supportingCount: profile.coreCharacters?.supportingCount || fallbackProfile.coreCharacters?.supportingCount,
    roleCountMode,
    preferLeadSupportingCount: Boolean(profile.coreCharacters?.hasExplicitRoleBreakdown || fallbackProfile.coreCharacters?.hasExplicitRoleBreakdown),
    limit,
  });
}

function scriptDialogueStatus(profile = {}, asset = {}) {
  const value = normalizeScriptDialogueValue(profile.hasDialogue, scriptAnalysisText(asset));
  return scriptDialogueStatusLabel(value);
}

function scriptDialogueStatusLabel(value) {
  if (value === true) return "有";
  if (value === false) return "无";
  return "未识别";
}

function scriptSourceDurationSeconds(profile = {}, asset = {}) {
  const text = scriptAnalysisText(asset);
  return positiveInteger(
    profile.sourceDurationSeconds ||
    asset.sourceFile?.durationSeconds ||
    asset.videoDurationSeconds ||
    durationSecondsFromText(text, sourceDurationLabels),
  );
}

function scriptTargetDurationSeconds(profile = {}, asset = {}, sourceDurationSeconds = 0) {
  const text = scriptAnalysisText(asset);
  return positiveInteger(
    profile.targetDurationSeconds ||
    asset.targetDurationSeconds ||
    asset.durationSeconds ||
    durationSecondsFromText(text, targetDurationLabels) ||
    sourceDurationSeconds,
  );
}

function scriptAnalysisCardSummary(asset = {}) {
  const profile = scriptStructureProfileFromAsset(asset);
  const sourceDurationSeconds = scriptSourceDurationSeconds(profile, asset);
  const targetDurationSeconds = scriptTargetDurationSeconds(profile, asset, sourceDurationSeconds);
  const roleCount = scriptCoreRoleCount(profile, asset);
  const dialogueStatus = scriptDialogueStatus(profile, asset);
  const roleScopeLabel = normalizeScriptRoleCountMode(profile.roleCountMode || asset.roleCountMode) === "custom" ? "角色" : "核心角色";
  return [
    [
      `原时长：${sourceDurationSeconds ? formatVideoDuration(sourceDurationSeconds) : "未识别"}`,
      `目标时长：${targetDurationSeconds ? formatVideoDuration(targetDurationSeconds) : "未识别"}`,
    ].join(" · "),
    [
      roleCount ? `角色数量：${roleCount}（${roleScopeLabel}）` : "角色数量：未识别",
      `有无对白：${dialogueStatus}`,
    ].join(" · "),
  ].join("\n");
}

function scriptStructureProfileFromAsset(asset = {}) {
  const text = scriptAnalysisText(asset);
  const sourceDurationSeconds = Number(asset.sourceFile?.durationSeconds || asset.videoDurationSeconds || durationSecondsFromText(text, sourceDurationLabels) || 0);
  const targetDurationSeconds = Number(asset.targetDurationSeconds || asset.durationSeconds || sourceDurationSeconds || 0);
  const targetDurationMode = asset.targetDurationMode || (targetDurationSeconds && sourceDurationSeconds && targetDurationSeconds !== sourceDurationSeconds ? "custom" : "source");
  const fallback = {
    sourceFile: asset.sourceFile || null,
    sourceDurationSeconds,
    roleCountMode: asset.roleCountMode,
    roleCount: asset.roleCount,
    targetDurationMode,
    targetDurationSeconds,
  };
  const textProfile = normalizeScriptStructureProfile(text, fallback);
  if (asset.scriptProfile && typeof asset.scriptProfile === "object") {
    return normalizeScriptStructureProfile(asset.scriptProfile, {
      ...fallback,
      sourceDurationSeconds: textProfile.sourceDurationSeconds || sourceDurationSeconds,
      sourceShotCount: textProfile.sourceShotCount,
      targetShotCount: textProfile.targetShotCount,
      estimatedShotCount: textProfile.estimatedShotCount,
      coreRoleCount: textProfile.coreCharacters?.totalCount,
      roleCountMode: textProfile.roleCountMode || asset.roleCountMode,
      roleCount: textProfile.requestedRoleCount || asset.roleCount,
      hasDialogue: textProfile.hasDialogue,
    });
  }
  return textProfile;
}

function scriptRoleCount(text = "", options = {}) {
  const body = String(text || "");
  const explicitCount = body.match(/(?:核心角色数量|核心人物数量|核心角色数|核心人物数)\s*[:：]\s*(\d+)/)?.[1];
  const roleCountMode = normalizeScriptRoleCountMode(options.roleCountMode);
  const roleCountLimit = scriptRoleCountLimit(roleCountMode, options.roleCount);
  if (explicitCount && Number(explicitCount) <= roleCountLimit) return Number(explicitCount);
  const bracketCharacters = normalizeScriptCharactersFromText(body);
  if (bracketCharacters.length) {
    return scriptCharactersWithinRoleLimit(bracketCharacters, roleCountLimit, roleCountMode).length || null;
  }
  const leadCount = labeledPositiveIntegerFromText(body, leadRoleCountLabels);
  const supportingCount = labeledPositiveIntegerFromText(body, supportingRoleCountLabels);
  if (leadCount || supportingCount) return Math.min(roleCountLimit, leadCount + supportingCount);
  const section = body.match(/(?:核心人物清单|核心角色清单|人物清单|角色清单|人物列表|角色列表)[：:]?([\s\S]*?)(?=\n\s*(?:[-*#]*\s*)?(?:第二部分|逐镜头|镜头|分镜|场景清单|核心色调|\[\d{1,2}:\d{2})|$)/)?.[1] || "";
  if (!section.trim()) return null;
  const sectionCount = section.match(/(?:核心角色数量|核心人物数量|核心角色数|核心人物数)\s*[:：]\s*(\d+)/)?.[1];
  if (sectionCount && Number(sectionCount) <= roleCountLimit) return Number(sectionCount);
  const lines = section
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.、\s]+/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^(无|未出现|视频未提及|暂无|没有)$/.test(line))
    .filter((line) => roleCountMode === "custom" || !/(?:边缘|路人|群演|背景|无台词|一闪而过|短暂出现|提及但未出镜|不计入|不纳入|非核心|次要|客串)/.test(line))
    .filter((line) => /[:：、，,（(]|角色|人物|主角|配角|男|女|老人|孩子|主播|老板|员工|顾客|妈妈|爸爸/.test(line) || line.length <= 40);
  if (lines.length) return Math.min(roleCountLimit, lines.length);
  const inline = section
    .replace(/[()（）]/g, " ")
    .split(/[、,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return inline.length ? Math.min(roleCountLimit, inline.length) : null;
}

function parseProductAnalysisFields(text = "") {
  return Object.fromEntries(productAnalysisFieldDefinitions.map((field) => [
    field.key,
    extractProductField(text, field.label, field.aliases || []),
  ]));
}

function emptyProductProfileFields() {
  return {
    productName: "",
    highlights: "",
    effects: "",
    usageMotion: "",
    painPoints: "",
    audience: "",
    priceText: "",
    productImageUrl: "",
    productImageThumbnailUrl: "",
    productImageKey: "",
    productImageName: "",
    productImageMimeType: "",
    productImageSizeBytes: 0,
  };
}

function productProfileFromAsset(asset = {}) {
  if (asset.productProfile && typeof asset.productProfile === "object") {
    return normalizeProductProfileFields(asset.productProfile, asset.name);
  }
  return productProfileFromAnalysis(asset.prompt || asset.rawAnalysis || "", asset.name);
}

function productProfileFromAnalysis(text = "", fallbackName = "") {
  const parsed = parseProductAnalysisFields(text);
  return normalizeProductProfileFields(parsed, fallbackName);
}

function normalizeProductProfileFields(fields = {}, fallbackName = "") {
  const normalized = {};
  productAnalysisFieldDefinitions.forEach((field) => {
    const value = compactProductField(fields[field.key] || "");
    normalized[field.key] = value || (field.key === "productName" ? fallbackName || "视频未提及" : "视频未提及");
  });
  normalized.productImageUrl = String(fields.productImageUrl || fields.imageUrl || fields.product_image_url || "").trim();
  normalized.productImageThumbnailUrl = String(fields.productImageThumbnailUrl || fields.thumbnailUrl || fields.productImageThumbUrl || fields.product_image_thumbnail_url || "").trim();
  normalized.productImageKey = String(fields.productImageKey || fields.imageKey || fields.product_image_key || "").trim();
  normalized.productImageName = String(fields.productImageName || fields.imageName || fields.product_image_name || "").trim();
  normalized.productImageMimeType = String(fields.productImageMimeType || fields.imageMimeType || "").trim();
  normalized.productImageSizeBytes = Number(fields.productImageSizeBytes || fields.imageSizeBytes || 0) || 0;
  return normalized;
}

function buildProductAnalysisText(fields = {}) {
  const normalized = normalizeProductProfileFields(fields);
  return `【带货产品资料】
产品名称：${normalized.productName}
产品亮点：${normalized.highlights}
使用效果：${normalized.effects}
使用动态描述：${normalized.usageMotion}
用户痛点：${normalized.painPoints}
面向人群：${normalized.audience}
价格文本：${normalized.priceText}`;
}

function roleProfileFromAsset(asset = {}) {
  return roleProfilesFromAsset(asset)[0] || roleProfileFromAnalysis(asset.rawAnalysis || asset.prompt || "", asset.name);
}

function roleProfilesFromAsset(asset = {}) {
  if (Array.isArray(asset.roleCharacters)) {
    return asset.roleCharacters
      .map((item, index) => normalizeRoleProfileFields(item, `角色${index + 1}`))
      .filter(isSavableRoleProfile);
  }
  if (asset.roleProfile && typeof asset.roleProfile === "object") {
    return [normalizeRoleProfileFields(asset.roleProfile, asset.name)].filter(isSavableRoleProfile);
  }
  const parsed = roleProfileFromAnalysis(asset.rawAnalysis || asset.prompt || "", asset.name);
  const parsedCharacters = roleCharactersFromAnalysis(asset.rawAnalysis || asset.prompt || "");
  return parsedCharacters.length ? parsedCharacters.filter(isValidRoleProfile) : [parsed].filter(isValidRoleProfile);
}

function roleProfileFromAnalysis(text = "", fallbackName = "") {
  const characters = roleCharactersFromAnalysis(text);
  const first = characters[0] || {};
  const labeled = parseRoleAnalysisFields(text);
  return normalizeRoleProfileFields({
    name: usefulRoleValue(first.name) ? first.name : labeled.name || fallbackName,
    traits: usefulRoleValue(first.traits) ? first.traits : labeled.traits || "",
    realisticImagePrompt: usefulRoleValue(first.realisticImagePrompt) ? first.realisticImagePrompt : labeled.realisticImagePrompt || "",
      imageUrl: first.imageUrl || "",
      thumbnailUrl: first.thumbnailUrl || "",
      imageError: first.imageError || "",
  }, fallbackName);
}

function roleCharactersFromAnalysis(text = "") {
  const parsed = parseJsonLikeText(text);
  const rawCharacters = roleCharacterItemsFromParsedJson(parsed);
  const jsonCharacters = rawCharacters
    .map((item, index) => normalizeRoleProfileFields({
      name: firstRoleField(item, ["name", "role_name", "roleName", "character_name", "characterName", "title", "角色名字", "角色名称", "人物名字", "人物名称", "名字", "名称", "代号"]) || `角色${index + 1}`,
      traits: firstRoleField(item, ["traits", "definition", "desc", "description", "character_definition", "characterDefinition", "role_definition", "roleDefinition", "personality", "profile", "角色定义", "角色特征", "角色描述", "人物特征", "人物描述", "性格特征", "身份定位"]),
      realisticImagePrompt: firstRoleField(item, ["realistic_image_prompt", "realisticImagePrompt", "image_prompt", "imagePrompt", "drawing_prompt", "drawingPrompt", "prompt", "角色绘画提示词", "绘画提示词", "写实绘画提示词", "AI绘画提示词", "图片提示词"]),
      imageUrl: item?.imageUrl || "",
      thumbnailUrl: item?.thumbnailUrl || item?.imageThumbnailUrl || item?.thumbnail_url || "",
      imageError: item?.imageError || "",
    }, `角色${index + 1}`))
    .filter((item) => item.name || item.traits || item.realisticImagePrompt);
  return jsonCharacters.length ? jsonCharacters : roleCharactersFromLabeledText(text);
}

function roleCharacterItemsFromParsedJson(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  const listKeys = [
    "characters",
    "roles",
    "roleProfiles",
    "role_profiles",
    "人物",
    "人物列表",
    "角色",
    "角色列表",
    "核心角色",
    "核心人物",
  ];
  for (const key of listKeys) {
    const value = parsed?.[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      if (firstRoleField(value, ["name", "role_name", "roleName", "character_name", "characterName", "角色名字", "角色名称"])) return [value];
      return Object.values(value).filter((item) => item && typeof item === "object");
    }
  }
  const nestedSources = [parsed.data, parsed.result, parsed.output, parsed.analysis].filter(Boolean);
  for (const source of nestedSources) {
    const nested = roleCharacterItemsFromParsedJson(source);
    if (nested.length) return nested;
  }
  if (firstRoleField(parsed, ["name", "role_name", "roleName", "character_name", "characterName", "角色名字", "角色名称"])) {
    return [parsed];
  }
  return [];
}

function firstRoleField(item = {}, keys = []) {
  if (!item || typeof item !== "object") return "";
  for (const key of keys) {
    const value = item[key];
    if (value === undefined || value === null) continue;
    const text = compactProductField(value);
    if (text) return text;
  }
  return "";
}

function roleCharactersFromLabeledText(text = "") {
  const body = String(text || "").trim();
  if (!body) return [];
  const nameLabels = "角色名字|角色名称|人物名字|人物名称|name";
  const matches = Array.from(body.matchAll(new RegExp(`(?:^|\\n)\\s*(?:[-*\\d.、]+\\s*)?(?:${nameLabels})\\s*[:：]\\s*([^\\n]+)`, "g")));
  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = matches[index + 1]?.index || body.length;
    const block = body.slice(start, end);
    return normalizeRoleProfileFields({
      name: match[1],
      traits: extractRoleField(block, ["角色定义", "角色特征", "角色描述", "人物特征", "人物描述", "traits"]),
      realisticImagePrompt: extractRoleField(block, ["角色绘画提示词", "绘画提示词", "写实绘画提示词", "AI绘画提示词", "图片提示词", "realistic_image_prompt", "image_prompt"]),
    }, `角色${index + 1}`);
  }).filter((item) => item.name || item.traits || item.realisticImagePrompt);
}

function normalizeRoleProfileFields(fields = {}, fallbackName = "") {
  const realisticImagePrompt = normalizeRoleImagePrompt(compactProductField(fields.realisticImagePrompt || fields.realistic_image_prompt || fields.imagePrompt || fields.image_prompt || ""));
  const roleImages = normalizeRoleImageItems(fields, realisticImagePrompt);
  const defaultImage = defaultRoleImageFromItems(roleImages, fields.defaultImageId || fields.defaultRoleImageId || fields.roleImageId);
  return {
    name: compactProductField(fields.name || fallbackName || "未命名角色"),
    traits: compactProductField(fields.traits || fields.definition || fields.desc || "视频未提及"),
    realisticImagePrompt: realisticImagePrompt || "视频未提及",
    roleImages,
    defaultImageId: defaultImage?.id || "",
    imageUrl: defaultImage?.imageUrl || String(fields.imageUrl || fields.image_url || "").trim(),
    thumbnailUrl: defaultImage?.thumbnailUrl || String(fields.thumbnailUrl || fields.thumbnail_url || fields.imageThumbnailUrl || "").trim(),
    imageError: defaultImage?.imageUrl ? "" : defaultImage?.imageError || String(fields.imageError || fields.image_error || "").trim(),
  };
}

function normalizeRoleImageItems(fields = {}, fallbackPrompt = "") {
  const items = Array.isArray(fields.roleImages)
    ? fields.roleImages
    : Array.isArray(fields.images)
      ? fields.images
      : [];
  const normalized = items
    .map((item, index) => normalizeRoleImageItem(item, index, fallbackPrompt))
    .filter((item) => item.imageUrl || item.thumbnailUrl || item.imageError || item.prompt || item.note);
  const legacyImageUrl = String(fields.imageUrl || fields.image_url || fields.url || fields.fileUrl || "").trim();
  const legacyThumbnailUrl = String(fields.thumbnailUrl || fields.thumbnail_url || fields.imageThumbnailUrl || fields.thumbUrl || "").trim();
  const legacyImageError = String(fields.imageError || fields.image_error || "").trim();
  if (!normalized.length && (legacyImageUrl || legacyImageError)) {
    normalized.push(normalizeRoleImageItem({
      id: fields.defaultImageId || "",
      source: "generated",
      prompt: fallbackPrompt,
      imageUrl: legacyImageUrl,
      thumbnailUrl: legacyThumbnailUrl,
      imageError: legacyImageError,
      isDefault: true,
    }, 0, fallbackPrompt));
  }
  const defaultId = String(fields.defaultImageId || fields.defaultRoleImageId || fields.roleImageId || "").trim();
  const hasExplicitDefault = normalized.some((item) => item.id && item.id === defaultId) || normalized.some((item) => item.isDefault);
  if (normalized.length && !hasExplicitDefault) {
    normalized[0] = { ...normalized[0], isDefault: true };
  }
  return normalized.map((item) => ({
    ...item,
    isDefault: Boolean(item.isDefault || (defaultId && item.id === defaultId)),
  }));
}

function normalizeRoleImageItem(item = {}, index = 0, fallbackPrompt = "") {
  const source = item.source === "manual" ? "manual" : "generated";
  const rawPrompt = compactProductField(item.prompt || item.realisticImagePrompt || item.imagePrompt || fallbackPrompt);
  const prompt = source === "manual"
    ? String(item.prompt || "").trim()
    : normalizeGeneratedRoleImagePrompt(rawPrompt, index, fallbackPrompt);
  return {
    id: String(item.id || item.imageId || item.roleImageId || crypto.randomUUID()).trim(),
    source,
    designIndex: Math.max(1, Number(item.designIndex || item.index || index + 1)),
    variantLabel: String(item.variantLabel || item.variantName || "").trim(),
    variantPrompt: String(item.variantPrompt || item.variant || "").trim(),
    prompt,
    note: String(item.note || item.desc || item.description || "").trim(),
    imageUrl: String(item.imageUrl || item.image_url || item.url || item.fileUrl || "").trim(),
    thumbnailUrl: String(item.thumbnailUrl || item.thumbnail_url || item.imageThumbnailUrl || item.thumbUrl || "").trim(),
    imageError: String(item.imageError || item.image_error || "").trim(),
    status: String(item.status || (item.imageError ? "error" : item.imageUrl ? "done" : "pending")).trim(),
    imageKeyId: String(item.imageKeyId || item.apiKeyId || "").trim(),
    imageModelId: String(item.imageModelId || item.modelId || "").trim(),
    imageRatio: String(item.imageRatio || item.ratio || "").trim(),
    imageResolution: String(item.imageResolution || item.resolution || "").trim(),
    imageFormat: String(item.imageFormat || item.format || "").trim(),
    createdAt: String(item.createdAt || "").trim(),
    updatedAt: String(item.updatedAt || "").trim(),
    isDefault: Boolean(item.isDefault || item.default),
  };
}

function isStructuredRoleImagePrompt(prompt = "") {
  return /核心特征固定：|本图差异：|图片类型要求：/.test(String(prompt || ""));
}

function normalizeGeneratedRoleImagePrompt(prompt = "", index = 0, fallbackPrompt = "") {
  const text = compactProductField(prompt);
  if (!text) return compactProductField(fallbackPrompt);
  if (isStructuredRoleImagePrompt(text)) return flattenStructuredRoleImagePrompt(text, index, fallbackPrompt);
  return uniquePromptParts(splitRoleImagePromptParts(text)).join("，");
}

function flattenStructuredRoleImagePrompt(prompt = "", index = 0, fallbackPrompt = "") {
  const corePrompt = extractStructuredRoleImagePromptValue(prompt, "核心特征固定") || fallbackPrompt;
  const typePrompt = extractStructuredRoleImagePromptValue(prompt, "图片类型要求");
  const inferredType = inferRoleImageTypeFromPrompt(typePrompt || prompt);
  return composeRoleImageGenerationPrompt(corePrompt, index, inferredType, inferredType === "custom" ? typePrompt : "");
}

function extractStructuredRoleImagePromptValue(prompt = "", label = "") {
  const text = String(prompt || "");
  const labels = ["核心特征固定", "本图差异", "禁止改变", "图片类型要求"];
  const start = text.indexOf(`${label}：`);
  if (start < 0) return "";
  const valueStart = start + label.length + 1;
  const tail = text.slice(valueStart);
  const nextIndexes = labels
    .filter((item) => item !== label)
    .map((item) => tail.indexOf(`，${item}：`))
    .filter((position) => position >= 0);
  const value = nextIndexes.length ? tail.slice(0, Math.min(...nextIndexes)) : tail;
  return compactProductField(value.replace(/^，+|，+$/g, ""));
}

function inferRoleImageTypeFromPrompt(prompt = "") {
  const text = String(prompt || "");
  if (isRoleImageFaceMosaicPart(text)) return "mosaic-three";
  if (isRoleImageHeadshotThreeViewPart(text) || isRoleImageSketchFacePart(text) || text.includes("素描三视图")) return "sketch-three";
  if (text.includes("单人角色设计图")) return "single";
  return defaultRoleImageType;
}

function defaultRoleImageFromItems(items = [], defaultImageId = "") {
  if (!items.length) return null;
  const explicit = String(defaultImageId || "").trim();
  return items.find((item) => explicit && item.id === explicit)
    || items.find((item) => item.isDefault && item.imageUrl)
    || items.find((item) => item.imageUrl)
    || items.find((item) => item.isDefault)
    || items[0];
}

function clampRoleImageDesignCount(value) {
  return Math.max(roleImageAutoMinCount, Math.min(roleImageAutoMaxCount, Number(value || 1)));
}

function normalizeRoleImageType(value = "") {
  const id = String(value || "").trim();
  return roleImageTypeOptions.some((item) => item.id === id) ? id : defaultRoleImageType;
}

function normalizeRoleImagePrompt(prompt = "", requiredSegments = roleImagePromptRequiredSegments) {
  const text = String(prompt || "").trim();
  if (!text || text === "视频未提及") return text;
  const normalizedParts = text
    .split(/[，,]/)
    .map((part) => normalizeRoleImagePromptPart(part))
    .filter(Boolean)
    .filter((part) => !roleImagePromptDeprecatedSegments.has(part));
  const promptParts = [];
  normalizedParts.forEach((part) => {
    if (!promptParts.includes(part)) promptParts.push(part);
  });
  const safeRequiredSegments = Array.isArray(requiredSegments) ? requiredSegments.filter(Boolean) : roleImagePromptRequiredSegments;
  if (safeRequiredSegments.some((segment) => segment.includes("全身照"))) {
    placeFullBodyRolePromptSegment(promptParts);
  }
  safeRequiredSegments
    .filter((segment) => !segment.includes("全身照"))
    .forEach((segment) => {
      if (!promptParts.some((part) => part.includes(segment))) promptParts.push(segment);
    });
  return promptParts.join("，");
}

function placeFullBodyRolePromptSegment(promptParts = []) {
  const fullBodyIndex = promptParts.findIndex((part) => part.includes("全身照"));
  if (fullBodyIndex >= 0) {
    if (fullBodyIndex === 1 || promptParts.length <= 1) return;
    const [fullBodyPart] = promptParts.splice(fullBodyIndex, 1);
    promptParts.splice(1, 0, fullBodyPart);
    return;
  }
  promptParts.splice(Math.min(1, promptParts.length), 0, "全身照");
}

function normalizeRoleImagePromptPart(part = "") {
  const text = String(part || "").trim();
  if (text === "人脸马赛克") return "人物脸部打上马赛克";
  if (text === "纯灰白无缝摄影棚背景") return "纯灰白色无缝摄影棚背景";
  return text;
}

function roleImageRequiredSegmentsForType(roleImageType = defaultRoleImageType) {
  const normalizedType = normalizeRoleImageType(roleImageType);
  const baseSegments = roleImagePromptRequiredSegments.filter((segment) => {
    if (normalizedType === "mosaic-three") return segment !== "正常清晰人脸";
    return true;
  });
  if (normalizedType === "mosaic-three") return uniquePromptParts([...baseSegments, ...roleImageMosaicRequiredSegments]);
  if (normalizedType === "sketch-three") return uniquePromptParts([...baseSegments, ...roleImageThreeViewRequiredSegments]);
  return baseSegments;
}

function isRoleImageFaceMosaicPart(part = "") {
  const text = String(part || "").trim();
  return /(?:脸|人脸|面部|人物脸部).*(?:马赛克|打码|打上马赛克|模糊)|(?:马赛克|打码|模糊).*(?:脸|人脸|面部|人物脸部)/.test(text);
}

function isRoleImageSketchFacePart(part = "") {
  return /(?:脸|人脸|面部|人物脸部).*素描|素描.*(?:脸|人脸|面部|人物脸部)/.test(String(part || "").trim());
}

function isRoleImageHeadshotThreeViewPart(part = "") {
  const text = String(part || "").trim();
  return /人物脸部大特写肖像|全身三视图转面展示|^包含正面$|^侧面$|^背面$/.test(text);
}

function isRoleImageNaturalFacePart(part = "") {
  return /正常清晰人脸|自然清晰人脸|清晰人脸|正常人脸/.test(String(part || "").trim());
}

function isRoleImageThreeViewPart(part = "") {
  const text = String(part || "").trim();
  return /三视图|正面.*侧面.*背面|正\/侧\/背|正侧背/.test(text);
}

function splitRoleImagePromptParts(prompt = "") {
  return String(prompt || "")
    .split(/[，,]/)
    .map((part) => normalizeRoleImagePromptPart(part))
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !roleImagePromptDeprecatedSegments.has(part));
}

function isValidRoleProfile(profile = {}) {
  return Boolean(
    usefulRoleValue(profile.name) &&
    usefulRoleValue(profile.traits) &&
    usefulRoleValue(profile.realisticImagePrompt)
  );
}

function isSavableRoleProfile(profile = {}) {
  const roleImages = Array.isArray(profile.roleImages) ? profile.roleImages : [];
  return Boolean(
    usefulRoleValue(profile.name) ||
    usefulRoleValue(profile.traits) ||
    usefulRoleValue(profile.realisticImagePrompt) ||
    roleImages.some((image) => image.imageUrl || image.thumbnailUrl || image.imageError || image.prompt || image.note)
  );
}

function parseRoleAnalysisFields(text = "") {
  return {
    name: extractRoleField(text, ["角色名字", "角色名称", "name"]),
    traits: extractRoleField(text, ["角色定义", "角色特征", "角色描述", "traits"]),
    realisticImagePrompt: extractRoleField(text, ["角色绘画提示词", "绘画提示词", "realistic_image_prompt", "image_prompt", "realisticImagePrompt", "imagePrompt"]),
  };
}

function extractRoleField(text = "", labels = []) {
  const allLabels = ["角色名字", "角色名称", "name", "角色定义", "角色特征", "角色描述", "traits", "角色绘画提示词", "绘画提示词", "realistic_image_prompt", "image_prompt", "realisticImagePrompt", "imagePrompt"];
  const targets = labels.map(escapeRegExp).join("|");
  const others = allLabels.filter((label) => !labels.includes(label)).map(escapeRegExp).join("|");
  const labelPrefix = "(?:^|\\n)\\s*(?:[-*•]\\s*)?(?:[\"“”']?)(?:";
  const labelSuffix = ")(?:[\"“”']?)\\s*[:：]\\s*";
  const pattern = new RegExp(`${labelPrefix}${targets}${labelSuffix}([\\s\\S]*?)(?=${labelPrefix}${others}${labelSuffix}|$)`);
  return compactProductField(String(text || "").match(pattern)?.[1] || "");
}

function usefulRoleValue(value = "") {
  const text = String(value || "").trim();
  return Boolean(text && !/^(视频未提及|未提及|暂无|没有|未命名角色)$/.test(text));
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRoleAnalysisText(fields = {}) {
  const normalized = normalizeRoleProfileFields(fields);
  return `【角色资料】
角色名字：${normalized.name}
角色定义：${normalized.traits}
角色绘画提示词：${normalized.realisticImagePrompt}`;
}

function buildRoleProfilesAnalysisText(profiles = []) {
  const normalized = profiles.map((profile, index) => normalizeRoleProfileFields(profile, `角色${index + 1}`));
  return JSON.stringify({
    角色数量: normalized.length,
    角色列表: normalized.map((profile) => ({
      角色名字: profile.name,
      角色定义: profile.traits,
      角色绘画提示词: profile.realisticImagePrompt,
    })),
  }, null, 2);
}

function parseJsonLikeText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const withoutFence = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const candidates = [
    withoutFence,
    withoutFence.match(/\{[\s\S]*\}/)?.[0] || "",
    withoutFence.match(/\[[\s\S]*\]/)?.[0] || "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function techniqueItemsFromAnalysis(type, text = "", fallbackName = "") {
  const parsed = parseJsonLikeText(text);
  const rawItems = techniqueItemsFromParsedJson(type, parsed);
  const jsonItems = rawItems
    .map((item, index) => normalizeTechniqueItem(type, item, fallbackName, index))
    .filter((item) => item.name && item.prompt);
  if (jsonItems.length) return jsonItems;
  return techniqueItemsFromLabeledText(type, text, fallbackName);
}

function techniqueItemsFromParsedJson(type, parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  const keys = type === "hook"
    ? ["爆款开头列表", "开头列表", "钩子列表", "hooks", "hotHooks", "items", "results"]
    : ["爆款元素列表", "元素列表", "hotElements", "elements", "items", "results"];
  for (const key of keys) {
    const value = parsed?.[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value).filter((item) => item && typeof item === "object");
  }
  const nestedSources = [parsed.data, parsed.result, parsed.output, parsed.analysis].filter(Boolean);
  for (const source of nestedSources) {
    const nested = techniqueItemsFromParsedJson(type, source);
    if (nested.length) return nested;
  }
  if (firstTechniqueField(type, parsed, techniqueNameKeys(type))) return [parsed];
  return [];
}

function normalizeTechniqueItem(type, item = {}, fallbackName = "", index = 0) {
  const name = firstTechniqueField(type, item, techniqueNameKeys(type)) || `${fallbackName || assetUnitLabel(type)} ${String(index + 1).padStart(2, "0")}`;
  const desc = firstTechniqueField(type, item, ["摘要", "一句话说明", "简介", "summary", "description", "desc"]);
  const tag = firstTechniqueField(type, item, ["标签", "标签列表", "tags", "tag", "关键词"]);
  const prompt = firstTechniqueField(type, item, ["可复用内容", "分析结果", "内容", "技巧说明", "模板", "复用模板", "prompt", "content", "detail"]) || techniqueItemToText(type, item);
  return {
    name: compactProductField(name),
    desc: compactProductField(desc),
    tag: compactProductField(tag),
    prompt: String(prompt || "").trim(),
  };
}

function techniqueNameKeys(type) {
  return type === "hook"
    ? ["开头名称", "爆款开头名称", "钩子名称", "名称", "标题", "name", "title"]
    : ["元素名称", "爆款元素名称", "名称", "标题", "name", "title"];
}

function firstTechniqueField(type, item = {}, keys = []) {
  if (!item || typeof item !== "object") return "";
  for (const key of keys) {
    const value = item[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) return value.map((part) => compactProductField(part)).filter(Boolean).join("、");
    if (typeof value === "object") return techniqueItemToText(type, value);
    const text = compactProductField(value);
    if (text) return text;
  }
  return "";
}

function techniqueItemToText(type, item = {}) {
  if (!item || typeof item !== "object") return "";
  const excluded = new Set([...techniqueNameKeys(type), "摘要", "一句话说明", "简介", "summary", "description", "desc", "标签", "标签列表", "tags", "tag", "关键词"]);
  return Object.entries(item)
    .filter(([key, value]) => !excluded.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}：${Array.isArray(value) ? value.join("、") : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}`)
    .join("\n")
    .trim();
}

function techniqueItemsFromLabeledText(type, text = "", fallbackName = "") {
  const body = String(text || "").trim();
  if (!body) return [];
  const label = type === "hook" ? "开头名称|爆款开头名称|钩子名称" : "元素名称|爆款元素名称";
  const matches = Array.from(body.matchAll(new RegExp(`(?:^|\\n)\\s*(?:[-*\\d.、]+\\s*)?(?:${label})\\s*[:：]\\s*([^\\n]+)`, "g")));
  if (!matches.length) {
    return body ? [{
      name: fallbackName || (type === "hook" ? "爆款开头" : "爆款元素"),
      desc: firstNonEmptyLine(body),
      tag: "",
      prompt: body,
    }] : [];
  }
  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = matches[index + 1]?.index || body.length;
    const block = body.slice(start, end).trim();
    return {
      name: compactProductField(match[1] || `${fallbackName} ${index + 1}`),
      desc: compactProductField(extractSimpleLabeledValue(block, ["摘要", "一句话说明", "简介"])) || firstNonEmptyLine(block),
      tag: compactProductField(extractSimpleLabeledValue(block, ["标签", "关键词"])),
      prompt: compactProductField(extractSimpleLabeledValue(block, ["可复用内容", "分析结果", "内容"])) || block,
    };
  }).filter((item) => item.name && item.prompt);
}

function extractSimpleLabeledValue(text = "", labels = []) {
  const target = labels.map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${target})\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:开头名称|爆款开头名称|钩子名称|元素名称|爆款元素名称|摘要|一句话说明|简介|标签|关键词|可复用内容|分析结果|内容)\\s*[:：]|$)`);
  return String(text || "").match(pattern)?.[1] || "";
}

function firstNonEmptyLine(text = "") {
  return String(text || "").split(/\n+/).map((line) => line.trim()).find(Boolean) || "";
}

async function generateRoleImageDesignsForProfile(profile = {}, settings = {}) {
  const normalized = normalizeRoleProfileFields(profile);
  const count = clampRoleImageDesignCount(settings.count || 1);
  const promptItems = roleImageDesignPromptItems(normalized, count, settings.roleImageType, settings.roleImageCustomPrompt);
  const now = new Date().toISOString();
  const roleImages = [];
  for (let index = 0; index < promptItems.length; index += 1) {
    const promptItem = promptItems[index];
    const prompt = promptItem.prompt;
    try {
      const roleImage = await generateRoleProfileImage({
        profile: normalized,
        prompt,
        imageKeyId: settings.imageKeyId,
        imageModelId: settings.imageModelId,
        imageRatio: settings.imageRatio,
        imageResolution: settings.imageResolution,
        imageFormat: settings.imageFormat,
      });
      roleImages.push(normalizeRoleImageItem({
        id: crypto.randomUUID(),
        source: "generated",
        designIndex: index + 1,
        variantLabel: promptItem.variantLabel,
        variantPrompt: promptItem.variantPrompt,
        prompt,
        imageUrl: roleImage.imageUrl || "",
        thumbnailUrl: roleImage.thumbnailUrl || "",
        imageError: "",
        status: "done",
        imageKeyId: settings.imageKeyId,
        imageModelId: settings.imageModelId,
        imageRatio: settings.imageRatio,
        imageResolution: settings.imageResolution,
        imageFormat: settings.imageFormat,
        createdAt: now,
        updatedAt: now,
        isDefault: index === 0,
      }, index, prompt));
    } catch (error) {
      roleImages.push(normalizeRoleImageItem({
        id: crypto.randomUUID(),
        source: "generated",
        designIndex: index + 1,
        variantLabel: promptItem.variantLabel,
        variantPrompt: promptItem.variantPrompt,
        prompt,
        imageUrl: "",
        thumbnailUrl: "",
        imageError: error.message || "角色图片生成失败。",
        status: "error",
        imageKeyId: settings.imageKeyId,
        imageModelId: settings.imageModelId,
        imageRatio: settings.imageRatio,
        imageResolution: settings.imageResolution,
        imageFormat: settings.imageFormat,
        createdAt: now,
        updatedAt: now,
        isDefault: index === 0,
      }, index, prompt));
    }
  }
  return normalizeRoleProfileFields({
    ...normalized,
    roleImages,
    defaultImageId: roleImages[0]?.id || "",
  });
}

async function generateRoleImageDesignsForProfiles(profiles = [], settings = {}) {
  const safeProfiles = (Array.isArray(profiles) ? profiles : [])
    .map((profile, index) => normalizeRoleProfileFields(profile, `角色${index + 1}`));
  const total = safeProfiles.length * clampRoleImageDesignCount(settings.count || 1);
  let completed = 0;
  const workingProfiles = safeProfiles.map((profile) => {
    const placeholders = roleImagePlaceholderItems(profile, settings);
    return normalizeRoleProfileFields({
      ...profile,
      roleImages: placeholders,
      defaultImageId: placeholders[0]?.id || "",
    }, profile.name);
  });
  await Promise.resolve(settings.onProgress?.(workingProfiles, { completed, total })).catch(() => {});

  const tasks = workingProfiles.flatMap((profile, profileIndex) => (
    (Array.isArray(profile.roleImages) ? profile.roleImages : []).map((image) => ({
      profileIndex,
      imageId: image.id,
    }))
  ));
  const concurrency = Math.max(1, Math.min(2, Number(settings.concurrency || 2)));
  let taskCursor = 0;

  async function runRoleImageTask(task) {
    const profile = workingProfiles[task.profileIndex];
    const roleImages = Array.isArray(profile?.roleImages) ? profile.roleImages : [];
    const imageIndex = roleImages.findIndex((image) => image.id === task.imageId);
    if (imageIndex < 0) return;
    const currentImage = roleImages[imageIndex];
    const prompt = String(currentImage.prompt || profile.realisticImagePrompt || "").trim();
    let nextImage;
    try {
      const roleImage = await generateRoleProfileImage({
        profile,
        prompt,
        imageKeyId: settings.imageKeyId,
        imageModelId: settings.imageModelId,
        imageRatio: settings.imageRatio,
        imageResolution: settings.imageResolution,
        imageFormat: settings.imageFormat,
      });
      nextImage = {
        ...currentImage,
        imageUrl: roleImage.imageUrl || "",
        thumbnailUrl: roleImage.thumbnailUrl || "",
        imageError: "",
        status: "done",
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      nextImage = {
        ...currentImage,
        imageUrl: "",
        thumbnailUrl: "",
        imageError: error.message || "角色图片生成失败。",
        status: "error",
        updatedAt: new Date().toISOString(),
      };
    }

    const latestProfile = workingProfiles[task.profileIndex];
    const latestImages = Array.isArray(latestProfile?.roleImages) ? latestProfile.roleImages : [];
    const latestImageIndex = latestImages.findIndex((image) => image.id === task.imageId);
    if (latestImageIndex >= 0) {
      const nextImages = latestImages.map((image, index) => index === latestImageIndex ? nextImage : image);
      workingProfiles[task.profileIndex] = normalizeRoleProfileFields({
        ...latestProfile,
        roleImages: nextImages,
        defaultImageId: latestProfile.defaultImageId || nextImages[0]?.id || "",
      }, latestProfile.name);
    }
    completed += 1;
    await Promise.resolve(settings.onProgress?.(workingProfiles, { completed, total })).catch(() => {});
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (taskCursor < tasks.length) {
      const task = tasks[taskCursor];
      taskCursor += 1;
      await runRoleImageTask(task);
    }
  }));

  return workingProfiles.map((profile, index) => normalizeRoleProfileFields(profile, `角色${index + 1}`));
}

function roleImagePlaceholderItems(profile = {}, settings = {}) {
  const promptItems = roleImageDesignPromptItems(profile, settings.count || 1, settings.roleImageType, settings.roleImageCustomPrompt);
  const now = new Date().toISOString();
  return promptItems.map((promptItem, index) => normalizeRoleImageItem({
    id: crypto.randomUUID(),
    source: "generated",
    designIndex: index + 1,
    variantLabel: promptItem.variantLabel,
    variantPrompt: promptItem.variantPrompt,
    prompt: promptItem.prompt,
    imageUrl: "",
    thumbnailUrl: "",
    imageError: "",
    status: "pending",
    imageKeyId: settings.imageKeyId,
    imageModelId: settings.imageModelId,
    imageRatio: settings.imageRatio,
    imageResolution: settings.imageResolution,
    imageFormat: settings.imageFormat,
    createdAt: now,
    updatedAt: now,
    isDefault: index === 0,
  }, index, promptItem.prompt));
}

function roleImageDesignPrompts(profile = {}, count = 1, roleImageType = defaultRoleImageType, roleImageCustomPrompt = "") {
  return roleImageDesignPromptItems(profile, count, roleImageType, roleImageCustomPrompt).map((item) => item.prompt);
}

function roleImageDesignPromptItems(profile = {}, count = 1, roleImageType = defaultRoleImageType, roleImageCustomPrompt = "") {
  const normalizedType = normalizeRoleImageType(roleImageType);
  return Array.from({ length: clampRoleImageDesignCount(count) }, (_, index) => {
    const variant = roleImageDesignVariant(index);
    const prompt = composeRoleImageGenerationPrompt(profile.realisticImagePrompt, index, normalizedType, roleImageCustomPrompt);
    return {
      variantLabel: variant.label,
      variantPrompt: variant.prompt,
      prompt,
    };
  });
}

function composeRoleImageGenerationPrompt(basePrompt = "", index = 0, roleImageType = defaultRoleImageType, roleImageCustomPrompt = "") {
  const normalizedType = normalizeRoleImageType(roleImageType);
  const normalizedBasePrompt = normalizeRoleImagePrompt(String(basePrompt || "").trim(), roleImageRequiredSegmentsForType(normalizedType));
  const baseParts = splitRoleImagePromptParts(normalizedBasePrompt);
  const identityParts = roleImageIdentityPartsFromPromptParts(baseParts);
  const originalOutfitParts = roleImageOutfitPartsFromPromptParts(baseParts);
  const outfitPrompt = roleImageOutfitPromptForVariant(index, originalOutfitParts, identityParts);
  const styleParts = roleImageStylePartsForType(normalizedType, roleImageCustomPrompt);
  return uniquePromptParts([...identityParts, outfitPrompt, ...styleParts]).join("，");
}

function roleImageIdentityPartsFromPromptParts(parts = []) {
  return uniquePromptParts(parts.filter((part) => (
    !isRoleImageStylePart(part) &&
    !isRoleImageOutfitPart(part)
  )));
}

function roleImageOutfitPartsFromPromptParts(parts = []) {
  return uniquePromptParts(parts.filter((part) => (
    !isRoleImageStylePart(part) &&
    isRoleImageOutfitPart(part)
  )));
}

function roleImageOutfitPromptForVariant(index = 0, originalOutfitParts = [], identityParts = []) {
  const originalOutfit = uniquePromptParts(originalOutfitParts).join("，");
  if (index === 0 && originalOutfit) return originalOutfit;
  const style = roleImageOutfitVariantStyle([...identityParts, originalOutfit].join("，"));
  const variants = roleImageOutfitVariantPrompts(style);
  return variants[Math.max(0, index - 1) % variants.length] || roleImageDesignVariant(index).prompt;
}

function roleImageOutfitVariantStyle(text = "") {
  if (/董事|总裁|经理|老板|商务|职场|助理|秘书|律师|西装|衬衫|领带/.test(text)) return "business";
  if (/农村|朴素|老人|老年|老太|老大爷|老爷爷|老奶奶/.test(text)) return "plain";
  if (/女性|女人|女生|女孩|裙|连衣裙|半身裙/.test(text)) return "soft";
  return "neutral";
}

function roleImageOutfitVariantPrompts(style = "neutral") {
  const variants = {
    business: [
      "穿着深灰色西装外套，内搭浅色衬衫，下穿黑色西裤，鞋履简洁",
      "穿着深蓝色商务外套，内搭中性色上衣，下穿深色长裤，材质更柔和",
      "穿着低饱和色系正式套装，外层与长裤剪裁合身，整体颜色比默认造型略有变化",
      "穿着简洁商务替换服装，浅色内搭配深色外层和长裤，整体干净利落",
    ],
    plain: [
      "穿着朴素灰色外套，内搭浅色上衣，下穿深色直筒长裤，鞋履简洁",
      "穿着低饱和色系日常上衣和长裤，面料自然朴素，整体更柔和",
      "穿着简洁生活感套装，外层与下装颜色略有变化，气质质朴",
      "穿着符合年龄和身份的简洁替换服装，浅色内搭配深色外层和长裤",
    ],
    soft: [
      "穿着米色中长款外套，内搭浅色上衣，下穿深色半身裙，鞋履简洁",
      "穿着低饱和色系柔和套装，内搭纯色上衣，下装颜色更浅，材质更柔和",
      "穿着同风格日常套装，外层与下装剪裁合身，整体颜色比默认造型略有变化",
      "穿着简洁替换服装，浅色内搭配中性色外层和下装，整体干净利落",
    ],
    neutral: [
      "穿着同身份同季节的深灰色简洁外套，内搭浅色上衣，下穿深色长裤，鞋履简洁",
      "穿着低饱和色系中长款外套，内搭纯色上衣，下穿中性色长裤，材质更柔和",
      "穿着同风格备用套装，外层与下装剪裁合身，整体颜色比默认造型略有变化",
      "穿着符合角色身份的简洁替换服装，浅色内搭配深色外层和长裤，整体干净利落",
    ],
  };
  return variants[style] || variants.neutral;
}

function roleImageStylePartsForType(roleImageType = defaultRoleImageType, roleImageCustomPrompt = "") {
  const normalizedType = normalizeRoleImageType(roleImageType);
  const baseSegments = roleImagePromptRequiredSegments.filter((segment) => (
    normalizedType !== "mosaic-three" || !isRoleImageNaturalFacePart(segment)
  ));
  if (normalizedType === "single") {
    return uniquePromptParts([...baseSegments, "正常清晰人脸", "单人角色设计图"]);
  }
  if (normalizedType === "sketch-three") {
    return uniquePromptParts([...baseSegments, "左侧：人物脸部大特写肖像，右侧：全身三视图转面展示，包含正面、侧面、背面"]);
  }
  if (normalizedType === "mosaic-three") {
    return uniquePromptParts([...baseSegments, "人物脸部打上马赛克", "其他部分保持真实摄影", "三视图", "正面、侧面、背面同屏排列"]);
  }
  if (normalizedType === "custom") {
    return uniquePromptParts([...baseSegments, ...splitRoleImagePromptParts(roleImageCustomPrompt)]);
  }
  return baseSegments;
}

function isRoleImageStylePart(part = "") {
  const text = String(part || "").trim();
  return Boolean(
    roleImagePromptRequiredSegments.some((segment) => text.includes(segment)) ||
    isRoleImageFaceMosaicPart(text) ||
    isRoleImageSketchFacePart(text) ||
    isRoleImageHeadshotThreeViewPart(text) ||
    isRoleImageNaturalFacePart(text) ||
    isRoleImageThreeViewPart(text) ||
    /单人角色设计图|素描三视图|正面.*侧面.*背面|横屏|同屏排列|真实摄影|摄影棚背景|背景中没有任何物体或人物|保持人物核心特征一致|其他部分保持真实摄影/.test(text)
  );
}

function isRoleImageOutfitPart(part = "") {
  return /(?:穿着|身穿|内搭|外套|上衣|衬衫|T恤|毛衣|风衣|夹克|西装|套装|连衣裙|半身裙|裙|裤|长裤|短裤|鞋|靴|马甲|领带|高领|卫衣|制服|工装|旗袍|汉服|围裙|披肩|衣服|服装|下穿|上身|下身)/.test(String(part || "").trim());
}

function roleImageDesignVariant(index = 0) {
  return roleImageDesignVariants[index] || {
    label: `备用造型 ${index + 1}`,
    prompt: "穿着符合角色身份的简洁备用服装，整体颜色和材质轻微变化",
  };
}

function applyRoleImageTypeToPrompt(prompt = "", roleImageType = defaultRoleImageType) {
  const normalizedType = normalizeRoleImageType(roleImageType);
  const parts = splitRoleImagePromptParts(prompt);
  const withoutFaceOverrides = parts.filter((part) => (
    !isRoleImageFaceMosaicPart(part) &&
    !isRoleImageSketchFacePart(part) &&
    !isRoleImageNaturalFacePart(part)
  ));
  if (normalizedType === "single") {
    return uniquePromptParts([
      ...parts.filter((part) => !isRoleImageFaceMosaicPart(part) && !isRoleImageSketchFacePart(part) && !isRoleImageThreeViewPart(part)),
      "正常清晰人脸",
      "单人角色设计图",
    ]).join("，");
  }
  if (normalizedType === "sketch-three") {
    return uniquePromptParts([
      ...withoutFaceOverrides.filter((part) => !isRoleImageThreeViewPart(part) && !isRoleImageHeadshotThreeViewPart(part)),
      "正常清晰人脸",
      "左侧：人物脸部大特写肖像，右侧：全身三视图转面展示，包含正面、侧面、背面",
    ]).join("，");
  }
  if (normalizedType === "mosaic-three") {
    return uniquePromptParts([
      ...withoutFaceOverrides,
      "人物脸部打上马赛克",
      "其他部分保持真实摄影",
      "三视图",
    ]).join("，");
  }
  if (normalizedType === "custom") {
    return uniquePromptParts(parts.filter((part) => !isRoleImageFaceMosaicPart(part) && !isRoleImageSketchFacePart(part) && !isRoleImageThreeViewPart(part))).join("，");
  }
  return uniquePromptParts(parts).join("，");
}

function uniquePromptParts(parts = []) {
  const result = [];
  parts.forEach((part) => {
    const text = String(part || "").trim();
    if (text && !result.includes(text)) result.push(text);
  });
  return result;
}

async function generateRoleProfileImage({ profile, prompt: promptOverride = "", imageKeyId, imageModelId, imageRatio, imageResolution, imageFormat }) {
  const prompt = String(promptOverride || profile?.realisticImagePrompt || "").trim();
  if (!prompt || prompt === "视频未提及") throw new Error("角色绘画提示词为空，无法生成角色图。");
  if (!imageKeyId) throw new Error("缺少绘画渠道，无法生成角色图。");
  const model = roleImageModels.find((item) => item.id === imageModelId || item.modelId === imageModelId);
  const result = await generateImages({
    apiKeyId: imageKeyId,
    modelId: model?.modelId || imageModelId || defaultRoleImageModel,
    prompt,
    ratio: imageRatio || "1:1",
    resolution: imageResolution || "1k",
    format: imageFormat || "png",
    count: 1,
  });
  const imageObject = extractFirstImageObjectFromResponse(result);
  const imageUrl = resolveFlowStudioFileUrl(imageObject.imageUrl || "") || extractImagesFromResponse(result).map(resolveFlowStudioFileUrl).find(Boolean) || "";
  if (!imageUrl) throw new Error("角色图片生成完成，但没有返回可显示图片。");
  return {
    imageUrl,
    thumbnailUrl: resolveFlowStudioFileUrl(imageObject.thumbnailUrl || ""),
    imageError: "",
  };
}

function extractFirstImageObjectFromResponse(data) {
  const item = Array.isArray(data?.imageObjects) ? data.imageObjects[0] : null;
  if (item) {
    return {
      imageUrl: item.url || item.imageUrl || item.fileUrl || "",
      thumbnailUrl: item.thumbnailUrl || item.imageThumbnailUrl || "",
    };
  }
  return { imageUrl: "", thumbnailUrl: "" };
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

function extractProductField(text = "", label = "", aliases = []) {
  const labels = productAnalysisFieldDefinitions.flatMap((field) => [field.label, ...(field.aliases || [])]);
  const targets = [label, ...aliases];
  const others = labels.filter((item) => !targets.includes(item)).join("|");
  const targetPattern = targets.join("|");
  const labelPrefix = "(?:^|\\n)\\s*(?:[-*•]\\s*)?(?:【)?(?:\\*\\*)?";
  const labelSuffix = "(?:\\*\\*)?(?:】)?\\s*[:：]\\s*";
  const pattern = new RegExp(`${labelPrefix}(?:${targetPattern})${labelSuffix}([\\s\\S]*?)(?=${labelPrefix}(?:${others})${labelSuffix}|$)`);
  return compactProductField(String(text || "").match(pattern)?.[1] || "");
}

function compactProductField(value = "") {
  return String(value)
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-*•\s]+/, "")
    .trim();
}

function assetSavedMessage(type) {
  if (type === "prompt") return "提示词已保存。";
  if (type === "visual-style") return "图风已保存。";
  if (type === "writing-style") return "文风已保存。";
  if (type === "script") return "脚本资产已保存。";
  if (type === "role") return "角色资产已保存。";
  if (type === "hook") return "爆款开头已保存。";
  if (type === "element") return "爆款元素已保存。";
  if (type === "product") return "带货产品已保存。";
  return "资产已保存。";
}

function videoAnalysisUploadRequiredMessage(type) {
  if (type === "script") return "请上传需要拆解的对标视频。";
  if (type === "role") return "请上传需要提取角色信息的视频。";
  if (type === "hook") return "请上传需要提取爆款开头的视频。";
  if (type === "element") return "请上传需要提取爆款元素的视频。";
  return "请上传需要提取产品信息的视频。";
}

function videoAnalysisAssetNameRequiredMessage(type) {
  if (type === "script") return "请先填写脚本资产名称。";
  if (type === "role") return "请先填写角色资产名称。";
  if (type === "hook" || type === "element") return "请先填写视频素材名称。";
  return "请先填写产品资产名称。";
}

function videoAnalysisStatusLabel(asset = {}) {
  if (isVideoAnalysisTimedOut(asset)) return "视频分析超时";
  if (asset.analysisStatus === "running") return videoAnalysisRunningStatusLabel(asset);
  if (isVideoAnalysisFailed(asset)) return "视频提取失败";
  const roleImageStatus = asset.type === "role" ? effectiveRoleImageGenerationStatus(asset) : "";
  if (asset.analysisStatus === "done" && asset.type === "role" && roleImageStatus === "running") return "角色图生成中";
  if (asset.analysisStatus === "done" && asset.type === "role" && roleImageStatus === "partial") return "角色图部分完成";
  if (asset.analysisStatus === "done" && asset.type === "role" && roleImageStatus === "error") return "角色图生成失败";
  if (asset.analysisStatus === "done") return "已完成视频提取";
  return "等待上传视频";
}

function videoAnalysisRunningStatusLabel(asset = {}) {
  const retryText = videoAnalysisRetryText(asset);
  return retryText
    ? `视频提取中 · ${retryText} · ${formatElapsedDuration(videoAnalysisElapsedMs(asset))}`
    : `视频提取中 · ${formatElapsedDuration(videoAnalysisElapsedMs(asset))}`;
}

function videoAnalysisRunningText(asset = {}) {
  const retryText = videoAnalysisRetryText(asset);
  const elapsedText = formatElapsedDuration(videoAnalysisElapsedMs(asset));
  const retryMessage = asset.analysisRetryMessage ? `最近一次错误：${asset.analysisRetryMessage}。` : "";
  const statusText = retryText
    ? `视频提取中，${retryText}，已等待 ${elapsedText}。${retryMessage}`
    : `视频提取中，已等待 ${elapsedText}。`;
  return `${statusText}超过 ${formatVideoAnalysisTimeout(asset)} 会自动标记失败，请勿重复提交以免重复扣费。`;
}

function videoAnalysisRetryText(asset = {}) {
  const retryCount = positiveInteger(asset.analysisRetryCount);
  if (!retryCount) return "";
  const maxRetries = positiveInteger(asset.analysisMaxRetries) || Math.max(0, videoAnalysisRetryAttempts(asset.type) - 1);
  return maxRetries ? `重试第 ${retryCount} 次 / 共 ${maxRetries} 次` : `重试第 ${retryCount} 次`;
}

function videoAnalysisCardBadge(asset = {}) {
  if (isVideoAnalysisTimedOut(asset)) return "超时";
  if (asset.analysisStatus === "running") return "提取中";
  if (isVideoAnalysisFailed(asset)) return "失败";
  const roleImageStatus = asset.type === "role" ? effectiveRoleImageGenerationStatus(asset) : "";
  if (asset.analysisStatus === "done" && asset.type === "role" && roleImageStatus === "running") return "生图中";
  if (asset.analysisStatus === "done" && asset.type === "role" && roleImageStatus === "partial") return "部分完成";
  if (asset.analysisStatus === "done" && asset.type === "role" && roleImageStatus === "error") return "图片失败";
  if (asset.analysisStatus === "done") return asset.shared ? "团队" : "个人";
  return "待分析";
}

function isVideoAnalysisFailed(asset = {}) {
  if (isVideoAnalysisTimedOut(asset)) return true;
  if (asset.analysisStatus === "error") return true;
  if (asset.analysisStatus === "running") return false;
  return asset.analysisStatus === "done" && Boolean(asset.prompt || asset.analysisError) && isMissingVideoAnalysisResponse(asset.prompt || asset.analysisError || "");
}

function isVideoAnalysisTimedOut(asset = {}) {
  return asset.analysisStatus === "running" && videoAnalysisElapsedMs(asset) > videoAnalysisTimeoutMsForAsset(asset);
}

function videoAnalysisElapsedMs(asset = {}) {
  const timestamp = new Date(asset.analysisStartedAt || asset.createdAt || asset.updatedAt || 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return Math.max(0, Date.now() - timestamp);
}

function videoAnalysisTimeoutMessage(asset = {}) {
  return `视频分析超过 ${formatVideoAnalysisTimeout(asset)} 未完成，已自动标记为失败。模型请求可能已经提交到渠道侧；请确认渠道支持视频输入后再重新上传。${asset.analysisModelId ? `模型：${asset.analysisModelId}` : ""}`;
}

function formatElapsedDuration(value = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

function assetUnitLabel(type) {
  if (type === "prompt") return "提示词";
  if (type === "visual-style") return "图风";
  if (type === "writing-style") return "文风";
  if (type === "script") return "脚本";
  if (type === "role") return "角色";
  if (type === "hook") return "开头";
  if (type === "element") return "元素";
  if (type === "product") return "产品";
  return "资产";
}

function assetDescPlaceholder(type) {
  if (type === "script") return "一句话概括脚本结构、节奏或适用品类";
  if (type === "role") return "一句话概括角色人设、语气和镜头表现";
  if (type === "hook") return "一句话说明开头钩子逻辑";
  if (type === "element") return "一句话说明元素用途和适用阶段";
  if (type === "product") return "一句话概括产品核心卖点";
  return "一句话描述这个资产";
}

function assetPromptPlaceholder(type) {
  if (type === "script") return "粘贴对标视频分析：主题、结构、分段节奏、转折、CTA、可复用模板...";
  if (type === "role") return "粘贴角色分析：人设定位、外貌特征、说话风格、动作习惯、镜头表现...";
  if (type === "hook") return "粘贴爆款开头：原始文案、开头类型、钩子逻辑、可替换模板、适用品类...";
  if (type === "element") return "粘贴爆款元素：元素类型、适用阶段、插入方式、示例文案、风险提示...";
  if (type === "product") return "粘贴产品信息：核心卖点、目标人群、痛点场景、价格规格、合规禁忌、推荐 CTA...";
  return "输入可复用内容";
}

function compactText(value = "") {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 110 ? `${text.slice(0, 110)}...` : text;
}

function stripExtension(fileName = "") {
  return String(fileName).replace(/\.[^.]+$/, "");
}

function formatAssetDate(value) {
  if (!value) return "已保存";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "已保存";
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function formatBytes(value = 0) {
  const size = Number(value || 0);
  if (!size) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatVideoDuration(value = 0) {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0)));
  if (!totalSeconds) return "待识别";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatVideoTimestamp(value = 0) {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function readVideoDuration(file) {
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

function readFileAsDataUrl(file) {
  if (typeof FileReader === "undefined" || !file) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });
}

function withTimeout(promise, timeoutMs, message = "请求超时，请稍后重试。") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}
