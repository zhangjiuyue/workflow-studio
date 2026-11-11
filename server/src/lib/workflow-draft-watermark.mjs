export const DRAFT_WATERMARK_TEXT_WIDTH_RATIO = 0.3;

const DRAFT_WATERMARK_ANCHORS = Object.freeze({
  "top-left": Object.freeze({ x: 0.14, y: 0.1 }),
  "top-right": Object.freeze({ x: 0.86, y: 0.1 }),
  "bottom-right": Object.freeze({ x: 0.86, y: 0.9 }),
  "bottom-left": Object.freeze({ x: 0.14, y: 0.9 }),
});

export function draftWatermarkAnchor(position = "bottom-right") {
  return DRAFT_WATERMARK_ANCHORS[position] || DRAFT_WATERMARK_ANCHORS["bottom-right"];
}

