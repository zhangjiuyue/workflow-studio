import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserImagePackage } from "./browser-image-package.mjs";
import { imageFileTypeFromBytes } from "./image-file-signature.mjs";

const tinyPng = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));

test("detects supported image signatures", () => {
  assert.deepEqual(imageFileTypeFromBytes(tinyPng), { extension: "png", mimeType: "image/png" });
  assert.deepEqual(imageFileTypeFromBytes(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), { extension: "jpg", mimeType: "image/jpeg" });
  assert.equal(imageFileTypeFromBytes(new TextEncoder().encode("not an image")), null);
});

test("browser packages generic MIME responses when their bytes are a real image", async () => {
  const progress = [];
  const result = await createBrowserImagePackage({
    folder: "video-materials",
    fileName: "video-materials",
    files: [{
      url: "https://images.example.com/generated-file",
      name: "第1镜/角色.png",
      label: "角色",
      prompt: "角色提示词",
    }],
    sheet: {
      name: "视频任务",
      headers: ["提示词", "参考图片"],
      rows: [["视频提示词", "第1镜/角色.png"]],
    },
  }, {
    fetchImpl: async () => new Response(tinyPng, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    }),
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.fileName, "video-materials.zip");
  assert.equal(result.count, 1);
  assert.ok(result.blob.size > tinyPng.length);
  const zipText = Buffer.from(await result.blob.arrayBuffer()).toString("utf8");
  assert.match(zipText, /video-materials\/第1镜\/角色\.png/);
  assert.match(zipText, /video-materials\/视频任务\.xlsx/);
  assert.equal(progress.at(-1)?.progress, 96);
});

test("browser packaging rejects generic MIME responses without an image signature", async () => {
  await assert.rejects(
    createBrowserImagePackage({
      files: [{ url: "https://images.example.com/error-page", label: "错误图片" }],
    }, {
      fetchImpl: async () => new Response("not an image", {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    }),
    /返回的内容不是支持的 PNG、JPEG、WebP 或 GIF 图片/,
  );
});
