import assert from "node:assert/strict";
import test from "node:test";
import {
  stripWorkflowRoleImageStyle,
  workflowRoleImageStylePrompt,
} from "./workflow-role-image-style.mjs";

test("role appearance prompts remove image style, layout, background, and face treatment", () => {
  const prompt = "中国男性，中年，全身照，偏瘦体形，黑色短发梳理整齐，穿深灰色西装、白衬衫、黑色领带，神情傲慢冷淡，双手下垂，人物脸部打上马赛克，其他部分保持真实摄影，三视图，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物";
  assert.equal(
    stripWorkflowRoleImageStyle(prompt),
    "中国男性，中年，偏瘦体形，黑色短发梳理整齐，穿深灰色西装、白衬衫、黑色领带，神情傲慢冷淡",
  );
});

test("role image style is composed only when generation starts", () => {
  assert.match(workflowRoleImageStylePrompt("mosaic-three"), /人物脸部打上马赛克/);
  assert.match(workflowRoleImageStylePrompt("sketch-three"), /正常清晰人脸/);
  assert.equal(workflowRoleImageStylePrompt("custom", "复古港片定妆照"), "复古港片定妆照");
});

test("prefixed legacy style requirements are removed from role appearance prompts", () => {
  assert.equal(
    stripWorkflowRoleImageStyle("中国青年男性，偏瘦学生身形，短黑发，补充要求：无表情，真实摄影。"),
    "中国青年男性，偏瘦学生身形，短黑发",
  );
});
