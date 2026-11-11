const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/;

export function normalizeYoutubeVideoUrl(value = "") {
  const videoId = youtubeVideoIdFromUrl(value);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
}

export function isYoutubeVideoUrl(value = "") {
  return Boolean(youtubeVideoIdFromUrl(value));
}

export function youtubeVideoIdFromUrl(value = "") {
  const input = String(value || "").trim();
  if (!input) return "";
  const candidate = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(input)
    ? `https://${input}`
    : input;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "";

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  let videoId = "";
  if (hostname === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
    if (parsed.pathname === "/watch") {
      videoId = parsed.searchParams.get("v") || "";
    } else {
      videoId = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/i)?.[1] || "";
    }
  }
  return youtubeVideoIdPattern.test(videoId) ? videoId : "";
}
