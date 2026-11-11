import { mediaHttp } from '../security/public-http.js';
import assert from "node:assert/strict";
import test from "node:test";
import { createFileZipPackage, createImageDownload, createImageZipPackage } from "./image-package.js";

const tinyVideoUrl = "data:video/mp4;base64,AA==";
const tinyPng = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("file ZIP packages accept up to 500 files", async () => {
  const files = Array.from({ length: 500 }, (_, index) => ({
    url: tinyVideoUrl,
    name: `video-${index + 1}.mp4`,
  }));

  const packageResult = await createFileZipPackage({ files });
  try {
    assert.ok(packageResult.size > 0);
  } finally {
    await packageResult.cleanup();
  }
});

test("file ZIP packages reject more than 500 files", async () => {
  const files = Array.from({ length: 501 }, (_, index) => ({
    url: tinyVideoUrl,
    name: `video-${index + 1}.mp4`,
  }));

  await assert.rejects(
    createFileZipPackage({ files }),
    (error) => error?.status === 400 && error?.message === "单次最多打包 500 个文件。",
  );
});

test("image downloads accept PNG bytes served as application/octet-stream", async (context) => {
  context.mock.method(mediaHttp, "fetch", async () => new Response(tinyPng, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  }));

  const result = await createImageDownload({
    url: "https://images.example.com/generated-file",
    fileName: "generated-image",
  });

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.fileName, "generated-image.png");
  assert.deepEqual(result.buffer, tinyPng);
});

test("image ZIP packages accept image signatures when the response MIME is generic", async (context) => {
  context.mock.method(mediaHttp, "fetch", async () => new Response(tinyPng, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  }));

  const packageResult = await createImageZipPackage({
    folder: "video-materials",
    files: [{ url: "https://images.example.com/generated-file", name: "scene.png" }],
  });
  try {
    assert.ok(packageResult.size > tinyPng.length);
  } finally {
    await packageResult.cleanup();
  }
});

test("image downloads still reject non-image bytes served as application/octet-stream", async (context) => {
  context.mock.method(mediaHttp, "fetch", async () => new Response("not an image", {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  }));

  await assert.rejects(
    createImageDownload({ url: "https://images.example.com/error-page" }),
    (error) => error?.status === 400 && error?.message === "图片地址返回的不是图片文件。",
  );
});
