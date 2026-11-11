import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTalkingShotSegmentationPlan,
  normalizeTalkingShotSegmentationMode,
  planTalkingPunctuationShotSegments,
  planTalkingShotSegments,
  talkingShotAudioSegments,
  talkingShotSegmentsToSrt,
} from "./workflow-shot-segmentation.js";

test("talking shot segmentation defaults to duration-semantic and preserves punctuation mode", () => {
  assert.equal(normalizeTalkingShotSegmentationMode(), "duration-semantic");
  assert.equal(normalizeTalkingShotSegmentationMode("duration-semantic"), "duration-semantic");
  assert.equal(normalizeTalkingShotSegmentationMode("punctuation"), "punctuation");
  assert.equal(normalizeTalkingShotSegmentationMode("unknown"), "duration-semantic");
});

test("talking shot segmentation uses raw ASR timing and moves cuts to stronger semantic boundaries", () => {
  const plan = planTalkingShotSegments([
    { index: 1, start: 0, end: 2.5, text: "We thought the answer was simple," },
    { index: 2, start: 2.5, end: 5, text: "because" },
    { index: 3, start: 5, end: 6.2, text: "history changed everything." },
    { index: 4, start: 6.2, end: 9, text: "The next clue appeared," },
    { index: 5, start: 9, end: 12, text: "and the mystery was finally solved." },
  ]);

  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((segment) => [segment.start, segment.end]), [[0, 6.2], [6.2, 12]]);
  assert.equal(plan[0].text, "We thought the answer was simple, because history changed everything.");
  assert.deepEqual(plan[0].sourceIndexes, [1, 2, 3]);
  assert.match(formatTalkingShotSegmentationPlan(plan), /00:00\.000 - 00:06\.200/);
});

test("talking shot segmentation parses SRT when structured audio segments are absent", () => {
  const srt = `1
00:00:00,000 --> 00:00:02,400
第一段，

2
00:00:02,400 --> 00:00:05,100
第二段。

3
00:00:05,100 --> 00:00:09,900
第三段。`;
  const segments = talkingShotAudioSegments({
    result: {
      audioSegments: [],
      subtitleSrt: srt,
    },
  });

  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((segment) => [segment.start, segment.end]), [[0, 2.4], [2.4, 5.1], [5.1, 9.9]]);
  const plan = planTalkingShotSegments(segments);
  assert.equal(plan.length, 2);
  assert.match(talkingShotSegmentsToSrt(plan), /00:00:05,100 --> 00:00:09,900/);
});

test("punctuation mode creates final timed segments from raw ASR tokens", () => {
  const rawSegments = [
    { index: 1, start: 0, end: 1.2, text: "第一段" },
    { index: 2, start: 1.2, end: 1.5, text: "，" },
    { index: 3, start: 1.5, end: 3.8, text: "第二段" },
    { index: 4, start: 3.8, end: 4.1, text: "。" },
  ];
  const plan = planTalkingPunctuationShotSegments(rawSegments, "第一段，第二段。");

  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((segment) => segment.text), ["第一段，", "第二段。"]);
  assert.deepEqual(plan.map((segment) => [segment.start, segment.end]), [[0, 1.5], [1.5, 4.1]]);
});
