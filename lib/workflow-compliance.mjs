const publicRolePattern = /(?:中国人民解放军|人民解放军|解放军|武警|军人|军官|士兵|公安|警察|民警|交警|刑警|特警|法官|检察官|公务员|政府官员|公职人员)/g;
const graphicViolencePattern = /(?:鲜血|流血|血流(?:不止|如注)|血泊|喷血|伤口(?:裂开|外翻)|断肢|肢解|开膛|爆头)/g;

export const workflowComplianceRules = {
  red: [
    "国家安全与政治底线；军人、警察等公职人员只要出现即命中",
    "民族或宗教仇恨、歧视与煽动",
    "色情、性剥削，尤其涉及未成年人",
    "重大虚假信息或扰乱社会秩序",
    "违法犯罪、黑灰产、诈骗或伪造新闻",
    "涉黑、威胁、严重暴力、自残或危险行为",
    "未成年人严重侵害",
    "违法广告与欺诈商业，尤其药品、医疗虚假宣传",
  ],
  yellow: [
    "违背公序良俗或不良价值导向，包括出轨、未婚先孕、戴绿帽、拜金炫富和物化他人",
    "残障、地域、职业、年龄、性别、外貌、学历、贫富、疾病或身份歧视",
    "夸大宣传、绝对化表述、功效或收益保证",
    "虚构或误导性的专家、机构、明星、官方或用户背书",
    "恐惧营销、制造焦虑、羞耻感或群体压力",
    "虚假限时限量、诱导未成年人消费或隐瞒收费条件",
    "具有模仿风险但未达到红灯程度的危险行为",
    "血腥暴力画面，尤其流血、伤口、肢体损伤或其他令人不适的细节",
    "隐私、肖像、个人信息或真实经历暴露风险",
    "知识产权、仿冒品牌或误导性高仿表达",
    "违规导流、刷单或刷评",
    "不当诱导或强迫互动：通过恐吓、诅咒、道德绑架、迷信暗示，以无法验证的好运、财富、礼品、资料、教程等承诺，或故意扣留关键信息、设置虚假悬念等方式，迫使或欺骗用户点赞、评论、关注、收藏、转发、私信或停留",
    "封建迷信、伪科学、不文明表达、人身攻击或轻度网络暴力",
  ],
};

export function buildWorkflowCompliancePrompt(text = "") {
  return `检测下面文案的违规风险。必须逐条结合上下文检查，但“军人、警察等公职人员”是硬规则：只要文案出现相关身份，无论正面、负面、虚构、历史背景或普通角色描写，都判红灯，不得豁免。

红灯规则：
${workflowComplianceRules.red.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}

黄灯规则：
${workflowComplianceRules.yellow.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}

黄灯判定排除：正常、非强制的互动邀请不属于“不当诱导或强迫互动”，例如“欢迎在评论区交流”“喜欢的话可以点赞关注”“你怎么看？欢迎留言”。不得仅因文案出现点赞、评论、关注、收藏、转发、私信等互动词语就判定风险；必须存在上述恐吓、欺骗、胁迫、道德绑架、无法验证的利益承诺或虚假悬念等不当手段。

只返回合法 JSON，不要 Markdown 或解释。格式：
{"issues":[{"level":"red或yellow","category":"风险类别","quote":"原文中的最短完整连续片段","reason":"具体风险说明","suggestion":"不改变核心意思的修改建议"}]}

quote 必须逐字复制原文中足以理解风险的最短完整连续片段，不能改写。相同片段涉及多个风险时分别返回。没有风险时返回 {"issues":[]}。

待检测文案：
${String(text || "")}`;
}

export function normalizeWorkflowComplianceIssues(value, text = "") {
  const source = Array.isArray(value) ? value : Array.isArray(value?.issues) ? value.issues : [];
  const normalized = source.map((issue, index) => {
    const level = String(issue?.level || issue?.severity || "").toLowerCase() === "red" ? "red" : "yellow";
    const quote = String(issue?.quote || issue?.text || issue?.excerpt || "").trim();
    const category = String(issue?.category || issue?.type || "其他风险").trim();
    return {
      id: String(issue?.id || `risk-${index + 1}`),
      level,
      category,
      quote,
      reason: String(issue?.reason || issue?.description || "").trim(),
      suggestion: String(issue?.suggestion || issue?.advice || "").trim(),
    };
  }).filter((issue) => issue.quote && String(text || "").includes(issue.quote));
  return mergeWorkflowComplianceIssues(normalized, [
    ...deterministicPublicRoleIssues(text),
    ...deterministicGraphicViolenceIssues(text),
  ]);
}

export function buildWorkflowComplianceHighlights(text = "", issues = []) {
  const content = String(text || "");
  const ranges = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const quote = String(issue?.quote || "");
    if (!quote) continue;
    let start = 0;
    let matches = 0;
    while (start < content.length && matches < 50) {
      const index = content.indexOf(quote, start);
      if (index < 0) break;
      ranges.push({ start: index, end: index + quote.length, issue });
      start = index + Math.max(1, quote.length);
      matches += 1;
    }
  }
  const boundaries = [...new Set([0, content.length, ...ranges.flatMap((range) => [range.start, range.end])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const activeIssues = ranges.filter((range) => range.start <= start && range.end >= end).map((range) => range.issue);
    return {
      start,
      end,
      text: content.slice(start, end),
      issues: activeIssues,
      level: activeIssues.some((issue) => issue.level === "red") ? "red" : activeIssues.length ? "yellow" : "",
    };
  }).filter((segment) => segment.text);
}

function deterministicPublicRoleIssues(text = "") {
  const issues = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(publicRolePattern)) {
    const quote = sentenceFragmentAround(String(text || ""), match.index || 0, match[0].length);
    if (!quote || seen.has(quote)) continue;
    seen.add(quote);
    issues.push({
      id: `public-role-${issues.length + 1}`,
      level: "red",
      category: "受限制公职人员",
      quote,
      reason: `文案出现“${match[0]}”身份，命中不得出现的硬规则。`,
      suggestion: "删除该身份，或替换为不涉及公职的虚构职业。",
    });
  }
  return issues;
}

function deterministicGraphicViolenceIssues(text = "") {
  const issues = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(graphicViolencePattern)) {
    const quote = sentenceFragmentAround(String(text || ""), match.index || 0, match[0].length);
    if (!quote || seen.has(quote)) continue;
    seen.add(quote);
    issues.push({
      id: `graphic-violence-${issues.length + 1}`,
      level: "yellow",
      category: "血腥暴力画面",
      quote,
      reason: `文案出现“${match[0]}”等血腥或流血细节，画面化后可能引起不适或审核风险。`,
      suggestion: "弱化伤口和流血细节，改为不直接呈现血腥画面的受伤或冲突描述。",
    });
  }
  return issues;
}

function sentenceFragmentAround(text, index, matchLength) {
  const separators = /[。！？!?；;\n]/;
  let start = index;
  let end = index + matchLength;
  while (start > 0 && !separators.test(text[start - 1])) start -= 1;
  while (end < text.length && !separators.test(text[end])) end += 1;
  return text.slice(start, end).trim() || text.slice(index, index + matchLength);
}

function mergeWorkflowComplianceIssues(primary = [], required = []) {
  const merged = [];
  const keys = new Set();
  for (const issue of [...required, ...primary]) {
    const key = `${issue.level}:${issue.category}:${issue.quote}`;
    const overlapsExisting = merged.some((current) => current.level === issue.level
      && current.category === issue.category
      && (current.quote.includes(issue.quote) || issue.quote.includes(current.quote)));
    if (keys.has(key) || overlapsExisting) continue;
    keys.add(key);
    merged.push({ ...issue, id: `risk-${merged.length + 1}` });
  }
  return merged;
}
