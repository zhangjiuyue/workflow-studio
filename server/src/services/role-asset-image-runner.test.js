import test from "node:test";
import assert from "node:assert/strict";
import { composeRoleImageGenerationPrompt } from "./role-asset-image-runner.js";

test("真人大头三视图使用真人特写与全身转面构图", () => {
  const basePrompt = "中国女性，全身照，孕妇体形，黑色直发戴珍珠发箍，浅黄色短袖连衣裙，无表情，双手下垂，正常清晰人脸，真实摄影，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物";

  const prompt = composeRoleImageGenerationPrompt(basePrompt, 0, "sketch-three");

  assert.match(prompt, /正常清晰人脸/);
  assert.match(prompt, /真实摄影/);
  assert.match(prompt, /左侧：人物脸部大特写肖像，右侧：全身三视图转面展示，包含正面、侧面、背面/);
  assert.doesNotMatch(prompt, /素描|马赛克/);
});
