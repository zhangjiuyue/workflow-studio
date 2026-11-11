import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkflowAudioGenerationSettings } from "./workflow-audio-settings.mjs";

test("undefined audio overrides do not erase the saved workflow voice", () => {
  assert.deepEqual(
    resolveWorkflowAudioGenerationSettings({
      audioVoice: "narrator",
      audioVoicePresetId: "saved",
      audioReferenceId: "fish-voice-id",
      audioReferences: [{ dataUrl: "data:audio/mp3;base64,AAAA" }],
    }, {
      audioVoice: undefined,
      audioVoicePresetId: undefined,
      audioReferenceId: undefined,
      audioReferences: undefined,
    }),
    {
      audioVoice: "narrator",
      audioVoicePresetId: "saved",
      audioReferenceId: "fish-voice-id",
      audioReferences: [],
    },
  );
});

test("clone mode keeps the same workflow references for every audio part", () => {
  const references = [{ dataUrl: "data:audio/mp3;base64,AAAA", transcript: "Hello" }];
  assert.deepEqual(
    resolveWorkflowAudioGenerationSettings({
      config: {
        audioVoicePresetId: "clone",
        audioReferences: references,
      },
    }),
    {
      audioVoice: "alloy",
      audioVoicePresetId: "clone",
      audioReferenceId: "",
      audioReferences: references,
    },
  );
});

test("explicit audio settings override the workflow without leaking another voice mode", () => {
  assert.deepEqual(
    resolveWorkflowAudioGenerationSettings({
      audioVoice: "alloy",
      audioVoicePresetId: "saved",
      audioReferenceId: "old-voice",
    }, {
      audioVoice: "nova",
      audioVoicePresetId: "default",
      audioReferenceId: "ignored-voice",
      audioReferences: [{ dataUrl: "ignored" }],
    }),
    {
      audioVoice: "nova",
      audioVoicePresetId: "default",
      audioReferenceId: "",
      audioReferences: [],
    },
  );
});
