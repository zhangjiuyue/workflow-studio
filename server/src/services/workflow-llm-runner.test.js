import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
const providerFixtureDir = mkdtempSync(path.join(tmpdir(), "workflow-llm-provider-"));
const providerFixturePath = path.join(providerFixtureDir, "providers.json");
writeFileSync(providerFixturePath, JSON.stringify([{ channel: "Synthetic Text", services: {
  llm: { endpoint: "https://text.example.com/v1", models: ["test-text-model", "test-vision-model"] }
} }]));
process.env.WORKFLOW_PROVIDER_CONFIG = providerFixturePath;
process.on("exit", () => rmSync(providerFixtureDir, { recursive: true, force: true }));
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { saveApiKey } from "./api-key-store.js";
import { assertWorkflowTopicSourceReady, executeWorkflowLlmNode } from "./workflow-llm-runner.js";
import { ensureUser } from "./user-store.js";
import { createWorkflow, createWorkflowRun, getWorkflowRun } from "./workflow-store.js";

test("direct-video topics cannot run without a completed parsed script", () => {
  assert.throws(() => assertWorkflowTopicSourceReady({
    type: "story",
    storyScriptSourceMode: "direct",
    storyVideoSource: { analysisStatus: "error" },
    ecommerceAssets: { scripts: null },
  }), (error) => error?.status === 409 && /不能跳过视频解析/.test(error?.message));

  assert.doesNotThrow(() => assertWorkflowTopicSourceReady({
    type: "story",
    storyScriptSourceMode: "direct",
    storyVideoSource: { analysisStatus: "pending" },
    ecommerceAssets: { scripts: { prompt: "structured reference script" } },
  }));
  assert.doesNotThrow(() => assertWorkflowTopicSourceReady({
    type: "story",
    storyScriptSourceMode: "library",
    ecommerceAssets: { scripts: { prompt: "library script" } },
  }));
});

test("ecommerce custom topic mode uses adaptation ideas to generate topic outlines", async () => {
  const { config, user, run, cleanup } = await createEcommerceCustomTopicFixture({
    storyEnvironment: "united-states",
  });
  const generatedOutline = `1、婆媳身份互换后的办公室反转
【主要角色】
李秀兰：58岁退休会计，女老板的母亲，外表朴素但判断敏锐。
周雅雯：36岁公司老板，李秀兰的女儿，因职场关系与母亲产生误会。

【开场场景】
穿西装的年轻女老板站在会议室门口，母亲拎着资料袋冲进来，员工们错愕回头。

【故事梗概】
母亲误以为女儿被老板刁难，赶到公司理论，却发现男女主身份互换后真正的冲突来自职场关系误判，产品在化解误会的生活场景中自然出现。`;
  const fetchCalls = mockLlmFetch(generatedOutline);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "topic",
      llmKeyId: "llm-key",
      topicModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const systemPrompt = requestBody.messages[0].content;
    const prompt = requestBody.messages[1].content;
    assert.match(systemPrompt, /你是资深剧情带货的短视频选题策划/);
    assert.match(prompt, /【自定义改编思路】/);
    assert.match(prompt, /男女主角互换/);
    assert.match(prompt, /后续带货脚本中的角色对白必须使用德语/);
    assert.match(prompt, /只约束角色说出口的台词/);
    assert.match(prompt, /【用户画像】[\s\S]*目标观看人群为35-50岁/);
    assert.match(prompt, /低优先级辅助参考/);
    assert.match(prompt, /不是题材指令、剧情指令或角色设定/);
    assert.match(prompt, /如果无法自然体现，就保持原逻辑，不必强行体现用户画像/);
    assert.doesNotMatch(prompt, /婚姻家庭、子女教育、赡养老人、职场责任/);
    assert.match(prompt, /【剧情环境】[\s\S]*明确指定为美国/);
    assert.match(prompt, /角色姓名必须符合美国当地常见的语言、姓名结构、年代和文化习惯/);
    assert.match(prompt, /住宅类型、建筑外观、房间布局、家具陈设、日常用品/);
    assert.match(prompt, /剧情环境与对白语言是两个独立配置/);
    assert.match(prompt, /【角色命名规则】/);
    assert.match(prompt, /剧情环境已指定为美国/);
    assert.match(prompt, /如果不符合，只把姓名本地化为美国自然姓名，不得借此改变角色身份、年龄、性别、人物关系或剧情作用/);
    assert.match(prompt, /禁止把“富豪奶奶、大儿子、大儿媳/);
    assert.match(prompt, /【主要角色】/);
    assert.match(prompt, /\[人物姓名\]：\[年龄层、职业或家庭身份、人物关系和剧情定位\]/);
    assert.match(prompt, /请连续输出 1 个选题大纲/);
    assert.doesNotMatch(prompt, /【角色库姓名优先】/);
    assert.deepEqual(result.topics, [generatedOutline]);
    assert.notDeepEqual(result.topics, ["男女主角互换，母亲来找女儿，男老板是老板"]);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce topic mode omits audience targeting when audience is unspecified", async () => {
  const { config, user, run, cleanup } = await createEcommerceCustomTopicFixture({
    audienceProfile: "unspecified",
  });
  const generatedOutline = `1、办公室里的身份误会
【主要角色】
李秀兰：退休会计，周雅雯的母亲。
周雅雯：公司老板，李秀兰的女儿。

【开场场景】
周雅雯站在会议室门口，李秀兰拎着资料袋快步走来。

【故事梗概】
母女因职场身份产生误会，最终在真实沟通中化解冲突。`;
  const fetchCalls = mockLlmFetch(generatedOutline);
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "topic",
      llmKeyId: "llm-key",
      topicModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const prompt = requestBody.messages[1].content;
    assert.doesNotMatch(prompt, /【用户画像】/);
    assert.doesNotMatch(prompt, /核心受众为/);
    assert.doesNotMatch(prompt, /目标观看人群/);
    assert.doesNotMatch(prompt, /家庭伦理、婆媳较量、孝道传承/);
    assert.doesNotMatch(prompt, /【剧情环境】/);
    assert.match(prompt, /剧情环境未指定时，根据资产、故事发生地以及每个角色自身的年龄、出生年代、地区文化和剧情身份自然取名/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("storyboard topic prompts prefer matched role-library names when enabled", async () => {
  for (const type of ["ecommerce", "story"]) {
    const { config, user, run, cleanup } = await createEcommerceCustomTopicFixture({
      type,
      topicMode: "ai",
      topicOriginality: 20,
      storyEnvironment: "china",
      preferRoleLibraryNames: true,
      ecommerceAssets: {
        scripts: [
          {
            name: "家庭冲突参考脚本",
            prompt: "张经理与妻子因照顾父亲产生误会，最后解开心结。",
            scriptProfile: {
              coreCharacters: {
                totalCount: 3,
              },
            },
          },
        ],
        roles: {
          id: "role-library-family",
          name: "家庭角色库",
          roleCharacters: [
            {
              name: "王建国",
              gender: "男性",
              ageGroup: "中老年",
              occupation: "退休工人",
            },
            {
              name: "李雅琴",
              gender: "女性",
              ageGroup: "中年",
              occupation: "公司经理",
            },
            {
              name: "Emily",
              gender: "女性",
              ageGroup: "青年",
            },
          ],
        },
        products: type === "ecommerce" ? [
          {
            id: "product-1",
            name: "保温杯",
            productImageUrl: "https://cdn.example.com/product.png",
          },
        ] : [],
      },
    });
    const generatedOutline = `1、家庭误会后的和解
【主要角色】
王建国：退休工人，家庭中的父亲。
李雅琴：公司经理，负责化解误会。

【开场场景】
王建国坐在客厅里，李雅琴推门进来。

【故事梗概】
两人围绕家庭误会展开冲突并最终和解。`;
    const fetchCalls = mockLlmFetch(generatedOutline);
    try {
      await executeWorkflowLlmNode(user, {
        runId: run.id,
        nodeId: "topic",
        llmKeyId: "llm-key",
        topicModelId: "test-text-model",
      }, config);

      assert.equal(fetchCalls.length, 1);
      const requestBody = JSON.parse(fetchCalls[0].options.body);
      const prompt = requestBody.messages[1].content;
      assert.match(prompt, /【角色库姓名优先】/);
      assert.match(prompt, /王建国：男性；中老年；退休工人/);
      assert.match(prompt, /李雅琴：女性；中年；公司经理/);
      assert.match(prompt, /Emily：女性；青年/);
      assert.match(prompt, /匹配成功的角色库姓名优先于脚本资产中的原姓名和模型临时新取的姓名/);
      assert.match(prompt, /候选姓名还必须符合已指定的中国剧情环境；明显不符合时不得强行使用/);
      assert.match(prompt, /一个角色库姓名只能分配给一个剧情角色/);
      assert.match(prompt, /姓名优先只改变匹配角色的姓名来源，不得改变原有角色数量、年龄、性别、身份、人物关系、剧情功能、故事主线或结局/);
      assert.match(prompt, /已有姓名可在角色匹配成立时按【角色库姓名优先】规则替换，但角色本身不得替换/);
      assert.match(prompt, /后续完整文案必须始终沿用同一姓名/);
    } finally {
      restoreFetch(fetchCalls);
      await cleanup();
    }
  }
});

test("low-originality topic prompts lock the source character roster independently of audience targeting", async () => {
  for (const type of ["ecommerce", "story"]) {
    const { config, user, run, cleanup } = await createEcommerceCustomTopicFixture({
      type,
      topicMode: "ai",
      topicOriginality: 20,
      audienceProfile: "50-plus",
    });
    const generatedOutline = `1、原人物关系里的生活反转
【主要角色】
李大强：酒店大堂经理，沿用原脚本人物关系。
林雅琴：公司负责人，李大强的妻子。

【开场场景】
李大强和林雅琴在酒店大厅相遇，原有冲突随即展开。

【故事梗概】
故事只使用原有角色推进冲突，并在结尾完成情绪回收。`;
    const fetchCalls = mockLlmFetch(generatedOutline);
    try {
      await executeWorkflowLlmNode(user, {
        runId: run.id,
        nodeId: "topic",
        llmKeyId: "llm-key",
        topicModelId: "test-text-model",
      }, config);

      assert.equal(fetchCalls.length, 1);
      const requestBody = JSON.parse(fetchCalls[0].options.body);
      const prompt = requestBody.messages[1].content;
      assert.match(prompt, /【选题角色边界】/);
      assert.match(prompt, /当前原创度为20%，属于低原创强复用/);
      assert.match(prompt, /必须严格沿用其角色集合：角色数量、年龄、性别、职业、人物关系和剧情功能/);
      assert.match(prompt, /禁止新增任何主角、配角、背景人物或只为推动情节出现的功能角色/);
      assert.match(prompt, /不得临时编造母亲、父亲、婆婆、邻居、朋友、同事、专家、医生、店员、快递员等人物/);
      assert.match(prompt, /用户画像只决定内容给谁看、偏向什么题材、采用什么叙事节奏和表达方式/);
      assert.match(prompt, /不得为了匹配50岁以上受众，增加一个与受众年龄相同或受众容易代入的角色/);
      assert.match(prompt, /【主要角色】只是列出按角色边界允许出现的人物，不是要求为了填满格式新增角色/);
      assert.match(prompt, /不得新增、删除、拆分、合并或替换角色/);
    } finally {
      restoreFetch(fetchCalls);
      await cleanup();
    }
  }
});

test("ecommerce custom script node prioritizes confirmed topic outline", async () => {
  const { config, user, workflow, cleanup } = await createEcommerceCustomTopicFixture();
  const confirmedOutline = `1、女老板隐瞒身份抛弃母亲，男总裁手撕谎言护岳母
【开场场景】
高档明亮的总裁办公室门外，女老板穿白色西装冷着脸，母亲拎着旧布包站在门口，男总裁挡在母亲身前质问她。

【故事梗概】
男女主角身份互换后，女老板为了面子否认农村母亲，男总裁发现真相后维护母亲并揭开谎言，产品在母亲长时间等候导致眼部疲惫的冲突中自然出现。`;
  const childRun = await createWorkflowRun(user.id, workflow.id, {
    id: "run-custom-script",
    kind: "topic-child",
    topic: confirmedOutline,
    status: "waiting",
    stages: {
      topic: "skipped",
      outline: "skipped",
      script: "pending",
    },
    result: {
      topicAdaptation: "男女主角互换，母亲来找女儿，男老板是老板",
    },
  }, config);
  const fetchCalls = mockLlmFetch(ecommerceScriptOutput());
  try {
    await executeWorkflowLlmNode(user, {
      runId: childRun.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const prompt = requestBody.messages[0].content;
    assert.match(prompt, /【已确认选题大纲】/);
    assert.match(prompt, /女老板穿白色西装冷着脸/);
    assert.match(prompt, /【自定义选题大纲执行优先级】/);
    assert.match(prompt, /【已确认选题大纲】是剧情创作最高优先级输入/);
    assert.match(prompt, /禁止把原始角色配置、原始男女关系、原始家庭\/职场关系或旧剧情主线带回文案/);
    assert.match(prompt, /【对标脚本资产（仅节奏结构参考，禁止复用旧剧情关系）】/);
    assert.match(prompt, /不得把脚本资产作为剧情骨架/);
    assert.match(prompt, /使用限制：仅参考时长、镜头密度、产品露出比例、转化节点和节奏结构/);
    assert.match(prompt, /所有【角色对白】字段中的角色台词必须使用德语/);
    assert.match(prompt, /不要把整篇文案翻译成德语/);
    assert.doesNotMatch(prompt, /旧剧情：酒店大堂经理李大强和妻子林总/);
    assert.match(prompt, /男女主角互换/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce high-originality script prompt requires natural audience-matched dialogue", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {}, {
    topicOriginality: 90,
    language: "zh",
    audienceProfile: "35-50",
    storyEnvironment: "united-states",
    endingInteractionEnabled: true,
    strengthenProduct: true,
    purchaseGuidanceEnabled: true,
    purchaseGuidanceText: "左下角链接下单",
  });
  const fetchCalls = mockLlmFetch(ecommerceScriptOutput());
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const prompt = requestBody.messages[0].content;
    assert.match(prompt, /你是资深剧情带货的短视频编导/);
    assert.match(prompt, /原创度：90%（强原创 \/ 只保留故事内核）/);
    assert.match(prompt, /【用户画像】[\s\S]*目标观看人群为35-50岁/);
    assert.match(prompt, /低优先级辅助参考/);
    assert.match(prompt, /保持原有题材、故事主线、角色名单、角色年龄、人物关系、冲突路径、产品植入和结局逻辑/);
    assert.match(prompt, /仅在不改变原内容逻辑的前提下，可以轻微参考/);
    assert.match(prompt, /【剧情环境】[\s\S]*明确指定为美国/);
    assert.match(prompt, /住宅类型、建筑外观、房间布局、家具陈设、日常用品/);
    assert.match(prompt, /姓名必须服从【剧情环境】中的美国本地化规则/);
    assert.match(prompt, /Role_A:  \[人物姓名\]。简介：\[称谓、年龄层、职业或家庭身份、人物关系和剧情定位\]/);
    assert.match(prompt, /【强化塑品模式】/);
    assert.match(prompt, /提炼 1 个核心定位、1-2 个主卖点和 1 个典型使用场景/);
    assert.match(prompt, /【购买引导】/);
    assert.match(prompt, /用户配置的购买引导是：左下角链接下单/);
    assert.match(prompt, /逐字出现在某一镜的【角色对白】中/);
    assert.match(prompt, /如果全部【角色对白】中没有完整出现“左下角链接下单”/);
    assert.match(prompt, /【结尾互动】/);
    assert.match(prompt, /大家说我做得对不对/);
    assert.match(prompt, /产品痛点调查，禁止使用/);
    assert.match(prompt, /你们平时最伤眼，是加班、刷手机，还是追剧到半夜/);
    assert.match(prompt, /只承担剧情和价值观评论收束/);
    assert.match(prompt, /视频结尾的最后一个剧情收束镜头/);
    assert.match(prompt, /购买引导必须更早在产品出场后的带货段落单独完成/);
    assert.match(prompt, /不得重复、暗示或承接购买引导/);
    assert.match(prompt, /台词对白要大白话、接地气/);
    assert.match(prompt, /符合角色身份、年龄、人物关系、生活场景和已指定的剧情环境/);
    assert.match(prompt, /禁止过于机械化和 AI 味/);
    assert.match(prompt, /原创度越高，越要保持真人口语感/);
    assert.match(prompt, /高原创只代表剧情和表达角度更新/);
    assert.doesNotMatch(prompt, /结尾允许和用户互动/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("story high-originality script prompt requires natural audience-matched dialogue", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {}, {
    type: "story",
    topicOriginality: 90,
    language: "zh",
    audienceProfile: "25-34",
    storyEnvironment: "japan",
    endingInteractionEnabled: true,
  });
  const fetchCalls = mockLlmFetch(ecommerceScriptOutput());
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const prompt = requestBody.messages[0].content;
    assert.match(prompt, /资深剧情短视频编导/);
    assert.match(prompt, /原创度：90%（强原创 \/ 只保留故事内核）/);
    assert.match(prompt, /【用户画像】[\s\S]*目标观看人群为25-34岁/);
    assert.match(prompt, /不是题材指令、剧情指令或角色设定/);
    assert.match(prompt, /【剧情环境】[\s\S]*明确指定为日本/);
    assert.match(prompt, /角色姓名必须符合日本当地常见的语言、姓名结构、年代和文化习惯/);
    assert.match(prompt, /【角色命名规则】/);
    assert.match(prompt, /用户画像只表示谁观看视频，绝不能决定角色姓名、角色年龄或角色代际/);
    assert.match(prompt, /【结尾互动】/);
    assert.match(prompt, /引导用户在评论区打字评论/);
    assert.match(prompt, /台词对白要大白话、接地气/);
    assert.match(prompt, /符合角色身份、年龄、人物关系、生活场景和已指定的剧情环境/);
    assert.match(prompt, /禁止过于机械化和 AI 味/);
    assert.match(prompt, /原创度越高，越要保持真人口语感/);
    assert.doesNotMatch(prompt, /产品说明书式对白/);
    assert.doesNotMatch(prompt, /结尾允许自然互动/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script smart mode keeps the supplied title and uses flexible four-to-five-second shots", async () => {
  const inputScript = `场景一：厨房 / 清晨
妈妈捂着酸胀的眼睛，皱了皱眉。
妈妈：我昨晚刷了牙粉，牙还是不舒服。

场景二：餐桌 / 连续
女儿把商品递给妈妈。
女儿：我给你买了牙粉，你试试看。

带货段落：介绍牙粉的使用方法。`;
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    roles: {
      name: "母女角色库",
      prompt: "妈妈与成年女儿",
    },
    products: [
      {
        id: "product-eye-mask",
        name: "蒸汽眼罩",
        prompt: "产品名称：蒸汽眼罩\n产品亮点：温热敷眼\n使用动态描述：展开后佩戴在眼部",
        productImageUrl: "https://cdn.example.com/eye-mask.png",
      },
    ],
  }, {}, {
    topicMode: "script",
    inputScriptTitle: "妈妈的眼睛累了",
    inputScript,
    language: "zh",
    inputScriptDurationMode: "smart",
    inputScriptShotDurationSeconds: 4.5,
    audienceProfile: "18-24",
    endingInteractionEnabled: true,
    strengthenProduct: true,
    purchaseGuidanceEnabled: true,
    purchaseGuidanceText: "左下角头像进入直播间",
  });
  const fetchCalls = mockLlmFetch(ecommerceInputScriptAdaptedOutput());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const systemPrompt = requestBody.messages[0].content;
    const userPrompt = requestBody.messages[1].content;
    assert.match(systemPrompt, /当前工作流使用“输入剧本”模式/);
    assert.match(systemPrompt, /【用户画像】[\s\S]*目标观看人群为18-24岁/);
    assert.match(systemPrompt, /低优先级辅助参考/);
    assert.match(systemPrompt, /原剧本已有姓名时必须原样沿用/);
    assert.match(systemPrompt, /原剧本只有“奶奶、大儿子、儿媳、老板”等关系或身份称呼时/);
    assert.match(systemPrompt, /Role_A:  \[人物姓名\]。简介：\[称谓、年龄层、职业或家庭身份、人物关系/);
    assert.match(systemPrompt, /【强化塑品模式】/);
    assert.match(systemPrompt, /【购买引导】/);
    assert.match(systemPrompt, /左下角头像进入直播间/);
    assert.match(systemPrompt, /【结尾互动】/);
    assert.match(systemPrompt, /商品库所选商品是唯一带货主体/);
    assert.match(systemPrompt, /禁止让旧商品与所选商品同时残留/);
    assert.match(systemPrompt, /【目标时长：智能适配】/);
    assert.match(systemPrompt, /全部原对白必须逐字、逐句、按序保留/);
    assert.match(systemPrompt, /\[DIALOGUE:D001\]/);
    assert.match(systemPrompt, /\[PRODUCT_ADAPTED:D001\]/);
    assert.match(systemPrompt, /正式输出前必须在内部逐项完成对白自检/);
    assert.match(systemPrompt, /每镜按约 4–5 秒弹性拆分/);
    assert.match(systemPrompt, /用户已在用户消息的【用户剧本标题】字段填写标题/);
    assert.doesNotMatch(systemPrompt, /妈妈的眼睛累了/);
    assert.match(systemPrompt, /长对白必须在语义完整的标点、说话轮次或信息节拍处拆成多个连续镜头/);
    assert.match(systemPrompt, /可选角色资产（仅用于明确匹配）/);
    assert.match(systemPrompt, /必选带货产品资产（唯一商品事实源）/);
    assert.match(systemPrompt, /蒸汽眼罩/);
    assert.doesNotMatch(systemPrompt, /【已确认选题大纲】/);
    assert.doesNotMatch(systemPrompt, /妈妈捂着酸胀的眼睛/);
    assert.match(userPrompt, /\[START_USER_SCRIPT\]/);
    assert.match(userPrompt, /【用户剧本标题】\n妈妈的眼睛累了/);
    assert.match(userPrompt, /我昨晚刷了牙粉/);
    assert.match(userPrompt, /【原对白核对清单】/);
    assert.match(userPrompt, /D001｜妈妈｜我昨晚刷了牙粉，牙还是不舒服。/);
    assert.match(userPrompt, /D002｜女儿｜我给你买了牙粉，你试试看。/);
    assert.match(userPrompt, /\[END_USER_SCRIPT\]/);
    assert.equal(result.run.topic, "妈妈的眼睛累了");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script accepts a complete response without retrying omitted dialogue", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    products: [{
      id: "product-eye-mask",
      name: "蒸汽眼罩",
      productImageUrl: "https://cdn.example.com/eye-mask.png",
    }],
  }, {}, {
    topicMode: "script",
    inputScriptTitle: "门外的孩子",
    inputScript: `小野：“小姨……”
小姨：“小野，你咋来了？”
小野：“大伯让我来找你。”`,
    language: "zh",
    inputScriptDurationMode: "smart",
  });
  const fetchCalls = mockLlmFetch(ecommerceInputScriptDialogueAuditOutput({ omitSecond: true }));
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.doesNotMatch(result.script, /小姨（疑惑）：小野，你咋来了？/);
    assert.doesNotMatch(result.script, /\[(?:DIALOGUE|PRODUCT_ADAPTED):D\d{3}\]/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script accepts a complete response without retrying rewritten dialogue", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    products: [{
      id: "product-eye-mask",
      name: "蒸汽眼罩",
      productImageUrl: "https://cdn.example.com/eye-mask.png",
    }],
  }, {}, {
    topicMode: "script",
    inputScriptTitle: "门外的孩子",
    inputScript: `小野：“小姨……”
小姨：“小野，你咋来了？”
小野：“大伯让我来找你。”`,
    language: "zh",
    inputScriptDurationMode: "smart",
  });
  const fetchCalls = mockLlmFetch(ecommerceInputScriptDialogueAuditOutput({ rewriteSecond: true }));
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.match(result.script, /小姨（疑惑）：小野，你怎么突然来了？/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script dialogue ledger recognizes quoted continuations and malformed speaker commas", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    products: [{
      id: "product-eye-mask",
      name: "蒸汽眼罩",
      productImageUrl: "https://cdn.example.com/eye-mask.png",
    }],
  }, {}, {
    topicMode: "script",
    inputScriptTitle: "对白格式兼容",
    inputScript: `小野（怯怯）：“大伯，是我，小野。
“我不用床。”
老太太：去上学。
老太太，这些钱我不要。
【角色对白】 小王：千真万确！
小野（没理他，径直走到老太太面前，蹲下来。他刚才面对三人时的冷峻神情在蹲下来的一瞬间全都消失了，只剩下一个少年对母亲的温柔。他握住老太太的手）：“妈，我回来了。对不起，回来晚了。”`,
    language: "zh",
    inputScriptDurationMode: "smart",
  });
  const fetchCalls = mockLlmFetch(ecommerceInputScriptDialogueFormatOutput());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    const userPrompt = JSON.parse(fetchCalls[0].options.body).messages[1].content;
    assert.match(userPrompt, /D001｜小野｜大伯，是我，小野。/);
    assert.match(userPrompt, /D002｜小野｜我不用床。/);
    assert.match(userPrompt, /D003｜老太太｜去上学。/);
    assert.match(userPrompt, /D004｜老太太｜这些钱我不要。/);
    assert.match(userPrompt, /D005｜小王｜千真万确！/);
    assert.match(userPrompt, /D006｜小野｜妈，我回来了。对不起，回来晚了。/);
    assert.match(JSON.parse(fetchCalls[0].options.body).messages[0].content, /无论括号描述多长/);
    assert.match(result.script, /老太太（坚定）：这些钱我不要。/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script dialogue ledger preserves dialogue embedded in action descriptions", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {}, {
    topicMode: "script",
    inputScriptTitle: "门外的孩子",
    inputScript: `小姨：“你去问问别人吧。”
【屋里传来一个男人的声音：“谁啊？”小姨回头喊了一声“没事，收废品的”。】
律师：“我的律师已经在来的
路上了。”
【律师身边的桌上放着保温杯。】`,
    language: "zh",
    inputScriptDurationMode: "smart",
  });
  const fetchCalls = mockLlmFetch(`[START_FORMAT_EXAMPLE]
剧本标题：门外的孩子
一、 选角结果
Role_A:  小姨。简介：小野的小姨
Role_B:  男人。简介：小姨家中的男人
Role_C:  律师。简介：律师
一句话梗概: 小野在门外听见屋里的对话。

二、 分镜脚本详情
第 1 镜：门口/中景
【画面内容】小姨站在门口。
【角色对白】小姨（无奈）：你去问问别人吧。
【备注】[DIALOGUE:D001]

第 2 镜：屋内/近景
【画面内容】屋里传来男人的声音。
【角色对白】男人（疑惑）：谁啊？
【备注】[DIALOGUE:D002]

第 3 镜：门口/近景
【画面内容】小姨回头朝屋里喊。
【角色对白】小姨（遮掩）：没事，收废品的
【备注】[DIALOGUE:D003]

第 4 镜：室内/中景
【画面内容】律师正色提醒众人，身边的桌上放着保温杯。
【角色对白】律师（严肃）：我的律师已经在来的路上了。
【备注】[DIALOGUE:D004]
[END_FORMAT_EXAMPLE]`);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const systemPrompt = requestBody.messages[0].content;
    const userPrompt = requestBody.messages[1].content;
    assert.match(systemPrompt, /场景、动作或旁白描述中/);
    assert.match(systemPrompt, /不得因为它嵌在【】/);
    assert.match(userPrompt, /D002｜男人｜谁啊？/);
    assert.match(userPrompt, /D003｜小姨｜没事，收废品的/);
    assert.match(userPrompt, /D004｜律师｜我的律师已经在来的\s*路上了。/);
    assert.match(result.script, /男人（疑惑）：谁啊？/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script custom duration plans a flexible four-to-five-second shot range and generates a missing title", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {}, {
    topicMode: "script",
    inputScript: "母亲疲惫回家，女儿关心她并自然送上保温杯，母亲接受心意。",
    language: "zh",
    inputScriptDurationMode: "custom",
    inputScriptTargetDurationSeconds: 8,
    inputScriptShotDurationSeconds: 4.5,
  });
  const fetchCalls = mockLlmFetch(ecommerceInputScriptDefaultOutput());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    const systemPrompt = JSON.parse(fetchCalls[0].options.body).messages[0].content;
    assert.match(systemPrompt, /【目标时长：指定时长】/);
    assert.match(systemPrompt, /目标总时长约 8 秒/);
    assert.match(systemPrompt, /建议输出 2 个镜头/);
    assert.match(systemPrompt, /允许在 2–2 个镜头内/);
    assert.match(systemPrompt, /用户未填写剧本标题/);
    assert.match(systemPrompt, /压缩重复动作、冗余描述和重复对白/);
    assert.match(systemPrompt, /所有关键剧情节点仍必须保留/);
    assert.equal(result.run.topic, "一杯温暖的牵挂");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script accepts overlong dialogue without a post-generation repair call", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {}, {
    topicMode: "script",
    inputScript: "母亲端起凉汤，女儿送上保温杯，母亲接受女儿的心意。",
    language: "zh",
    inputScriptDurationMode: "smart",
    inputScriptShotDurationSeconds: 4.5,
  });
  const fetchCalls = mockLlmFetch(ecommerceInputScriptOverlongDialogueOutput());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.match(result.script, /第 1 镜/);
    assert.doesNotMatch(result.script, /第 2 镜/);
    assert.match(result.script, /妈，这是我专门给您挑的保温杯/);
    assert.match(result.script, /杯盖锁紧以后能减少热量散失/);
    assert.match(result.script, /您以后早上喝水、中午喝汤、晚上休息的时候/);
    assert.match(result.script, /都可以一直带在身边，不用再担心放一会儿就凉了/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script retries only when completeness markers are missing", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    products: [{
      id: "product-eye-mask",
      name: "蒸汽眼罩",
      productImageUrl: "https://cdn.example.com/eye-mask.png",
    }],
  }, {}, {
    topicMode: "script",
    inputScriptTitle: "妈妈的眼睛累了",
    inputScript: "妈妈眼睛不舒服，女儿送上蒸汽眼罩。",
    language: "zh",
    inputScriptDurationMode: "smart",
  });
  const completeOutput = ecommerceInputScriptAdaptedOutput();
  const fetchCalls = mockLlmFetchSequence([
    completeOutput.replace(/\n?\[END_FORMAT_EXAMPLE\]\s*$/, ""),
    completeOutput,
  ]);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 2);
    assert.match(result.script, /\[END_FORMAT_EXAMPLE\]$/);
    const retryMessages = JSON.parse(fetchCalls[1].options.body).messages;
    assert.match(retryMessages.at(-1).content, /缺少完整性标识/);
    assert.match(retryMessages.at(-1).content, /第一行必须是 \[START_FORMAT_EXAMPLE\]/);
    assert.doesNotMatch(retryMessages.at(-1).content, /原对白核对清单|所选商品唯一优先/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script validation accepts dialogue that fits within the five-second ceiling", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    products: [{
      id: "product-eye-mask",
      name: "蒸汽眼罩",
      productImageUrl: "https://cdn.example.com/eye-mask.png",
    }],
  }, {}, {
    topicMode: "script",
    inputScript: "女儿发现妈妈眼睛疲惫，送上蒸汽眼罩。",
    language: "zh",
    inputScriptDurationMode: "smart",
    inputScriptShotDurationSeconds: 4.5,
  });
  const fetchCalls = mockLlmFetch(ecommerceInputScriptFlexibleDialogueOutput());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.run.topic, "给疲惫眼睛的温暖");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce input-script accepts a complete response without retrying old product content", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    products: [
      {
        id: "product-eye-mask",
        name: "蒸汽眼罩",
        prompt: "产品名称：蒸汽眼罩\n产品亮点：温热敷眼",
        productImageUrl: "https://cdn.example.com/eye-mask.png",
      },
    ],
  }, {}, {
    topicMode: "script",
    inputScript: "妈妈牙齿不舒服，女儿送上牙粉表达关心。",
    language: "zh",
    inputScriptDurationMode: "smart",
    inputScriptShotDurationSeconds: 4.5,
  });
  const fetchCalls = mockLlmFetch(ecommerceInputScriptWrongProductOutput());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.match(result.script, /我的牙还是不舒服/);
    assert.match(result.script, /试试这款牙粉吧/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce ai script node keeps default topic prompt priority", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const fetchCalls = mockLlmFetch(ecommerceScriptOutput());
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const prompt = requestBody.messages[0].content;
    assert.match(prompt, /【已确认选题大纲】/);
    assert.match(prompt, /【用户画像】[\s\S]*目标观看人群为50岁以上/);
    assert.match(prompt, /低优先级辅助参考/);
    assert.match(prompt, /必须优先遵循用户输入剧本、自定义改编要求、已确认选题大纲、原创度规则和所选资产/);
    assert.doesNotMatch(prompt, /家庭伦理、婆媳较量、孝道传承、代际关系、亲情考验、善恶报应、惩恶扬善/);
    assert.doesNotMatch(prompt, /【自定义选题大纲执行优先级】/);
    assert.doesNotMatch(prompt, /【强化塑品模式】/);
    assert.doesNotMatch(prompt, /【购买引导】/);
    assert.doesNotMatch(prompt, /【结尾互动】/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce unspecified audience keeps the original story logic without audience targeting", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {}, {
    audienceProfile: "unspecified",
  });
  const fetchCalls = mockLlmFetch(ecommerceScriptOutput());
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "script",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const prompt = requestBody.messages[0].content;
    assert.doesNotMatch(prompt, /【用户画像】/);
    assert.doesNotMatch(prompt, /核心受众为/);
    assert.doesNotMatch(prompt, /家庭伦理、婆媳较量、孝道传承/);
    assert.doesNotMatch(prompt, /目标观看人群/);
    assert.doesNotMatch(prompt, /用户画像/);
    assert.doesNotMatch(prompt, /【剧情环境】/);
    assert.match(prompt, /剧情环境未指定时，根据资产、故事发生地以及每个角色自身的年龄、出生年代、地区文化和剧情身份自然取名/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("talking-video script node instructs all supported copy languages", async () => {
  const languages = [
    ["de", "德语"],
    ["fr", "法语"],
    ["ja", "日语"],
    ["ko", "韩语"],
    ["id", "印尼语"],
    ["pt", "葡萄牙语"],
    ["es", "西班牙语"],
  ];

  for (const [language, label] of languages) {
    const { config, user, run, cleanup } = await createTalkingWorkflowLlmFixture({ language, includeAudio: false });
    const fetchCalls = mockLlmFetch(`${label}口播文案正文。`);
    try {
      await executeWorkflowLlmNode(user, {
        runId: run.id,
        nodeId: "script",
        llmKeyId: "llm-key",
        storyModelId: "test-text-model",
      }, config);

      assert.equal(fetchCalls.length, 1);
      const requestBody = JSON.parse(fetchCalls[0].options.body);
      assert.match(requestBody.messages[0].content, new RegExp(`输出语言：${label}`));
      assert.match(requestBody.messages[0].content, new RegExp(`全文必须使用${label}`));
    } finally {
      restoreFetch(fetchCalls);
      await cleanup();
    }
  }
});

test("talking-video Indonesian topic node requests Indonesian titles with Chinese references", async () => {
  const { config, user, run, cleanup } = await createTalkingWorkflowLlmFixture({ language: "id", includeAudio: false });
  const fetchCalls = mockLlmFetch('{"titles":[{"title":"Rahasia yang Mengubah Hidup","zh":"改变人生的秘密"}]}');
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "topic",
      llmKeyId: "llm-key",
      topicModelId: "test-text-model",
      count: 1,
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /擅长印尼语内容/);
    assert.match(requestBody.messages[1].content, /title 必须是印尼语标题/);
    assert.deepEqual(result.topics, ["Rahasia yang Mengubah Hidup｜中文：改变人生的秘密"]);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("talking-video Indonesian shot node keeps language-specific shot metadata", async () => {
  const { config, user, run, cleanup } = await createTalkingWorkflowLlmFixture({
    language: "id",
    scriptTranslation: "我们原以为答案很简单，因为历史改变了一切。",
  });
  const fetchCalls = mockLlmFetch(talkingShotOutput());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /【印尼语画面提示词】/);
    assert.match(requestBody.messages[0].content, /对应文案字段使用 Corresponding script，其内容必须原样保持印尼语/);
    assert.equal(result.shots[0].localizedScripts.id, result.shots[0].script);
    assert.equal(result.shots[0].scriptZh, undefined);
    assert.match(result.output, /\[Shot 1\]/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("talking-video shot node defaults to raw ASR duration segmentation and keeps final SRT aligned", async () => {
  const { config, user, run, cleanup } = await createTalkingWorkflowLlmFixture();
  const fetchCalls = mockLlmFetch(talkingShotOutput());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /智能时长计划即镜头/);
    assert.match(requestBody.messages[0].content, /必须正好输出 2 个镜头/);
    assert.match(requestBody.messages[1].content, /智能时长切分计划（共 2 镜）/);
    assert.match(requestBody.messages[1].content, /00:00\.000 - 00:06\.200/);
    assert.equal(result.shots.length, 2);
    assert.equal(result.shots[0].script, "We thought the answer was simple, because history changed everything.");
    assert.match(result.output, /We thought the answer was simple, because history changed everything\./);
    assert.doesNotMatch(result.output, /placeholder/);
    assert.deepEqual(result.shots.map((shot) => [shot.audioStart, shot.audioEnd]), [[0, 6.2], [6.2, 12]]);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.talkingShotSegmentationMode, "duration-semantic");
    assert.equal(updatedRun.result.audioSegments.length, 2);
    assert.equal(updatedRun.result.audioRawSegments.length, 5);
    assert.equal(updatedRun.result.audioTracks[0].segments.length, 2);
    assert.equal(updatedRun.result.talkingShotSourceAudioSegments.length, 5);
    assert.match(updatedRun.result.subtitleSrt, /00:00:00,000 --> 00:00:06,200/);
    assert.equal(updatedRun.result.timeline.segments.length, 2);

  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("talking-video punctuation mode retains the existing punctuation prompt", async () => {
  const { config, user, run, cleanup } = await createTalkingWorkflowLlmFixture();
  const fetchCalls = mockLlmFetch(talkingShotOutput(4));
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      talkingShotSegmentationMode: "punctuation",
    }, config);

    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /标点即镜头/);
    assert.match(requestBody.messages[0].content, /必须正好输出 4 个镜头/);
    assert.match(requestBody.messages[1].content, /标点切分计划（共 4 镜）/);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.talkingShotSegmentationMode, "punctuation");
    assert.equal(updatedRun.result.audioSegments.length, 4);
    assert.equal(updatedRun.result.audioRawSegments.length, 5);
    assert.equal(updatedRun.result.timeline.segments.length, 4);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce shot node removes product closeup scenes from scene assets", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const fetchCalls = mockLlmFetch(ecommerceShotMappingWithProductCloseup());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /接收我提供的【带货口播脚本】，只确认角色映射、场景映射、产品图映射和逐镜资产引用/);
    assert.match(requestBody.messages[0].content, /每一个“第 N 镜”对应一个输出镜头/);
    assert.doesNotMatch(requestBody.messages[0].content, /当前运行的是“AI 导演分镜模式”/);
    assert.equal(result.shots.filter((shot) => shot.assetType === "scene").length, 1);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const sceneShots = updatedRun.result.shots.filter((shot) => shot.assetType === "scene");
    const productShots = updatedRun.result.shots.filter((shot) => shot.assetType === "product");

    assert.equal(sceneShots.length, 1);
    assert.equal(sceneShots[0].title, "厨房餐桌");
    assert.doesNotMatch(sceneShots[0].prompt, /保温杯|品牌 Logo 清晰/);
    assert.match(sceneShots[0].prompt, /不出现任何商品/);
    assert.equal(productShots.length, 1);
    assert.equal(productShots[0].imageUrl, "https://cdn.example.com/product.png");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce shot node stores explicit per-shot asset references", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const fetchCalls = mockLlmFetch(ecommerceShotMappingWithShotAssetRefs());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
    }, config);

    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /\[START_SHOT_ASSET_MAPPING\]/);

    const roleShot = result.shots.find((shot) => shot.assetType === "role");
    const sceneShot = result.shots.find((shot) => shot.assetType === "scene");
    const productShot = result.shots.find((shot) => shot.assetType === "product");

    assert.equal(roleShot.assetRef, "Role_A");
    assert.deepEqual(roleShot.shotRefs, [1]);
    assert.equal(sceneShot.assetRef, "Scene_A");
    assert.equal(sceneShot.title, "厨房餐桌");
    assert.deepEqual(sceneShot.shotRefs, [1, 2]);
    assert.equal(productShot.assetRef, "Product_1");
    assert.deepEqual(productShot.shotRefs, [2]);
    assert.doesNotMatch(result.output, /\[START_SHOT_ASSET_MAPPING\]/);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.doesNotMatch(updatedRun.result.shotOutput, /\[START_SHOT_ASSET_MAPPING\]/);
    assert.deepEqual(updatedRun.result.shotAssetRefs, {
      "1": {
        sceneRefs: ["Scene_A"],
        roleRefs: ["Role_A"],
        productRefs: [],
      },
      "2": {
        sceneRefs: ["Scene_A"],
        roleRefs: [],
        productRefs: ["Product_1"],
      },
    });
    assert.deepEqual(updatedRun.result.shots.find((shot) => shot.assetType === "product").shotRefs, [2]);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("story traditional shot mode keeps the original mapping-only prompt", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture(
    {},
    { scriptOutput: "一、 选角结果\nRole_A: 谷雨。\n\n二、 分镜脚本详情\n第 1 镜：家庭餐厅\n【画面内容】谷雨坐在餐桌边。\n【角色对白】无\n【备注】无" },
    { type: "story" },
  );
  const output = `[START_ROLE_MAPPING]
Role_A: 谷雨：中国青年男性，短黑发，浅灰色T恤
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
Scene_A: 家庭餐厅
提示词：空无一人的家庭餐厅，暖色灯光，小方桌
场景映射：第1镜
[END_SCENE_MAPPING]

[START_SHOT_ASSET_MAPPING]
第 1 镜：
场景图：Scene_A
角色图：Role_A
[END_SHOT_ASSET_MAPPING]`;
  const fetchCalls = mockLlmFetch(output);
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
    }, config);

    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /接收我提供的【故事分镜脚本】，只确认角色映射、场景映射和逐镜资产引用/);
    assert.match(requestBody.messages[0].content, /每一个“第 N 镜”对应一个输出镜头/);
    assert.match(requestBody.messages[0].content, /禁止输出逐镜画面提示词/);
    assert.doesNotMatch(requestBody.messages[0].content, /当前运行的是“AI 导演分镜模式”/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("AI director mode builds global mappings and detailed tasks in one complete model call", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const globalAssetDefinitions = ecommerceShotMappingWithShotAssetRefs()
    .replace(/\n场景映射[：:][^\n]*/g, "")
    .replace(/\n\[START_SHOT_ASSET_MAPPING\][\s\S]*?\[END_SHOT_ASSET_MAPPING\]/, "");
  const output = `[START_OUTPUT]
${globalAssetDefinitions}

<VIDEO_TASK>
场景参考：[[Scene_A]] 厨房餐桌
角色：[[Role_A]] 老太
商品参考：[[Product_1]] 保温杯
角色-声线绑定：老太｜朴素温和的老年女声

[0–13秒]：清晨厨房中景转近景，老太整理早餐，担心地说：“这汤凉得太快了。”随后看向桌上的保温杯。
</VIDEO_TASK>
[END_OUTPUT]`;
  const fetchCalls = mockLlmFetch(output);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      storyboardMode: "ai-director",
      maxDurationSeconds: 15,
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /读取完整剧本和可复用资产目录/);
    assert.match(requestBody.messages[0].content, /必须先在内部完成整部剧本的连续任务规划/);
    assert.match(requestBody.messages[0].content, /\[START_ROLE_MAPPING\]/);
    assert.match(requestBody.messages[0].content, /\[START_PRODUCT_MAPPING\]/);
    assert.match(requestBody.messages[0].content, /每条任务时长控制在 10–15 秒/);
    assert.match(requestBody.messages[0].content, /切镜点可使用 0\.5 秒粒度/);
    assert.match(requestBody.messages[0].content, /最后一个时间码的结束值必须是整数/);
    assert.match(requestBody.messages[0].content, /中文对白按每秒约 3\.5–4 个汉字估算/);
    assert.match(requestBody.messages[0].content, /按完整剧本的自然叙事组织视频任务/);
    assert.match(requestBody.messages[0].content, /视频任务数量不设目标，也禁止以减少任务数量为目标/);
    assert.match(requestBody.messages[1].content, /完整剧本开始/);
    assert.doesNotMatch(requestBody.messages[1].content, /原稿客观容量预算/);
    assert.doesNotMatch(requestBody.messages[1].content, /不得少于 \d+ 条视频任务/);
    assert.match(requestBody.messages[1].content, /原对白是不可编辑的只读原文/);
    assert.match(requestBody.messages[1].content, /原对白逐字保留高于其他所有要求/);
    assert.match(requestBody.messages[1].content, /必须增加视频任务或继续拆分对白，绝对不能删除、改写、概括或跳过任何对白字符/);
    assert.match(requestBody.messages[1].content, /当前对白尚未逐字输出完毕时，禁止切换场景、进入下一句对白、商品介绍或下一剧情节点/);
    assert.match(requestBody.messages[1].content, /下一任务必须由原说话人从尚未输出的字符继续/);
    assert.match(requestBody.messages[1].content, /只有全部原对白输出完成后，才允许输出 \[END_OUTPUT\]/);
    assert.match(requestBody.messages[1].content, /明确属于中国，且原文没有外国设定时，统一写“中国男性”或“中国女性”/);
    assert.match(requestBody.messages[1].content, /禁止写“东亚男性”或“东亚女性”/);
    assert.match(requestBody.messages[1].content, /“角色-声线绑定”左侧必须写具体人物姓名/);
    assert.match(requestBody.messages[1].content, /严禁写 Role_A、Role_B、\[\[Role_A\]\]、\[\[Role_B\]\] 等角色映射 ID/);
    assert.match(requestBody.messages[1].content, /只能从下方剧本逐字复制/);
    assert.match(requestBody.messages[1].content, /每个片段都必须重新标明原说话人并用中文双引号包裹/);
    assert.match(requestBody.messages[1].content, /每句对白或其拆分片段只能消费一次/);
    assert.match(requestBody.messages[1].content, /禁止对原对白进行语义去重、重要性筛选或上下文推断/);
    assert.match(requestBody.messages[1].content, /询问、回答、确认、重复和过渡对白仍必须逐字输出/);
    assert.match(requestBody.messages[1].content, /“提问—回答”等连续对白单元不得拆掉任何一方/);
    assert.match(requestBody.messages[1].content, /自然语速区间较慢一端计算每段对白的理论最低时长/);
    assert.match(requestBody.messages[1].content, /同一场景、同一人物、同一轮长对白或同一戏剧节点在容量不足时也必须拆成多个连续任务/);
    assert.match(requestBody.messages[1].content, /每个时间码代表一个实际切镜/);
    assert.match(requestBody.messages[1].content, /说话人变化时必须开始新的时间码/);
    assert.match(requestBody.messages[1].content, /镜头不移动时也必须写“固定镜头”/);
    assert.match(requestBody.messages[1].content, /禁止复述上一任务末尾对白/);
    assert.match(requestBody.messages[1].content, /外层格式引号不得替换、吞掉、修复或删除原文自身的异常引号和标点/);
    assert.match(requestBody.messages[1].content, /所有对白、旁白和画外音必须直接写入实际发生的时间码行/);
    assert.match(requestBody.messages[1].content, /纯动作、反应、环境建立和转场时间码可以没有对白/);
    assert.match(requestBody.messages[0].content, /不得输出“角色库\[无匹配\]”“未匹配”“无合适角色”等匹配状态文字/);
    assert.match(requestBody.messages[0].content, /不得把对白集中追加到时间码块下方/);
    assert.match(requestBody.messages[0].content, /每个角色只写一条简短的“核心音色\+年龄性别”/);
    assert.match(requestBody.messages[0].content, /临时表演要求必须写在对应时间码的分镜信息中/);
    assert.equal(result.storyboardMode, "ai-director");
    assert.equal(result.aiDirectorPlan.schemaVersion, 4);
    assert.equal(result.aiDirectorPlan.segments.length, 1);
    assert.match(result.output, /^\[START_OUTPUT\]/);
    assert.match(result.output, /\[END_OUTPUT\]$/);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.storyboardMode, "ai-director");
    assert.equal(updatedRun.result.aiDirectorMaxDurationSeconds, 15);
    assert.equal(updatedRun.result.aiDirectorPlan.segments[0].durationSeconds, 13);
    assert.deepEqual(updatedRun.result.aiDirectorPlan.segments[0].assetTokens, [
      "[[Scene_A]]",
      "[[Role_A]]",
      "[[Product_1]]",
    ]);
    assert.deepEqual(updatedRun.result.shotAssetRefs, {
      "1": {
        sceneRefs: ["Scene_A"],
        roleRefs: ["Role_A"],
        productRefs: ["Product_1"],
      },
    });
    assert.ok(updatedRun.result.shots.some((shot) => shot.assetRef === "Role_A" && shot.title === "老太"));
    assert.ok(updatedRun.result.shots.some((shot) => shot.assetRef === "Product_1" && shot.title === "保温杯"));
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("story AI director omits product references and fixes repeated role voices", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture(
    {},
    { scriptOutput: `饭桌上 / 晚上

（一家三口围着小方桌，谷雨攥着筷子，父亲和母亲坐在桌边。）

谷雨：（声音发虚）爸，能不能给我五千块钱？

父亲：（端起碗继续吃）明天早上四点，跟我出趟车。` },
    { type: "story" },
  );
  const output = `[START_OUTPUT]
[START_ROLE_MAPPING]
Role_A: 谷雨：角色库无合适角色，输出角色图提示词：中国青年男性，全身照，偏瘦学生身形，短黑发，穿浅灰色宽松T恤和深色长裤，补充要求：无表情，双手下垂，真实摄影。
Role_B: 父亲：中国中年男性，短发，深色居家服，全身照，真实摄影。
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
Scene_A: 家庭餐厅
提示词：夜晚家庭餐厅，暖色灯光，小方桌，空无一人
场景映射：第1镜、第2镜
[END_SCENE_MAPPING]

[START_SHOT_ASSET_MAPPING]
第 1 镜：
场景图：Scene_A
角色图：Role_A、Role_B
产品图：无

第 2 镜：
场景图：Scene_A
角色图：Role_A、Role_B
产品图：无
[END_SHOT_ASSET_MAPPING]

<VIDEO_TASK>
场景参考：[[Scene_A]] 家庭餐厅
角色：[[Role_A]] 谷雨，[[Role_B]] 父亲
角色-声线绑定：谷雨｜克制真诚的青年男声；父亲｜沉稳厚重的中年男声

[0–10秒]：谷雨压着情绪低声询问父亲，父亲沉默看向谷雨。
</VIDEO_TASK>
<VIDEO_TASK>
场景参考：[[Scene_A]] 家庭餐厅
角色：[[Role_A]] 谷雨，[[Role_B]] 父亲
角色-声线绑定：谷雨｜克制真诚的青年男声；父亲｜沉稳厚重的中年男声

[0–11秒]：谷雨声音越来越小，父亲语气加重作出回答。
</VIDEO_TASK>
[END_OUTPUT]`;
  const fetchCalls = mockLlmFetch(output);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      storyboardMode: "ai-director",
      maxDurationSeconds: 15,
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.doesNotMatch(requestBody.messages[0].content, /\[START_PRODUCT_MAPPING\]/);
    assert.match(requestBody.messages[0].content, /这是故事视频工作流，不输出任何“商品参考”字段/);
    assert.match(requestBody.messages[0].content, /同一角色在全剧所有任务中逐字复用/);
    assert.doesNotMatch(result.output, /商品参考/);
    assert.match(result.output, /START_ROLE_MAPPING|END_ROLE_MAPPING/);
    assert.equal(result.aiDirectorPlan.segments.length, 2);
    assert.match(result.aiDirectorPlan.segments[1].prompt, /谷雨｜克制真诚的青年男声；父亲｜沉稳厚重的中年男声/);
    assert.match(result.aiDirectorPlan.segments[1].prompt, /谷雨声音越来越小，父亲语气加重/);
    const generatedRole = result.shots.find((shot) => shot.assetRef === "Role_A");
    assert.equal(generatedRole.title, "谷雨");
    assert.match(generatedRole.imagePrompt, /^中国青年男性，偏瘦学生身形/);
    assert.doesNotMatch(
      generatedRole.imagePrompt,
      /角色库无合适角色|输出角色图提示词|全身照|三视图|马赛克|真实摄影|摄影棚|无表情/
    );

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const storedRole = updatedRun.result.shots.find((shot) => shot.assetRef === "Role_A");
    assert.equal(storedRole.imagePrompt, generatedRole.imagePrompt);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("story AI director propagates the configured English speech rate into the complete prompt", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture(
    {},
    { scriptOutput: `Cabin living room / night

Leo: Everyone watching right now, hit that like button and subscribe.` },
    { type: "story", language: "en" },
  );
  const output = `[START_OUTPUT]
[START_ROLE_MAPPING]
Role_A: Leo: Caucasian young man, short brown hair, silver jacket
[END_ROLE_MAPPING]
[START_SCENE_MAPPING]
Scene_A: Cabin living room
提示词：空无一人的木屋客厅，壁炉燃烧，窗外暴风雪
[END_SCENE_MAPPING]
<VIDEO_TASK>
场景参考：[[Scene_A]] Cabin living room
角色：[[Role_A]] Leo
角色-声线绑定：Leo｜清晰有力的青年男声

[0–11秒]：木屋客厅中景缓慢推近，Leo直视镜头并说：“Everyone watching right now, hit that like button and subscribe.”说完等待观众反应。
</VIDEO_TASK>
[END_OUTPUT]`;
  const fetchCalls = mockLlmFetch(output);
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      storyboardMode: "ai-director",
      maxDurationSeconds: 15,
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.match(requestBody.messages[0].content, /当前对白语言为英语/);
    assert.match(requestBody.messages[0].content, /英语对白按每秒约 2\.2–2\.7 个单词/);
    assert.match(requestBody.messages[1].content, /只能从下方剧本逐字复制/);
    assert.doesNotMatch(requestBody.messages[1].content, /个对白字符/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("long AI director scripts are sent whole and return one complete storyboard response", async () => {
  const longScript = Array.from({ length: 12 }, (_, index) => `场景${index + 1} / 白天

（谷雨在不同地点完成一个连续动作。）

谷雨：${"这段原始对白需要保持完整并按自然语速表达。".repeat(3)}`).join("\n\n");
  const { config, user, run, cleanup } = await createWorkflowLlmFixture(
    {},
    { scriptOutput: longScript },
    { type: "story" },
  );
  const output = `[START_OUTPUT]
[START_ROLE_MAPPING]
Role_A: 谷雨：中国青年男性，偏瘦学生身形，短黑发，浅灰色T恤和深色长裤
[END_ROLE_MAPPING]
[START_SCENE_MAPPING]
Scene_A: 连续生活场景
提示词：空无一人的普通生活空间，自然光线，日常陈设
[END_SCENE_MAPPING]
${Array.from({ length: 10 }, () => `<VIDEO_TASK>
场景参考：[[Scene_A]] 连续生活场景
角色：[[Role_A]] 谷雨
角色-声线绑定：谷雨｜克制真诚的青年男声

[0–10秒]：白天室内中景固定镜头转近景，谷雨完成当前连续动作并自然说出本段原始对白，镜头收束到他的即时反应。
</VIDEO_TASK>`).join("\n")}
[END_OUTPUT]`;
  const fetchCalls = mockLlmFetch(output);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      storyboardMode: "ai-director",
      maxDurationSeconds: 15,
    }, config);

    assert.equal(fetchCalls.length, 1);
    const requestBody = JSON.parse(fetchCalls[0].options.body);
    assert.doesNotMatch(requestBody.messages[0].content, /AI 导演分段生成/);
    assert.match(requestBody.messages[1].content, /场景1 \/ 白天/);
    assert.match(requestBody.messages[1].content, /场景12 \/ 白天/);
    assert.equal(result.aiDirectorPlan.segments.length, 10);
    assert.equal((result.output.match(/\[START_ROLE_MAPPING\]/g) || []).length, 1);
    assert.match(result.output, /角色-声线绑定：谷雨｜克制真诚的青年男声/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("AI director mode retries a complete-script response only when integrity markers are missing", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const completeOutput = `[START_OUTPUT]
${ecommerceShotMappingWithShotAssetRefs()}

<VIDEO_TASK>
场景参考：[[Scene_A]] 厨房餐桌
角色：[[Role_A]] 老太
角色-声线绑定：老太｜朴素温和的老年女声

[0–11秒]：清晨厨房中景缓慢推近，老太整理早餐后看向门口，神情担忧。
</VIDEO_TASK>
[END_OUTPUT]`;
  const fetchCalls = mockLlmFetchSequence([
    completeOutput.replace(/\n\[END_OUTPUT\]$/, ""),
    completeOutput,
  ]);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      storyboardMode: "ai-director",
      maxDurationSeconds: 15,
    }, config);

    assert.equal(fetchCalls.length, 2);
    const firstBody = JSON.parse(fetchCalls[0].options.body);
    const retryBody = JSON.parse(fetchCalls[1].options.body);
    assert.deepEqual(retryBody.messages, firstBody.messages);
    assert.match(retryBody.messages[0].content, /一次完整剧本生成任务/);
    assert.match(retryBody.messages[1].content, /完整剧本开始/);
    assert.match(retryBody.messages[0].content, /第一行必须且只能是 \[START_OUTPUT\]/);
    assert.match(retryBody.messages[0].content, /最后一行必须且只能是 \[END_OUTPUT\]/);
    assert.equal(result.storyboardMode, "ai-director");
    assert.equal(result.aiDirectorPlan.segments.length, 1);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("AI director mode accepts marker-complete output without local storyboard quality retries", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const output = `[START_OUTPUT]
${ecommerceShotMappingWithShotAssetRefs()}

<VIDEO_TASK>
场景参考：[[Scene_A]] 厨房餐桌
角色：[[Role_A]] 老太
角色-声线绑定：老太｜朴素温和的老年女声

[11–16.5秒]：这条任务故意不从 0 秒开始、超过上限且以小数结束。
</VIDEO_TASK>
[END_OUTPUT]`;
  const fetchCalls = mockLlmFetch(output);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      storyboardMode: "ai-director",
      maxDurationSeconds: 15,
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.storyboardMode, "ai-director");
    assert.equal(result.aiDirectorPlan.segments.length, 1);
    assert.equal(result.aiDirectorPlan.segments[0].durationSeconds, 16.5);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("AI director mode saves a marker-complete response even when downstream structures are absent", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const output = "[START_OUTPUT]\n模型返回了完整传输，但内容没有可解析的映射或视频任务。\n[END_OUTPUT]";
  const fetchCalls = mockLlmFetch(output);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      storyboardMode: "ai-director",
      maxDurationSeconds: 15,
    }, config);

    assert.equal(fetchCalls.length, 1);
    assert.equal(result.output, output);
    assert.deepEqual(result.aiDirectorPlan.segments, []);
    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.stages.shot, "done");
    assert.equal(updatedRun.result.shotError, "");
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("AI director mode does not retry a non-retryable provider rejection", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const calls = [];
  calls.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      error: {
        message: "invalid request",
      },
    }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  };
  try {
    await assert.rejects(
      executeWorkflowLlmNode(user, {
        runId: run.id,
        nodeId: "shot",
        llmKeyId: "llm-key",
        shotModelId: "test-text-model",
        storyboardMode: "ai-director",
        maxDurationSeconds: 15,
      }, config),
    );
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch(calls);
    await cleanup();
  }
});

test("ecommerce shot node deduplicates repeated role refs without merging similar role names", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const fetchCalls = mockLlmFetch(ecommerceShotMappingWithDuplicateRoleRefs());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
    }, config);

    const roleShots = result.shots.filter((shot) => shot.assetType === "role");
    assert.deepEqual(roleShots.map((shot) => shot.assetRef), ["Role_A", "Role_B"]);
    assert.deepEqual(roleShots.map((shot) => shot.title), ["周阳", "周阳助理"]);
    assert.match(roleShots[0].imagePrompt, /深蓝色长外套/);
    assert.doesNotMatch(roleShots[0].imagePrompt, /重复备用描述/);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    const storedRoleShots = updatedRun.result.shots.filter((shot) => shot.assetType === "role");
    assert.deepEqual(storedRoleShots.map((shot) => shot.assetRef), ["Role_A", "Role_B"]);
    assert.deepEqual(storedRoleShots.map((shot) => shot.shotRefs), [[1], [1]]);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce shot node keeps configured dialogue language", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {}, { language: "de" });
  const fetchCalls = mockLlmFetch(ecommerceShotMappingWithShotAssetRefs());
  try {
    await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
    }, config);

    const requestBody = JSON.parse(fetchCalls[0].options.body);
    const prompt = requestBody.messages[0].content;
    assert.match(prompt, /对白语言：文案中的角色对白应保持德语/);
    assert.match(prompt, /不要翻译或改写对白/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce shot node adds role outfit variants when enabled", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const fetchCalls = mockLlmFetchSequence([
    ecommerceShotMappingWithRoleOutfitRefs(),
    JSON.stringify({
      variants: [
        {
          baseRoleRef: "Role_A",
          variantName: "落魄装穷版",
          shotIndexes: [2],
          outfitPrompt: "穿破旧灰色外套、廉价长裤和旧布鞋，衣服有轻微灰尘，整体落魄但五官发型身材与原角色一致",
        },
      ],
    }),
  ]);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      roleOutfitVariantDetection: true,
      outfitDetectionLlmKeyId: "llm-key",
      outfitDetectionModelId: "test-vision-model",
    }, config);

    assert.equal(fetchCalls.length, 2);
    assert.equal(JSON.parse(fetchCalls[0].options.body).model, "test-text-model");
    assert.equal(JSON.parse(fetchCalls[1].options.body).model, "test-vision-model");

    const baseRole = result.shots.find((shot) => shot.assetRef === "Role_A");
    const outfitRole = result.shots.find((shot) => shot.assetRef === "Role_A_Outfit_1");

    assert.deepEqual(baseRole.shotRefs, [1]);
    assert.equal(outfitRole.title, "董事长_落魄装穷版");
    assert.deepEqual(outfitRole.shotRefs, [2]);
    assert.equal(outfitRole.imageStatus, "pending");
    assert.match(outfitRole.imagePrompt, /保持与原角色/);
    assert.match(outfitRole.imagePrompt, /破旧灰色外套/);
    assert.match(outfitRole.imagePrompt, /横屏角色三视图/);
    assert.match(outfitRole.imagePrompt, /正面、侧面、背面同屏排列/);
    assert.match(outfitRole.imagePrompt, /人物脸部打上马赛克/);
    assert.doesNotMatch(outfitRole.imagePrompt, /单人全身角色参考图/);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.deepEqual(updatedRun.result.shotAssetRefs["1"].roleRefs, ["Role_A"]);
    assert.deepEqual(updatedRun.result.shotAssetRefs["2"].roleRefs, ["Role_A_Outfit_1"]);
    assert.equal(updatedRun.result.roleOutfitVariantStatus, "pending");
    assert.deepEqual(updatedRun.result.roleOutfitVariantSummary, {
      enabled: true,
      status: "pending",
      reason: "",
      variantCount: 1,
      generatedCount: 0,
      pendingCount: 1,
      failedCount: 0,
      variantTitles: ["董事长_落魄装穷版"],
    });
    assert.doesNotMatch(updatedRun.result.shotOutput, /Role_A_Outfit_1/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce role deduplication preserves similarly named outfit variants", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const fetchCalls = mockLlmFetchSequence([
    ecommerceShotMappingWithDuplicateRoleOutfitRefs(),
    JSON.stringify({
      variants: [
        {
          baseRoleRef: "Role_A",
          variantName: "落魄装穷版",
          shotIndexes: [2],
          outfitPrompt: "穿破旧灰色外套、廉价长裤和旧布鞋，整体落魄但核心五官发型身材与原角色一致",
        },
      ],
    }),
  ]);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      roleOutfitVariantDetection: true,
      outfitDetectionLlmKeyId: "llm-key",
      outfitDetectionModelId: "test-vision-model",
    }, config);

    const roleShots = result.shots.filter((shot) => shot.assetType === "role");
    assert.deepEqual(roleShots.map((shot) => shot.assetRef), ["Role_A", "Role_A_Outfit_1"]);
    assert.deepEqual(roleShots.map((shot) => shot.title), ["董事长", "董事长_落魄装穷版"]);
    assert.deepEqual(roleShots.map((shot) => shot.shotRefs), [[1], [2]]);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce outfit variants inherit selected role reference image style", async () => {
  const selectedRoleImagePrompt = "中国男性，全身照，中年，短发，穿深色高端西装，无表情，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，正面、侧面、背面同屏排列，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物";
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    roles: [
      {
        name: "角色库",
        roleCharacters: [
          {
            name: "董事长",
            realisticImagePrompt: "中国男性，全身照，中年，短发，穿深色高端西装，无表情，双手下垂，正常清晰人脸，真实摄影，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物，单人角色设计图",
            roleImages: [
              {
                id: "chairman-mosaic-three",
                isDefault: true,
                prompt: selectedRoleImagePrompt,
                imageUrl: "https://cdn.example.com/chairman-mosaic-three.png",
                thumbnailUrl: "https://cdn.example.com/chairman-mosaic-three-thumb.png",
              },
            ],
          },
        ],
      },
    ],
  });
  const fetchCalls = mockLlmFetchSequence([
    ecommerceShotMappingWithRoleLibraryOutfitRefs(),
    JSON.stringify({
      variants: [
        {
          baseRoleRef: "Role_A",
          variantName: "落魄装穷版",
          shotIndexes: [2],
          outfitPrompt: "穿破旧灰色外套、廉价长裤和旧布鞋，衣服有轻微灰尘，整体落魄但五官发型身材与原角色一致",
        },
      ],
    }),
  ]);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      roleOutfitVariantDetection: true,
      outfitDetectionLlmKeyId: "llm-key",
      outfitDetectionModelId: "test-vision-model",
    }, config);

    const baseRole = result.shots.find((shot) => shot.assetRef === "Role_A");
    const outfitRole = result.shots.find((shot) => shot.assetRef === "Role_A_Outfit_1");

    assert.equal(baseRole.imageSource, "role-library");
    assert.equal(baseRole.imagePrompt, selectedRoleImagePrompt);
    assert.match(outfitRole.imagePrompt, /横屏角色三视图/);
    assert.match(outfitRole.imagePrompt, /正面、侧面、背面同屏排列/);
    assert.match(outfitRole.imagePrompt, /人物脸部打上马赛克/);
    assert.match(outfitRole.imagePrompt, /延续原角色参考图的画面风格/);
    assert.doesNotMatch(outfitRole.imagePrompt, /正常清晰人脸/);
    assert.doesNotMatch(outfitRole.imagePrompt, /单人角色设计图/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce shot node keeps outfit variants that cover all matched role shots", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture();
  const fetchCalls = mockLlmFetchSequence([
    ecommerceShotMappingWithRoleOutfitRefs(),
    JSON.stringify({
      variants: [
        {
          baseRoleRef: "Role_A",
          variantName: "全程装穷版",
          shotIndexes: [1, 2],
          outfitPrompt: "穿破旧灰色外套、廉价长裤和旧布鞋，装穷伪装破产状态，核心五官发型身材与原角色一致",
        },
      ],
    }),
  ]);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      roleOutfitVariantDetection: true,
      outfitDetectionLlmKeyId: "llm-key",
      outfitDetectionModelId: "test-vision-model",
    }, config);

    const baseRole = result.shots.find((shot) => shot.assetRef === "Role_A");
    const outfitRole = result.shots.find((shot) => shot.assetRef === "Role_A_Outfit_1");

    assert.deepEqual(baseRole.shotRefs, []);
    assert.deepEqual(outfitRole.shotRefs, [1, 2]);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.deepEqual(updatedRun.result.shotAssetRefs["1"].roleRefs, ["Role_A_Outfit_1"]);
    assert.deepEqual(updatedRun.result.shotAssetRefs["2"].roleRefs, ["Role_A_Outfit_1"]);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce shot node does not add outfit variants when detector returns none", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {
    scriptOutput: ecommerceRichPoorScriptOutput(),
  });
  const fetchCalls = mockLlmFetchSequence([
    ecommerceShotMappingWithoutShotAssetRefs(),
    JSON.stringify({ variants: [] }),
  ]);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      roleOutfitVariantDetection: true,
      outfitDetectionLlmKeyId: "llm-key",
      outfitDetectionModelId: "test-vision-model",
    }, config);

    assert.equal(fetchCalls.length, 2);
    assert.equal(result.shots.some((shot) => shot.outfitVariantOf), false);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.equal(updatedRun.result.shots.some((shot) => shot.outfitVariantOf), false);
    assert.equal(updatedRun.result.roleOutfitVariantStatus, "none");
    assert.deepEqual(updatedRun.result.roleOutfitVariantSummary, {
      enabled: true,
      status: "none",
      reason: "",
      variantCount: 0,
      generatedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      variantTitles: [],
    });
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce shot node treats the first rich-poor state as the base role image", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({}, {
    scriptOutput: ecommerceRichPoorScriptOutput(),
  });
  const fetchCalls = mockLlmFetchSequence([
    ecommerceShotMappingWithoutShotAssetRefs(),
    JSON.stringify({
      variants: [
        {
          baseRoleRef: "Role_A",
          variantName: "富豪董事长版",
          shotIndexes: [1],
          outfitPrompt: "穿高端深色西装，富豪集团董事长状态，衣着光鲜体面，核心五官发型身材与原角色一致",
        },
        {
          baseRoleRef: "Role_A",
          variantName: "富豪有钱版",
          shotIndexes: [1],
          outfitPrompt: "富豪有钱状态，穿精致高端正装，衣着光鲜体面，核心五官发型身材与原角色一致",
        },
        {
          baseRoleRef: "Role_A",
          variantName: "落魄装穷版",
          shotIndexes: [2],
          outfitPrompt: "穿朴素旧衣和旧布鞋，假装破产落魄，核心五官发型身材与原角色一致",
        },
        {
          baseRoleRef: "Role_A",
          variantName: "破产落魄版",
          shotIndexes: [2],
          outfitPrompt: "破产落魄状态，穿破旧灰色外套、廉价长裤和旧布鞋，核心五官发型身材与原角色一致",
        },
      ],
    }),
  ]);
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
      roleOutfitVariantDetection: true,
      outfitDetectionLlmKeyId: "llm-key",
      outfitDetectionModelId: "test-vision-model",
    }, config);

    const outfitRoles = result.shots.filter((shot) => shot.outfitVariantOf === "Role_A");
    assert.equal(outfitRoles.length, 1);
    assert.deepEqual(outfitRoles.map((shot) => shot.title), ["老太太_落魄装穷版"]);
    assert.deepEqual(outfitRoles.map((shot) => shot.shotRefs), [[2]]);

    const updatedRun = await getWorkflowRun(user.id, run.id, config);
    assert.deepEqual(updatedRun.result.shotAssetRefs["1"].roleRefs, ["Role_A"]);
    assert.deepEqual(updatedRun.result.shotAssetRefs["2"].roleRefs, ["Role_A_Outfit_1"]);
    assert.equal(updatedRun.result.roleOutfitVariantSummary.variantCount, 1);
    assert.deepEqual(updatedRun.result.roleOutfitVariantSummary.variantTitles, ["老太太_落魄装穷版"]);
    assert.equal(updatedRun.result.shots.some((shot) => shot.title === "老太太_富豪董事长版"), false);
    assert.equal(updatedRun.result.shots.some((shot) => shot.title === "老太太_富豪有钱版"), false);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

test("ecommerce shot node only reuses role library images for explicit role library mappings", async () => {
  const { config, user, run, cleanup } = await createWorkflowLlmFixture({
    roles: [
      {
        name: "角色库",
        roleCharacters: [
          {
            name: "陈伟",
            realisticImagePrompt: "陈伟角色库提示词",
            imageUrl: "https://cdn.example.com/chenwei.png",
            thumbnailUrl: "https://cdn.example.com/chenwei-thumb.png",
          },
        ],
      },
    ],
  });
  const fetchCalls = mockLlmFetch(ecommerceShotMappingWithExplicitAndGeneratedRoles());
  try {
    const result = await executeWorkflowLlmNode(user, {
      runId: run.id,
      nodeId: "shot",
      llmKeyId: "llm-key",
      shotModelId: "test-text-model",
    }, config);

    const libraryRole = result.shots.find((shot) => shot.assetRef === "Role_A");
    const generatedRole = result.shots.find((shot) => shot.assetRef === "Role_B");

    assert.equal(libraryRole.title, "陈伟");
    assert.equal(libraryRole.imageSource, "role-library");
    assert.equal(libraryRole.imageUrl, "https://cdn.example.com/chenwei.png");
    assert.equal(libraryRole.imageStatus, "done");

    assert.equal(generatedRole.title, "陈伟母亲/老太");
    assert.equal(generatedRole.imageSource, "");
    assert.equal(generatedRole.imageUrl, "");
    assert.equal(generatedRole.imageStatus, "pending");
    assert.match(generatedRole.prompt, /中国女性/);
    assert.doesNotMatch(generatedRole.prompt, /陈伟角色库提示词/);
  } finally {
    restoreFetch(fetchCalls);
    await cleanup();
  }
});

async function createTalkingWorkflowLlmFixture(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-talking-workflow-llm-"));
  const config = {
    env: "test",
    dataDir,
    apiKeyEncryptionKey: Buffer.from("flowstudio-local-dev-key-0000010").toString("base64"),
    store: {
      driver: "json",
    },
    storage: {
      provider: "local",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });
  await saveApiKey(user, {
    id: "llm-key",
    serviceType: "llm",
    channel: "Synthetic Text",
    apiKey: "test-llm-key",
    endpoint: "https://text.example.com/v1",
  }, config);
  const workflow = await createWorkflow(user, {
    id: "workflow-talking-llm",
    name: "口播视频测试",
    type: "explain",
    config: {
      type: "explain",
      language: options.language || "en",
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
      shotModelId: "test-text-model",
    },
  }, config);
  const audioSegments = [
    { index: 1, start: 0, end: 2.5, text: "We thought the answer was simple," },
    { index: 2, start: 2.5, end: 5, text: "because" },
    { index: 3, start: 5, end: 6.2, text: "history changed everything." },
    { index: 4, start: 6.2, end: 9, text: "The next clue appeared," },
    { index: 5, start: 9, end: 12, text: "and the mystery was finally solved." },
  ];
  const includeAudio = options.includeAudio !== false;
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: "run-talking-llm",
    kind: "topic-child",
    topic: "Test topic",
    status: "waiting",
    stages: {
      topic: "skipped",
      outline: "skipped",
      script: "done",
      optimize: "skipped",
      audio: includeAudio ? "done" : "pending",
      shot: "pending",
      image: "pending",
      videoPrompt: "pending",
      video: "pending",
      draft: "pending",
    },
    result: {
      scriptOutput: "We thought the answer was simple, because history changed everything. The next clue appeared, and the mystery was finally solved.",
      ...(options.scriptTranslation ? {
        scriptTranslation: options.scriptTranslation,
        scriptTranslationLanguage: "zh",
      } : {}),
      shots: [],
      ...(includeAudio ? {
        audio: {
          audio_url: "https://cdn.example.com/talking.mp3",
          duration: 12,
          raw_segments: audioSegments,
          segments: [],
          subtitle_status: "pending",
        },
        audioUrl: "https://cdn.example.com/talking.mp3",
        audioDuration: 12,
        audioRawSegments: audioSegments,
        audioSegments: [],
        audioTracks: [{
          id: "voice-track",
          audio_url: "https://cdn.example.com/talking.mp3",
          duration: 12,
          rawSegments: audioSegments,
          segments: [],
          subtitleStatus: "pending",
        }],
      } : {}),
    },
  }, config);
  return {
    config,
    user,
    workflow,
    run,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

async function createEcommerceCustomTopicFixture(workflowConfig = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-topic-"));
  const config = {
    env: "test",
    dataDir,
    apiKeyEncryptionKey: Buffer.from("flowstudio-local-dev-key-0000010").toString("base64"),
    store: {
      driver: "json",
    },
    storage: {
      provider: "local",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });
  await saveApiKey(user, {
    id: "llm-key",
    serviceType: "llm",
    channel: "Synthetic Text",
    apiKey: "test-llm-key",
    endpoint: "https://text.example.com/v1",
  }, config);
  const workflow = await createWorkflow(user, {
    id: "workflow-custom-topic-llm",
    name: "带货视频自定义选题",
    type: "ecommerce",
    config: {
      type: "ecommerce",
      topicMode: "custom",
      llmKeyId: "llm-key",
      topicLlmKeyId: "llm-key",
      topicModelId: "test-text-model",
      storyModelId: "test-text-model",
      language: "de",
      audienceProfile: "35-50",
      customTopics: [
        {
          adaptation: "男女主角互换，母亲来找女儿，男老板是老板",
        },
      ],
      ecommerceAssets: {
        scripts: [
          {
            name: "酒店旧剧情脚本",
            desc: "旧脚本摘要：酒店大堂经理李大强隐瞒父亲，妻子林总出手惩治。",
            prompt: "旧剧情：酒店大堂经理李大强和妻子林总在酒店大厅接待父亲，最终妻子揭穿丈夫。",
            sourceFile: {
              durationSeconds: 60,
            },
            targetDurationSeconds: 180,
            scriptProfile: {
              hasDialogue: true,
              coreCharacters: {
                totalCount: 3,
              },
            },
          },
        ],
        products: [
          {
            id: "product-1",
            name: "保温杯",
            productImageUrl: "https://cdn.example.com/product.png",
          },
        ],
      },
      ...workflowConfig,
    },
  }, config);
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: "run-custom-topic-llm",
    kind: "topic-seed",
    topic: "带货视频自定义选题",
    status: "running",
    stages: {
      topic: "running",
    },
    topicGenerationStatus: "running",
    result: {
      topicAdaptationBrief: "1. 男女主角互换，母亲来找女儿，男老板是老板",
    },
  }, config);
  return {
    config,
    user,
    workflow,
    run,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

async function createWorkflowLlmFixture(ecommerceAssets = {}, runResult = {}, workflowConfig = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flowstudio-workflow-llm-"));
  const config = {
    env: "test",
    dataDir,
    apiKeyEncryptionKey: Buffer.from("flowstudio-local-dev-key-0000010").toString("base64"),
    store: {
      driver: "json",
    },
    storage: {
      provider: "local",
    },
  };
  const user = ensureUser(config, {
    id: "dev-user",
    email: "dev@flowstudio.local",
    displayName: "Test User",
  });
  await saveApiKey(user, {
    id: "llm-key",
    serviceType: "llm",
    channel: "Synthetic Text",
    apiKey: "test-llm-key",
    endpoint: "https://text.example.com/v1",
  }, config);
  const workflowType = workflowConfig.type || "ecommerce";
  const workflow = await createWorkflow(user, {
    id: "workflow-llm",
    name: workflowType === "story" ? "故事视频测试" : "带货视频测试",
    type: workflowType,
    config: {
      type: workflowType,
      llmKeyId: "llm-key",
      storyModelId: "test-text-model",
      shotModelId: "test-text-model",
      ...workflowConfig,
      ecommerceAssets: {
        products: [
          {
            id: "product-default",
            name: "保温杯",
            productImageUrl: "https://cdn.example.com/product.png",
            productImageThumbnailUrl: "https://cdn.example.com/product-thumb.png",
          },
        ],
        ...ecommerceAssets,
        ...(workflowConfig.ecommerceAssets || {}),
      },
    },
  }, config);
  const run = await createWorkflowRun(user.id, workflow.id, {
    id: "run-llm",
    kind: "topic-child",
    topic: "测试选题",
    status: "waiting",
    stages: {
      topic: "skipped",
      outline: "skipped",
      script: "done",
      optimize: "skipped",
      shot: "pending",
      image: "pending",
      audio: "pending",
      videoPrompt: "pending",
      video: "pending",
      draft: "pending",
    },
    result: {
      scriptOutput: runResult.scriptOutput || ecommerceScriptOutput(),
      shots: [],
    },
  }, config);

  return {
    config,
    user,
    workflow,
    run,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

function ecommerceScriptOutput() {
  return `[START_FORMAT_EXAMPLE]
一、 选角结果
Role_A:  老太。简介：节俭但关心家人的母亲
一句话梗概: 家人用日常对话自然引出保温需求

二、 分镜脚本详情
第 1 镜：厨房餐桌/中景
【画面内容】 老太在厨房餐桌旁整理早餐，窗外清晨自然光照进来。
【角色对白】 老太（担心）：这汤凉得太快了。
【备注】 生活痛点铺垫。

第 2 镜：产品特写/近景
【画面内容】 桌上的保温杯包装盒特写，品牌 Logo 清晰。
【角色对白】 无
【备注】 产品露出。
[END_FORMAT_EXAMPLE]`;
}

function ecommerceInputScriptDefaultOutput() {
  return `[START_FORMAT_EXAMPLE]
剧本标题：一杯温暖的牵挂
一、 选角结果
Role_A:  老太。简介：节俭但关心家人的母亲
一句话梗概: 家人用日常对话自然引出保温需求

二、 分镜脚本详情
第 1 镜：厨房餐桌/中景
【画面内容】 老太在厨房餐桌旁整理早餐，窗外清晨自然光照进来。
【角色对白】 老太（担心）：这汤凉得太快了。
【备注】 生活痛点铺垫。

第 2 镜：产品特写/近景
【画面内容】 桌上的保温杯包装盒特写，品牌 Logo 清晰。
【角色对白】 无
【备注】 产品露出。
[END_FORMAT_EXAMPLE]`;
}

function ecommerceInputScriptDialogueAuditOutput(options = {}) {
  const secondShot = options.omitSecond
    ? ""
    : `
第 2 镜：出租屋门口/近景
【画面内容】 小姨探出头看着门外的小野。
【角色对白】 小姨（疑惑）：${options.rewriteSecond ? "小野，你怎么突然来了？" : "小野，你咋来了？"}
【备注】 普通剧情对白。[DIALOGUE:D002]
`;
  return `[START_FORMAT_EXAMPLE]
剧本标题：门外的孩子
一、 选角结果
Role_A:  小野。简介：被亲人拒收的孩子
Role_B:  小姨。简介：小野的亲属
一句话梗概: 小野到出租屋请求小姨收留

二、 分镜脚本详情
第 1 镜：出租屋门口/近景
【画面内容】 小野站在门外，小声叫人。
【角色对白】 小野（怯怯）：小姨……
【备注】 普通剧情对白。[DIALOGUE:D001]
${secondShot}
第 3 镜：出租屋门口/近景
【画面内容】 小野解释自己为什么来到这里。
【角色对白】 小野（怯怯）：大伯让我来找你。
【备注】 普通剧情对白。[DIALOGUE:D003]

第 4 镜：出租屋内/中景
【画面内容】 桌上放着所选蒸汽眼罩。
【角色对白】 无
【备注】 所选商品自然进入后续剧情。
[END_FORMAT_EXAMPLE]`;
}

function ecommerceInputScriptDialogueFormatOutput() {
  return `[START_FORMAT_EXAMPLE]
剧本标题：对白格式兼容
一、 选角结果
Role_A:  小野。简介：被亲人拒收的孩子
Role_B:  老太太。简介：照顾小野的老人
一句话梗概: 老太太鼓励小野上学

二、 分镜脚本详情
第 1 镜：门外/近景
【画面内容】 小野怯怯地抬头。
【角色对白】 小野（怯怯）：大伯，是我，小野。
【备注】 原对白。[DIALOGUE:D001]

第 2 镜：门外/近景
【画面内容】 小野继续解释。
【角色对白】 小野（怯怯）：我不用床。
【备注】 原对白。[DIALOGUE:D002]

第 3 镜：桥洞/近景
【画面内容】 老太太看着小野。
【角色对白】 老太太（认真）：去上学。
【备注】 原对白。[DIALOGUE:D003]

第 4 镜：桥洞/近景
【画面内容】 老太太坚定地摆手，桌上放着蒸汽眼罩。
【角色对白】 老太太（坚定）：这些钱我不要。
【备注】 原对白。[DIALOGUE:D004]

第 5 镜：桥洞/近景
【画面内容】 小王肯定地点头。
【角色对白】 小王（肯定）：千真万确！
【备注】 原对白。[DIALOGUE:D005]
[END_FORMAT_EXAMPLE]`;
}

function ecommerceInputScriptAdaptedOutput() {
  return `[START_FORMAT_EXAMPLE]
剧本标题：妈妈的眼睛累了
一、 选角结果
Role_A:  妈妈。简介：眼睛疲惫但关心女儿的母亲
Role_B:  女儿。简介：细心照顾妈妈的成年女儿
一句话梗概: 女儿发现妈妈眼睛疲惫，送上蒸汽眼罩表达关心

二、 分镜脚本详情
第 1 镜：厨房/中景
【画面内容】 妈妈坐在桌旁捂着酸胀的眼睛。
【角色对白】 妈妈（疲惫）：昨晚眼睛一直不舒服。
【备注】 商品适配：把旧商品牙齿痛点改为所选商品眼部疲惫痛点。[PRODUCT_ADAPTED:D001]

第 2 镜：厨房/近景
【画面内容】 女儿把蒸汽眼罩递给妈妈。
【角色对白】 女儿（关心）：妈，戴上这款蒸汽眼罩吧。
【备注】 商品适配：把旧牙粉替换为所选蒸汽眼罩。[PRODUCT_ADAPTED:D002]
[END_FORMAT_EXAMPLE]`;
}

function ecommerceInputScriptOverlongDialogueOutput() {
  return `[START_FORMAT_EXAMPLE]
剧本标题：一杯温暖的牵挂
一、 选角结果
Role_A:  女儿。简介：关心母亲的成年女儿
一句话梗概: 女儿送上保温杯表达关心

二、 分镜脚本详情
第 1 镜：厨房/中景
【画面内容】 女儿把保温杯递给母亲，母亲抬头看着她。
【角色对白】 女儿（关心）：妈，这是我专门给您挑的保温杯，杯盖锁紧以后能减少热量散失，您以后早上喝水、中午喝汤、晚上休息的时候都可以一直带在身边，不用再担心放一会儿就凉了。
【备注】 产品自然进入剧情。
[END_FORMAT_EXAMPLE]`;
}

function ecommerceInputScriptDialogueRepairOutput() {
  return JSON.stringify({
    repairs: [
      {
        sourceIndex: 1,
        shots: [
          {
            heading: "厨房/中景",
            picture: "女儿把保温杯递给母亲。",
            dialogue: "女儿（关心）：妈，这是我专门给您挑的保温杯，",
            note: "产品自然进入剧情。",
          },
          {
            heading: "厨房/近景",
            picture: "母亲接过保温杯，低头看着杯盖。",
            dialogue: "女儿（关心）：杯盖锁紧以后能减少热量散失，",
            note: "承接原有产品说明。",
          },
          {
            heading: "厨房/中景",
            picture: "女儿继续说明日常使用场景。",
            dialogue: "女儿（关心）：您以后早上喝水、中午喝汤、晚上休息的时候",
            note: "承接原有产品说明。",
          },
          {
            heading: "厨房/近景",
            picture: "母亲握着杯子抬头回应女儿。",
            dialogue: "女儿（关心）：都可以一直带在身边，不用再担心放一会儿就凉了。",
            note: "保留原有收束表达。",
          },
        ],
      },
    ],
  });
}

function ecommerceInputScriptCustomDurationRepairOutput() {
  return JSON.stringify({
    repairs: [
      {
        sourceIndex: 1,
        shots: [
          {
            heading: "厨房/中景",
            picture: "女儿把保温杯递给母亲，母亲伸手接过。",
            dialogue: "女儿（关心）：妈，这是我给您挑的保温杯，锁紧杯盖能减少热量散失。",
            note: "保留产品进入剧情和核心卖点。",
          },
          {
            heading: "厨房/近景",
            picture: "母亲握着杯子抬头看向女儿。",
            dialogue: "女儿（关心）：早晚喝水都能随身带着，不怕一会儿就凉。",
            note: "压缩重复使用场景，保留原对白意图。",
          },
        ],
      },
    ],
  });
}

function ecommerceInputScriptFlexibleDialogueOutput() {
  return `[START_FORMAT_EXAMPLE]
剧本标题：给疲惫眼睛的温暖
一、 选角结果
Role_A:  妈妈。简介：眼睛疲惫的母亲
Role_B:  女儿。简介：关心母亲的成年女儿
一句话梗概: 女儿送上蒸汽眼罩关心妈妈

二、 分镜脚本详情
第 1 镜：客厅/中景
【画面内容】 女儿把蒸汽眼罩递给坐在沙发上的妈妈。
【角色对白】 妈妈（温和）：妈，我今天眼睛真的有点累，戴上以后舒服多了。
【备注】 所选商品自然进入剧情。
[END_FORMAT_EXAMPLE]`;
}

function ecommerceInputScriptWrongProductOutput() {
  return `[START_FORMAT_EXAMPLE]
剧本标题：妈妈的眼睛累了
一、 选角结果
Role_A:  妈妈。简介：牙齿不舒服的母亲
Role_B:  女儿。简介：关心母亲的成年女儿
一句话梗概: 女儿送上牙粉表达关心

二、 分镜脚本详情
第 1 镜：厨房/中景
【画面内容】 妈妈捂着牙齿坐在桌旁。
【角色对白】 妈妈（难受）：我的牙还是不舒服。
【备注】 保留原有牙齿痛点。

第 2 镜：厨房/近景
【画面内容】 女儿把牙粉递给妈妈。
【角色对白】 女儿（关心）：妈，试试这款牙粉吧。
【备注】 沿用输入剧本的旧商品。
[END_FORMAT_EXAMPLE]`;
}

function talkingShotOutput(count = 2) {
  const shots = Array.from({ length: count }, (_, index) => `[Shot ${index + 1}]
Corresponding script:
placeholder ${index + 1}
Image prompt:
A cinematic historical research scene for shot ${index + 1}.`).join("\n\n");
  return `[START_OUTPUT]\n\n${shots}\n\n[END_OUTPUT]`;
}

function ecommerceRichPoorScriptOutput() {
  return `[START_FORMAT_EXAMPLE]
一、 选角结果
老太太: 主角。简介：富有但装作落魄的集团董事长，白发，前期西装后期换成朴素旧衣，通过假破产极端行为测试儿子真心。
一句话梗概: 富有老太太假装破产测试亲戚，最后揭露身份。

二、 分镜脚本详情
第 1 镜：集团办公室/中景
【画面内容】 老太太穿高端深色西装站在集团办公室落地窗前，秘书递来资产文件。
【角色对白】 老太太（沉稳）：先别让他们知道我的真实身份。
【备注】 富豪身份铺垫。

第 2 镜：亲戚家门口/近景
【画面内容】 老太太换上朴素旧衣和旧布鞋，拎着旧布包站在亲戚家门口，假装破产落魄。
【角色对白】 老太太（虚弱）：我现在只剩这点东西了。
【备注】 装穷测试亲戚。
[END_FORMAT_EXAMPLE]`;
}

function ecommerceShotMappingWithProductCloseup() {
  return `[START_ROLE_MAPPING]
Role_A: 老太：中国女性，全身照，银发短发，深色棉衣，无表情，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物。
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
厨房餐桌：
提示词：老旧厨房餐桌，桌上有保温杯包装盒，清晨自然光，空无一人
场景映射：第1镜、第2镜

产品特写：
提示词：保温杯包装盒特写，品牌 Logo 清晰，空无一人
场景映射：第2镜
[END_SCENE_MAPPING]

[START_PRODUCT_MAPPING]
产品图：产品库[保温杯]
[END_PRODUCT_MAPPING]`;
}

function ecommerceShotMappingWithoutShotAssetRefs() {
  return `[START_ROLE_MAPPING]
Role_A: 老太太：中国女性，全身照，白发，中年偏老，穿深色高端西装，无表情，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物。
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
Scene_A: 集团办公室
提示词：高档集团董事长办公室，落地窗自然光，空无一人
场景映射：第1镜

Scene_B: 亲戚家门口
提示词：普通居民楼门口，午后自然光，空无一人
场景映射：第2镜
[END_SCENE_MAPPING]

[START_PRODUCT_MAPPING]
Product_1: 产品库[保温杯]
[END_PRODUCT_MAPPING]`;
}

function ecommerceShotMappingWithShotAssetRefs() {
  return `[START_ROLE_MAPPING]
Role_A: 老太：中国女性，全身照，银发短发，深色棉衣，无表情，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物。
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
Scene_A: 厨房餐桌
提示词：老旧厨房餐桌，清晨自然光，空无一人
场景映射：第1镜、第2镜
[END_SCENE_MAPPING]

[START_PRODUCT_MAPPING]
Product_1: 产品库[保温杯]
[END_PRODUCT_MAPPING]

[START_SHOT_ASSET_MAPPING]
第 1 镜：
场景图：Scene_A
角色图：Role_A
产品图：无

第 2 镜：
场景图：Scene_A
角色图：无
产品图：Product_1
[END_SHOT_ASSET_MAPPING]`;
}

function ecommerceShotMappingWithDuplicateRoleRefs() {
  return `[START_ROLE_MAPPING]
Role_A: 周阳：中国男性，全身照，中年，短发，穿深蓝色长外套，无表情，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物。
Role_B: 周阳助理：中国男性，全身照，青年，短发，穿灰色西装，无表情，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物。
Role_A: 周阳：重复备用描述，不应创建第二个角色资产。
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
Scene_A: 办公室
提示词：现代办公室，落地窗自然光，空无一人
场景映射：第1镜
[END_SCENE_MAPPING]

[START_PRODUCT_MAPPING]
Product_1: 产品库[保温杯]
[END_PRODUCT_MAPPING]

[START_SHOT_ASSET_MAPPING]
第 1 镜：
场景图：Scene_A
角色图：Role_A、Role_B
产品图：无
[END_SHOT_ASSET_MAPPING]`;
}

function ecommerceShotMappingWithRoleOutfitRefs() {
  return `[START_ROLE_MAPPING]
Role_A: 董事长：中国男性，全身照，中年，短发，穿深色高端西装，无表情，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物。
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
Scene_A: 办公室
提示词：高档董事长办公室，落地窗自然光，空无一人
场景映射：第1镜

Scene_B: 亲戚家门口
提示词：普通居民楼门口，午后自然光，空无一人
场景映射：第2镜
[END_SCENE_MAPPING]

[START_PRODUCT_MAPPING]
Product_1: 产品库[保温杯]
[END_PRODUCT_MAPPING]

[START_SHOT_ASSET_MAPPING]
第 1 镜：
场景图：Scene_A
角色图：Role_A
产品图：无

第 2 镜：
场景图：Scene_B
角色图：Role_A
产品图：无
[END_SHOT_ASSET_MAPPING]`;
}

function ecommerceShotMappingWithDuplicateRoleOutfitRefs() {
  return ecommerceShotMappingWithRoleOutfitRefs().replace(
    "[END_ROLE_MAPPING]",
    "Role_A: 董事长：重复的董事长描述，不应创建第二个基础角色。\n[END_ROLE_MAPPING]",
  );
}

function ecommerceShotMappingWithRoleLibraryOutfitRefs() {
  return `[START_ROLE_MAPPING]
Role_A: 董事长：角色库[董事长]
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
Scene_A: 办公室
提示词：高档董事长办公室，落地窗自然光，空无一人
场景映射：第1镜

Scene_B: 亲戚家门口
提示词：普通居民楼门口，午后自然光，空无一人
场景映射：第2镜
[END_SCENE_MAPPING]

[START_PRODUCT_MAPPING]
Product_1: 产品库[保温杯]
[END_PRODUCT_MAPPING]

[START_SHOT_ASSET_MAPPING]
第 1 镜：
场景图：Scene_A
角色图：Role_A
产品图：无

第 2 镜：
场景图：Scene_B
角色图：Role_A
产品图：无
[END_SHOT_ASSET_MAPPING]`;
}

function ecommerceShotMappingWithExplicitAndGeneratedRoles() {
  return `[START_ROLE_MAPPING]
Role_A: 陈伟：角色库[陈伟]
Role_B: 陈伟母亲/老太：中国女性，全身照，佝偻身材，满头银发，穿着破旧棕色棉袄，无表情，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物。
[END_ROLE_MAPPING]

[START_SCENE_MAPPING]
Scene_A: 客厅
提示词：普通居民客厅，午后自然光，空无一人
场景映射：第1镜
[END_SCENE_MAPPING]

[START_PRODUCT_MAPPING]
Product_1: 产品库[保温杯]
[END_PRODUCT_MAPPING]

[START_SHOT_ASSET_MAPPING]
第 1 镜：
场景图：Scene_A
角色图：Role_A、Role_B
产品图：无
[END_SHOT_ASSET_MAPPING]`;
}

function mockLlmFetch(content) {
  return mockLlmFetchSequence([content]);
}

function mockLlmFetchSequence(contents = []) {
  const calls = [];
  calls.originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const content = contents[Math.min(calls.length, Math.max(contents.length - 1, 0))] || "";
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            content,
          },
        },
      ],
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  };
  return calls;
}

function restoreFetch(calls) {
  globalThis.fetch = calls.originalFetch;
}
