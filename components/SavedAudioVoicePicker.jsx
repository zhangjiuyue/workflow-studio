"use client";

import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "flowstudio:saved-audio-voices";
const STORAGE_EVENT = "flowstudio:saved-audio-voices:update";
const MAX_SAVED_VOICES = 60;

export default function SavedAudioVoicePicker({
  value,
  onChange,
  idLabel = "已克隆音色 ID",
  providerName = "音频服务",
  className = "",
}) {
  const [voices, setVoices] = useState([]);
  const referenceId = String(value || "");
  const trimmedReferenceId = referenceId.trim();
  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.referenceId === trimmedReferenceId) || null,
    [trimmedReferenceId, voices],
  );
  const [draftName, setDraftName] = useState("");

  useEffect(() => {
    setVoices(readSavedAudioVoices());

    function handleStorage(event) {
      if (event.type === STORAGE_EVENT) {
        setVoices(Array.isArray(event.detail) ? event.detail : readSavedAudioVoices());
        return;
      }
      if (!event.key || event.key === STORAGE_KEY) setVoices(readSavedAudioVoices());
    }

    window.addEventListener("storage", handleStorage);
    window.addEventListener(STORAGE_EVENT, handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(STORAGE_EVENT, handleStorage);
    };
  }, []);

  useEffect(() => {
    setDraftName(selectedVoice?.name || "");
  }, [selectedVoice?.id, selectedVoice?.name]);

  function handleSelect(voiceId) {
    const voice = voices.find((item) => item.id === voiceId);
    onChange(voice?.referenceId || "");
  }

  function handleSave() {
    if (!trimmedReferenceId) return;
    const nextVoice = {
      id: selectedVoice?.id || createSavedVoiceId(trimmedReferenceId),
      name: cleanVoiceName(draftName) || selectedVoice?.name || `音色 ${shortReferenceId(trimmedReferenceId)}`,
      referenceId: trimmedReferenceId,
      updatedAt: new Date().toISOString(),
    };
    const nextVoices = [
      nextVoice,
      ...voices.filter((voice) => voice.id !== nextVoice.id && voice.referenceId !== nextVoice.referenceId),
    ].slice(0, MAX_SAVED_VOICES);
    writeSavedAudioVoices(nextVoices);
    setVoices(nextVoices);
    setDraftName(nextVoice.name);
    onChange(trimmedReferenceId);
  }

  function handleDelete() {
    if (!selectedVoice) return;
    const nextVoices = voices.filter((voice) => voice.id !== selectedVoice.id);
    writeSavedAudioVoices(nextVoices);
    setVoices(nextVoices);
  }

  return (
    <div className={`saved-audio-voice-picker-next ${className}`.trim()}>
      <label>
        已保存音色
        <select value={selectedVoice?.id || ""} onChange={(event) => handleSelect(event.target.value)}>
          <option value="">手动输入或新增</option>
          {voices.map((voice) => (
            <option value={voice.id} key={voice.id}>
              {voice.name} · {shortReferenceId(voice.referenceId)}
            </option>
          ))}
        </select>
      </label>
      <div className="saved-audio-voice-fields-next">
        <label>
          音色名称
          <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="例如 女声旁白、品牌音色" />
        </label>
        <label>
          {idLabel}
          <input value={referenceId} onChange={(event) => onChange(event.target.value)} placeholder={`${providerName} reference_id`} />
        </label>
      </div>
      <div className="saved-audio-voice-actions-next">
        <button className="secondary-action compact" type="button" disabled={!trimmedReferenceId} onClick={handleSave}>
          {selectedVoice ? "更新音色" : "保存音色"}
        </button>
        {selectedVoice ? (
          <button className="secondary-action compact danger-soft-next" type="button" onClick={handleDelete}>
            删除记录
          </button>
        ) : null}
      </div>
      <span className="saved-audio-voice-help-next">
        保存在当前浏览器，可在自由创作和口播工作流里共用。
      </span>
    </div>
  );
}

function readSavedAudioVoices() {
  if (typeof window === "undefined") return [];
  try {
    return normalizeSavedAudioVoices(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

function writeSavedAudioVoices(voices) {
  if (typeof window === "undefined") return;
  const normalized = normalizeSavedAudioVoices(voices);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: normalized }));
}

function normalizeSavedAudioVoices(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => {
      const rawReferenceId = typeof item === "string"
        ? item
        : item?.referenceId || item?.reference_id || item?.voiceId || item?.voice_id || item?.refId || "";
      const referenceId = String(rawReferenceId || "").trim();
      if (!referenceId || seen.has(referenceId)) return null;
      seen.add(referenceId);
      const rawName = typeof item === "string" ? "" : item?.name || item?.label || item?.title || "";
      return {
        id: String(typeof item === "object" && item?.id ? item.id : createSavedVoiceId(referenceId)),
        name: cleanVoiceName(rawName) || `音色 ${shortReferenceId(referenceId)}`,
        referenceId,
        updatedAt: typeof item === "object" && item?.updatedAt ? String(item.updatedAt) : "",
      };
    })
    .filter(Boolean)
    .slice(0, MAX_SAVED_VOICES);
}

function cleanVoiceName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function createSavedVoiceId(referenceId) {
  return `voice-${hashString(referenceId)}`;
}

function shortReferenceId(referenceId) {
  const value = String(referenceId || "").trim();
  if (value.length <= 12) return value || "未命名";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
