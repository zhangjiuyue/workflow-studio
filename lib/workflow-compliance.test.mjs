import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkflowComplianceHighlights,
  buildWorkflowCompliancePrompt,
  normalizeWorkflowComplianceIssues,
} from "./workflow-compliance.mjs";

test("违规检测提示词区分不当互动诱导与正常互动邀请", () => {
  const prompt = buildWorkflowCompliancePrompt("你怎么看？欢迎留言。");
  assert.match(prompt, /不当诱导或强迫互动/);
  assert.match(prompt, /不得仅因文案出现点赞、评论、关注、收藏、转发、私信等互动词语就判定风险/);
  assert.match(prompt, /你怎么看？欢迎留言/);
});

test("公职人员无论模型是否发现都强制补充红灯风险", () => {
  const text = "他曾是一名警察，后来回乡开了一家小店。";
  const issues = normalizeWorkflowComplianceIssues({ issues: [] }, text);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "red");
  assert.equal(issues[0].category, "受限制公职人员");
  assert.match(issues[0].quote, /警察/);
});

test("明确流血描写在模型漏检时仍补充黄灯风险", () => {
  const text = "他的伤口不断流血，众人慌忙离开。";
  const issues = normalizeWorkflowComplianceIssues({ issues: [] }, text);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "yellow");
  assert.equal(issues[0].category, "血腥暴力画面");
});

test("模型风险必须引用原文且红灯优先显示", () => {
  const text = "警察受伤后鲜血不断从伤口流出。";
  const issues = normalizeWorkflowComplianceIssues({ issues: [
    { level: "yellow", category: "血腥暴力画面", quote: "鲜血不断从伤口流出", reason: "包含流血细节" },
    { level: "yellow", category: "无效", quote: "不在原文里的改写" },
  ] }, text);
  assert.equal(issues.some((issue) => issue.category === "无效"), false);
  assert.equal(issues.some((issue) => issue.level === "yellow" && issue.quote.includes("鲜血")), true);
  const highlighted = buildWorkflowComplianceHighlights(text, issues);
  assert.equal(highlighted.some((segment) => segment.level === "red" && segment.text.includes("警察")), true);
  assert.equal(highlighted.some((segment) => segment.level === "red" && segment.text.includes("鲜血")), true);
});

test("同一片段命中多项风险时保留全部风险并按最高等级着色", () => {
  const text = "他持刀威胁未成年人。";
  const issues = normalizeWorkflowComplianceIssues({ issues: [
    { level: "yellow", category: "危险行为", quote: text },
    { level: "red", category: "未成年人严重侵害", quote: text },
  ] }, text);
  const segment = buildWorkflowComplianceHighlights(text, issues).find((item) => item.issues.length === 2);
  assert.equal(segment.level, "red");
  assert.equal(segment.issues.length, 2);
});
