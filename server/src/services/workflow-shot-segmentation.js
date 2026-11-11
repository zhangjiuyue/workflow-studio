const TALKING_SHOT_DURATION_MODE = "duration-semantic";
const TALKING_SHOT_PUNCTUATION_MODE = "punctuation";
const DEFAULT_TARGET_SECONDS = 5;
const DEFAULT_MIN_SECONDS = 3;
const DEFAULT_MAX_SECONDS = 7;

export function normalizeTalkingShotSegmentationMode(value = "") {
  return String(value || "").trim() === TALKING_SHOT_PUNCTUATION_MODE
    ? TALKING_SHOT_PUNCTUATION_MODE
    : TALKING_SHOT_DURATION_MODE;
}

export function talkingShotAudioSegments(run = {}) {
  const result = run.result && typeof run.result === "object" ? run.result : run;
  const audio = result.audio && typeof result.audio === "object" ? result.audio : {};
  const tracks = Array.isArray(result.audioTracks) ? result.audioTracks : [];
  const activeTrack = tracks.at(-1) || {};
  const candidates = [
    result.audioRawSegments,
    audio.raw_segments,
    audio.rawSegments,
    activeTrack.rawSegments,
    activeTrack.raw_segments,
    result.talkingShotSourceAudioSegments,
    result.audioSegments,
    audio.segments,
    activeTrack.segments,
  ];
  for (const candidate of candidates) {
    const segments = normalizeTimedSegments(candidate);
    if (segments.length) return segments;
  }
  const srtCandidates = [
    result.talkingShotSourceSubtitleSrt,
    result.subtitleSrt,
    audio.subtitle_srt,
    audio.subtitleSrt,
    activeTrack.subtitle_srt,
    activeTrack.subtitleSrt,
  ];
  for (const srt of srtCandidates) {
    const segments = parseTalkingShotSrt(srt);
    if (segments.length) return segments;
  }
  return [];
}

export function planTalkingShotSegments(input = [], options = {}) {
  const segments = normalizeTimedSegments(Array.isArray(input) ? input : talkingShotAudioSegments(input));
  if (!segments.length) return [];
  const targetSeconds = positiveNumber(options.targetSeconds, DEFAULT_TARGET_SECONDS);
  const minSeconds = positiveNumber(options.minSeconds, DEFAULT_MIN_SECONDS);
  const maxSeconds = Math.max(minSeconds, positiveNumber(options.maxSeconds, DEFAULT_MAX_SECONDS));
  const count = segments.length;
  const bestCosts = Array(count + 1).fill(Number.POSITIVE_INFINITY);
  const previous = Array(count + 1).fill(-1);
  bestCosts[0] = 0;

  for (let end = 1; end <= count; end += 1) {
    for (let start = end - 1; start >= 0; start -= 1) {
      const duration = Math.max(0, segments[end - 1].end - segments[start].start);
      const singleOversizedSegment = start === end - 1 && duration > maxSeconds;
      if (!singleOversizedSegment && duration > maxSeconds + targetSeconds) break;
      const cost = bestCosts[start] + talkingShotGroupCost(
        segments,
        start,
        end - 1,
        { targetSeconds, minSeconds, maxSeconds },
      );
      if (cost < bestCosts[end]) {
        bestCosts[end] = cost;
        previous[end] = start;
      }
    }
  }

  const groups = [];
  let cursor = count;
  while (cursor > 0) {
    const start = previous[cursor] >= 0 ? previous[cursor] : cursor - 1;
    const groupSegments = segments.slice(start, cursor);
    groups.unshift({
      index: 0,
      text: joinTalkingShotTexts(groupSegments.map((segment) => segment.text)),
      start: roundTime(groupSegments[0].start),
      end: roundTime(groupSegments.at(-1).end),
      duration: roundTime(groupSegments.at(-1).end - groupSegments[0].start),
      sourceIndexes: groupSegments.map((segment) => segment.index),
    });
    cursor = start;
  }
  return groups.map((group, index) => ({ ...group, index: index + 1 }));
}

export function planTalkingPunctuationShotSegments(input = [], script = "") {
  const segments = normalizeTimedSegments(Array.isArray(input) ? input : talkingShotAudioSegments(input));
  const chunks = splitTalkingShotPunctuationText(script);
  if (!segments.length || !chunks.length) return [];
  const tokens = talkingShotMatchTokens(segments);
  const audioText = tokens.map((token) => token.norm).join("");
  const scriptText = chunks.map((chunk) => normalizeTalkingShotMatchText(chunk)).join("");
  const totalDuration = Math.max(0, segments.at(-1).end - segments[0].start);
  const scale = scriptText.length > 0 && audioText.length > 0 ? audioText.length / scriptText.length : 1;
  let scriptCursor = 0;
  let audioCursor = 0;
  const plan = chunks.map((text, index) => {
    const norm = normalizeTalkingShotMatchText(text);
    const fallbackStart = Math.round(scriptCursor * scale);
    const fallbackEnd = Math.round((scriptCursor + Math.max(1, norm.length)) * scale);
    const matchedStart = norm ? audioText.indexOf(norm, Math.max(0, audioCursor - 24)) : -1;
    const startOffset = matchedStart >= 0 ? matchedStart : fallbackStart;
    const endOffset = matchedStart >= 0 ? matchedStart + norm.length : fallbackEnd;
    const selected = tokens.filter((token) => token.normEnd > startOffset && token.normStart < endOffset);
    const start = selected.length
      ? selected[0].start
      : segments[0].start + totalDuration * Math.max(0, startOffset) / Math.max(1, audioText.length);
    const end = selected.length
      ? selected.at(-1).end
      : segments[0].start + totalDuration * Math.max(startOffset + 1, endOffset) / Math.max(1, audioText.length);
    scriptCursor += norm.length;
    audioCursor = Math.max(audioCursor, endOffset);
    return {
      index: index + 1,
      text,
      start: roundTime(start),
      end: roundTime(Math.max(start, end)),
      duration: roundTime(Math.max(0, end - start)),
      sourceIndexes: selected.map((token) => token.index),
    };
  });
  return plan.map((segment, index) => {
    const start = index === 0 ? segments[0].start : segment.start;
    const end = index === plan.length - 1 ? segments.at(-1).end : Math.max(start, plan[index + 1].start);
    return {
      ...segment,
      start: roundTime(start),
      end: roundTime(end),
      duration: roundTime(Math.max(0, end - start)),
    };
  });
}

export function talkingShotSegmentsToSrt(segments = []) {
  return normalizeTimedSegments(segments).map((segment, index) => (
    `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n${segment.text}\n`
  )).join("\n");
}

export function formatTalkingShotSegmentationPlan(segments = []) {
  return normalizeTimedSegments(segments).map((segment, index) => (
    `${index + 1}. [${formatClockTime(segment.start)} - ${formatClockTime(segment.end)}] ${segment.text}`
  )).join("\n");
}

function talkingShotGroupCost(segments, start, end, options) {
  const duration = Math.max(0, segments[end].end - segments[start].start);
  const durationDelta = duration - options.targetSeconds;
  let cost = durationDelta * durationDelta;
  if (duration < options.minSeconds && !(start === 0 && end === segments.length - 1)) {
    cost += Math.pow(options.minSeconds - duration, 2) * 7;
  }
  if (duration > options.maxSeconds) {
    cost += Math.pow(duration - options.maxSeconds, 2) * 9;
  }
  if (end < segments.length - 1) {
    cost += talkingShotBoundaryPenalty(segments[end].text, segments[end + 1].text);
  }
  return cost;
}

function talkingShotBoundaryPenalty(currentText = "", nextText = "") {
  const current = String(currentText || "").trim();
  const next = String(nextText || "").trim();
  if (/[。！？.!?][”’"']?$/.test(current)) return 0;
  if (/[；;：:][”’"']?$/.test(current)) return 0.8;
  if (/[，,、][”’"']?$/.test(current)) return 1.5;
  if (/(?:因为|如果|虽然|但是|而且|以及|或者|与|和|的|之所以|when|while|because|although|though|if|and|or|but|to|of|with|for)$/i.test(current)) return 8;
  if (/^(?:但是|不过|然而|所以|因此|同时|接着|然后|but|however|therefore|meanwhile|then)\b/i.test(next)) return 1.5;
  return 3.5;
}

function normalizeTimedSegments(segments = []) {
  if (!Array.isArray(segments)) return [];
  let cursor = 0;
  return segments.map((segment, index) => {
    const text = String(segment?.text || segment?.script || segment?.content || "").trim();
    if (!text) return null;
    const rawStart = finiteNumber(segment?.start, cursor);
    const start = Math.max(cursor, rawStart);
    const rawEnd = finiteNumber(segment?.end, start);
    const end = Math.max(start, rawEnd);
    cursor = end;
    return {
      index: Number(segment?.index || index + 1),
      text,
      start: roundTime(start),
      end: roundTime(end),
    };
  }).filter((segment) => segment && segment.end >= segment.start);
}

function splitTalkingShotPunctuationText(script = "") {
  const matches = String(script || "").replace(/\r\n?/g, "\n").trim().match(/[^。！？!?；;，,：:、.\n]+[。！？!?；;，,：:、.]?/g) || [];
  return matches.map((item) => item.trim()).filter(Boolean);
}

function talkingShotMatchTokens(segments = []) {
  let cursor = 0;
  return segments.map((segment) => {
    const norm = normalizeTalkingShotMatchText(segment.text);
    const normStart = cursor;
    const normEnd = normStart + norm.length;
    cursor = normEnd;
    return {
      ...segment,
      norm,
      normStart,
      normEnd,
    };
  }).filter((segment) => segment.norm);
}

function normalizeTalkingShotMatchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function parseTalkingShotSrt(value = "") {
  const blocks = String(value || "").replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  return blocks.map((block, index) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) return null;
    const [startValue, endValue] = lines[timeIndex].split("-->").map((item) => item.trim());
    const start = parseSrtTime(startValue);
    const end = parseSrtTime(endValue);
    const text = lines.slice(timeIndex + 1).join(" ").trim();
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { index: index + 1, text, start, end };
  }).filter(Boolean);
}

function parseSrtTime(value = "") {
  const match = String(value || "").match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function joinTalkingShotTexts(texts = []) {
  return texts.reduce((joined, rawText) => {
    const text = String(rawText || "").trim();
    if (!text) return joined;
    if (!joined) return text;
    const separator = /[A-Za-z0-9][,.;:!?"'”’)]?$/.test(joined) && /^[A-Za-z0-9]/.test(text) ? " " : "";
    return `${joined}${separator}${text}`;
  }, "");
}

function formatSrtTime(seconds = 0) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
}

function formatClockTime(seconds = 0) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const minutes = Math.floor(milliseconds / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${pad(minutes, 2)}:${pad(secs, 2)}.${pad(millis, 3)}`;
}

function pad(value, length) {
  return String(value).padStart(length, "0");
}

function roundTime(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}
