import assert from "node:assert/strict";
import test from "node:test";

import { splitWorkflowTopicTranslation } from "./workflow-topic-display.mjs";

test("splits the generated English topic and Chinese translation", () => {
  assert.deepEqual(
    splitWorkflowTopicTranslation("The History of Salt — The White Gold That Bankrupted Kings｜中文：盐的历史——让国王破产的白色黄金"),
    {
      title: "The History of Salt — The White Gold That Bankrupted Kings",
      translation: "盐的历史——让国王破产的白色黄金",
    },
  );
});

test("accepts ASCII separators and multiline translation markers", () => {
  assert.deepEqual(splitWorkflowTopicTranslation("English topic | 中文: 中文释义"), {
    title: "English topic",
    translation: "中文释义",
  });
  assert.deepEqual(splitWorkflowTopicTranslation("English topic\n中文：中文释义"), {
    title: "English topic",
    translation: "中文释义",
  });
});

test("leaves topics without a complete translation marker unchanged", () => {
  assert.deepEqual(splitWorkflowTopicTranslation("普通中文选题"), {
    title: "普通中文选题",
    translation: "",
  });
  assert.deepEqual(splitWorkflowTopicTranslation("English topic｜中文："), {
    title: "English topic｜中文：",
    translation: "",
  });
});
