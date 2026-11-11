const workflowAudioVoicePresetIds = new Set(["default", "clone", "saved"]);

export function resolveWorkflowAudioGenerationSettings(workflow = {}, overrides = {}) {
  const config = workflow?.config && typeof workflow.config === "object" ? workflow.config : {};
  const configuredValue = (key, fallback) => (
    workflow?.[key] !== undefined
      ? workflow[key]
      : config[key] !== undefined
        ? config[key]
        : fallback
  );
  const resolvedValue = (key, fallback) => (
    overrides?.[key] !== undefined ? overrides[key] : configuredValue(key, fallback)
  );
  const requestedPresetId = String(resolvedValue("audioVoicePresetId", "default") || "default").trim();
  const audioVoicePresetId = workflowAudioVoicePresetIds.has(requestedPresetId) ? requestedPresetId : "default";
  const audioReferenceId = String(resolvedValue("audioReferenceId", "") || "").trim();
  const resolvedReferences = resolvedValue("audioReferences", []);
  const audioReferences = Array.isArray(resolvedReferences) ? resolvedReferences : [];

  return {
    audioVoice: String(resolvedValue("audioVoice", "alloy") || "alloy").trim() || "alloy",
    audioVoicePresetId,
    audioReferenceId: audioVoicePresetId === "saved" ? audioReferenceId : "",
    audioReferences: audioVoicePresetId === "clone" ? audioReferences : [],
  };
}
