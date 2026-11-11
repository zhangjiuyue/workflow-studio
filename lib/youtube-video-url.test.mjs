import assert from "node:assert/strict";
import test from "node:test";
import { isYoutubeVideoUrl, normalizeYoutubeVideoUrl, youtubeVideoIdFromUrl } from "./youtube-video-url.mjs";

test("normalizes supported YouTube video URL variants", () => {
  const expected = "https://www.youtube.com/watch?v=9hE5-98ZeCg";
  assert.equal(normalizeYoutubeVideoUrl("https://www.youtube.com/watch?v=9hE5-98ZeCg&t=30s"), expected);
  assert.equal(normalizeYoutubeVideoUrl("youtu.be/9hE5-98ZeCg?si=tracking"), expected);
  assert.equal(normalizeYoutubeVideoUrl("https://youtube.com/shorts/9hE5-98ZeCg"), expected);
  assert.equal(normalizeYoutubeVideoUrl("https://m.youtube.com/live/9hE5-98ZeCg"), expected);
  assert.equal(normalizeYoutubeVideoUrl("https://www.youtube.com/embed/9hE5-98ZeCg"), expected);
});

test("rejects non-video, non-YouTube, and lookalike URLs", () => {
  assert.equal(youtubeVideoIdFromUrl("https://www.youtube.com/playlist?list=PL123"), "");
  assert.equal(isYoutubeVideoUrl("https://youtube.com.evil.example/watch?v=9hE5-98ZeCg"), false);
  assert.equal(isYoutubeVideoUrl("https://example.com/video.mp4"), false);
  assert.equal(isYoutubeVideoUrl("javascript:alert(1)"), false);
  assert.equal(isYoutubeVideoUrl("not a URL"), false);
});
