import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { readRawBody, httpError } from "../http.js";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_MULTIPART_FILES = 100;

export function getObjectStorageStatus(config) {
  const provider = normalizeProvider(config);
  return {
    provider,
    configured: provider === "local" || isRemoteStorageConfigured(config),
    bucket: config.storage?.bucket || "",
    endpoint: config.storage?.endpoint || "",
    publicBaseUrl: config.storage?.publicBaseUrl || "",
    localPath: provider === "local" ? getLocalUploadDir(config) : "",
  };
}

export async function uploadAssetFiles(req, body, user, config) {
  const files = await readUploadFiles(req, body);
  if (!files.length) throw httpError(400, "请选择要上传的文件。");
  if (files.length > MAX_MULTIPART_FILES) throw httpError(400, `单次最多上传 ${MAX_MULTIPART_FILES} 个文件。`);
  const uploaded = [];
  for (const file of files) {
    uploaded.push(await saveUploadedObject(config, user.id, file));
  }
  return { files: uploaded };
}

async function saveUploadedObject(config, userId, file) {
  const provider = normalizeProvider(config);
  if (provider !== "local" && !isRemoteStorageConfigured(config)) {
    console.warn("[object-storage] remote storage incomplete, saving uploaded asset locally", { provider });
    return await saveGeneratedImageObject(config, userId, file);
  }
  try {
    return await saveGeneratedImageObject(config, userId, file);
  } catch (error) {
    if (provider === "local") throw error;
    console.warn("[object-storage] remote storage failed, saving uploaded asset locally", {
      provider,
      message: error.message || String(error),
    });
    return await saveGeneratedImageObject(config, userId, file);
  }
}

export async function saveGeneratedObject(config, userId, file) {
  const provider = normalizeProvider(config);
  if (provider !== "local" && !isRemoteStorageConfigured(config)) {
    console.warn("[object-storage] remote storage incomplete, saving generated object locally", { provider });
    return await saveLocalObject(config, userId, file, { localUrl: true });
  }
  try {
    return await saveObject(config, userId, file);
  } catch (error) {
    if (provider === "local") throw error;
    console.warn("[object-storage] remote storage failed, saving generated object locally", {
      provider,
      message: error.message || String(error),
    });
    return await saveLocalObject(config, userId, file, { localUrl: true });
  }
}

export async function saveGeneratedImageObject(config, userId, file, options = {}) {
  const object = await saveGeneratedObject(config, userId, file);
  const thumbnailFile = await createImageThumbnailFile(file, options).catch((error) => {
    console.warn("[object-storage] image thumbnail generation failed", {
      filename: file?.filename || "",
      message: error.message || String(error),
    });
    return null;
  });
  if (!thumbnailFile) return object;
  try {
    const thumbnail = await saveGeneratedObject(config, userId, thumbnailFile);
    return {
      ...object,
      thumbnailKey: thumbnail.key,
      thumbnailUrl: thumbnail.url,
      thumbnailMimeType: thumbnail.mimeType,
      thumbnailSizeBytes: thumbnail.sizeBytes,
    };
  } catch (error) {
    console.warn("[object-storage] image thumbnail storage failed", {
      key: object.key,
      message: error.message || String(error),
    });
    return object;
  }
}

export async function serveStoredObject(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (!url.pathname.startsWith("/files/")) return false;
  const key = decodeURIComponent(url.pathname.slice("/files/".length));
  const localResult = await tryServeLocalObject(res, config, key);
  if (localResult) return true;
  const provider = normalizeProvider(config);
  if (provider === "local") throw httpError(404, "文件不存在。");
  if (isS3CompatibleProvider(provider) && isRemoteStorageConfigured(config)) {
    await serveS3CompatibleObject(res, config, key);
    return true;
  }
  throw httpError(404, "文件不存在。");
}

async function createImageThumbnailFile(file, options = {}) {
  if (!file?.buffer?.length) return null;
  const mimeType = String(file.mimeType || guessMimeType(file.filename)).toLowerCase();
  if (!mimeType.startsWith("image/") || mimeType.includes("gif") || mimeType.includes("svg")) return null;
  const width = Math.max(160, Math.min(960, Number(options.thumbnailWidth || 360) || 360));
  const buffer = await sharp(file.buffer, { animated: false })
    .rotate()
    .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
    .webp({ quality: Math.max(50, Math.min(86, Number(options.thumbnailQuality || 72) || 72)), effort: 4 })
    .toBuffer();
  if (!buffer.length || buffer.length >= file.buffer.length) return null;
  const parsed = path.parse(String(file.filename || "image.png"));
  return {
    buffer,
    filename: `${parsed.name || "image"}-thumb-${width}.webp`,
    mimeType: "image/webp",
  };
}

async function tryServeLocalObject(res, config, key) {
  const absolute = resolveLocalObjectPath(config, key);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const data = await fs.readFile(absolute);
  res.writeHead(200, {
    "Content-Type": guessMimeType(absolute),
    "Content-Length": data.length,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(data);
  return true;
}

async function serveS3CompatibleObject(res, config, key) {
  const signedRequest = createS3ObjectRequest(config, "GET", key);
  let response;
  try {
    response = await fetch(signedRequest.url, {
      method: "GET",
      headers: signedRequest.headers,
    });
  } catch (error) {
    throw httpError(502, `对象存储读取失败：${error.message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw httpError(response.status === 404 ? 404 : 502, `对象存储读取失败：${response.status} ${text.slice(0, 300)}`.trim());
  }
  const headers = {
    "Content-Type": response.headers.get("content-type") || guessMimeType(key),
    "Cache-Control": "public, max-age=3600",
  };
  const contentLength = response.headers.get("content-length");
  if (contentLength) headers["Content-Length"] = contentLength;
  res.writeHead(200, headers);
  if (response.body) {
    for await (const chunk of response.body) {
      res.write(chunk);
    }
  } else {
    res.write(Buffer.from(await response.arrayBuffer()));
  }
  res.end();
}

async function saveObject(config, userId, file) {
  if (!file.buffer?.length) throw httpError(400, "上传文件为空。");
  if (file.buffer.length > MAX_UPLOAD_BYTES) throw httpError(400, "单个文件不能超过 50MB。");
  const provider = normalizeProvider(config);
  if (provider === "local") return await saveLocalObject(config, userId, file);
  if (isS3CompatibleProvider(provider)) return await saveS3CompatibleObject(config, userId, file, provider);
  throw httpError(500, `暂不支持的对象存储类型：${provider}`);
}

async function saveLocalObject(config, userId, file, options = {}) {
  const now = new Date();
  const key = buildObjectKey(userId, file, now);
  const absolute = resolveLocalObjectPath(config, key);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, file.buffer);
  return {
    key,
    url: options.localUrl ? `/files/${encodePath(key)}` : buildObjectUrl(config, key),
    provider: "local",
    originalName: file.filename || "",
    mimeType: file.mimeType || guessMimeType(file.filename),
    sizeBytes: file.buffer.length,
    createdAt: now.toISOString(),
  };
}

async function saveS3CompatibleObject(config, userId, file, provider) {
  if (!isRemoteStorageConfigured(config)) {
    throw httpError(500, "对象存储尚未配置完整，请检查 bucket、endpoint、access key 和 secret。");
  }
  const now = new Date();
  const key = buildObjectKey(userId, file, now);
  const signedRequest = createS3PutObjectRequest(config, key, file);
  let response;
  try {
    response = await fetch(signedRequest.url, {
      method: "PUT",
      headers: signedRequest.headers,
      body: file.buffer,
    });
  } catch (error) {
    throw httpError(502, `对象存储连接失败：${error.message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw httpError(502, `对象存储上传失败：${response.status} ${text.slice(0, 300)}`.trim());
  }
  return {
    key,
    url: buildObjectUrl(config, key),
    provider,
    originalName: file.filename || "",
    mimeType: file.mimeType || guessMimeType(file.filename),
    sizeBytes: file.buffer.length,
    createdAt: now.toISOString(),
  };
}

async function readUploadFiles(req, body) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    return parseMultipartFiles(await readRawBody(req), contentType);
  }
  const jsonFiles = Array.isArray(body.files) ? body.files : body.file ? [body.file] : [];
  return jsonFiles.map(jsonFileToUpload).filter(Boolean);
}

function parseMultipartFiles(buffer, contentType) {
  const boundary = getMultipartBoundary(contentType);
  if (!boundary) throw httpError(400, "上传请求缺少 multipart boundary。");
  const marker = Buffer.from(`--${boundary}`);
  const files = [];
  let cursor = buffer.indexOf(marker);
  while (cursor >= 0) {
    cursor += marker.length;
    if (buffer.slice(cursor, cursor + 2).toString() === "--") break;
    if (buffer.slice(cursor, cursor + 2).toString() === "\r\n") cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < 0) break;
    const headersText = buffer.slice(cursor, headerEnd).toString("utf8");
    const nextMarker = buffer.indexOf(marker, headerEnd + 4);
    if (nextMarker < 0) break;
    let partBody = buffer.slice(headerEnd + 4, nextMarker);
    if (partBody.slice(-2).toString() === "\r\n") partBody = partBody.slice(0, -2);
    const disposition = parseContentDisposition(headersText);
    if (disposition.filename) {
      files.push({
        filename: disposition.filename,
        mimeType: parseHeader(headersText, "content-type") || guessMimeType(disposition.filename),
        buffer: partBody,
      });
    }
    cursor = nextMarker;
  }
  return files;
}

function jsonFileToUpload(file) {
  if (!file || typeof file !== "object") return null;
  const data = String(file.data || file.base64 || "").trim();
  if (!data) return null;
  const { mimeType, base64 } = parseDataUrl(data, file.mimeType);
  return {
    filename: String(file.name || file.filename || "upload.bin").trim(),
    mimeType,
    buffer: Buffer.from(base64, "base64"),
  };
}

function parseDataUrl(value, fallbackMimeType = "") {
  const match = value.match(/^data:([^;,]+)?;base64,(.*)$/s);
  if (!match) return { mimeType: fallbackMimeType || "application/octet-stream", base64: value };
  return { mimeType: match[1] || fallbackMimeType || "application/octet-stream", base64: match[2] };
}

function getMultipartBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || "").trim();
}

function parseContentDisposition(headersText) {
  const value = parseHeader(headersText, "content-disposition");
  const result = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    if (!key || !rawValue.length) continue;
    result[key] = rawValue.join("=").trim().replace(/^"|"$/g, "");
  }
  return result;
}

function parseHeader(headersText, name) {
  const target = name.toLowerCase();
  for (const line of headersText.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    if (line.slice(0, index).trim().toLowerCase() === target) {
      return line.slice(index + 1).trim();
    }
  }
  return "";
}

function buildObjectUrl(config, key) {
  const publicBaseUrl = String(config.storage?.publicBaseUrl || "").replace(/\/+$/g, "");
  if (publicBaseUrl) return `${publicBaseUrl}/${encodePath(key)}`;
  return `/files/${encodePath(key)}`;
}

function buildObjectKey(userId, file, now = new Date()) {
  const ext = safeExtension(file.filename, file.mimeType);
  const safeUserId = safePathSegment(userId || "user");
  return [
    "uploads",
    safeUserId,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    `${crypto.randomUUID()}${ext}`,
  ].join("/");
}

function resolveLocalObjectPath(config, key) {
  const uploadDir = getLocalUploadDir(config);
  const root = path.resolve(uploadDir);
  const absolute = path.resolve(uploadDir, key);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw httpError(400, "文件路径不合法。");
  return absolute;
}

function getLocalUploadDir(config) {
  return path.resolve(process.cwd(), config.dataDir || "./data", "files");
}

function normalizeProvider(config) {
  return String(config.storage?.provider || "local").trim().toLowerCase() || "local";
}

function isS3CompatibleProvider(provider) {
  return ["s3", "r2", "oss"].includes(provider);
}

function isRemoteStorageConfigured(config) {
  return Boolean(
    config.storage?.bucket &&
      config.storage?.endpoint &&
      config.storage?.accessKeyId &&
      config.storage?.secretAccessKey,
  );
}

function createS3PutObjectRequest(config, key, file) {
  const contentType = file.mimeType || guessMimeType(file.filename);
  return createS3ObjectRequest(config, "PUT", key, {
    payload: file.buffer,
    headers: {
      "content-type": contentType,
    },
  });
}

function createS3ObjectRequest(config, method, key, options = {}) {
  const requestMethod = String(method || "GET").toUpperCase();
  const region = String(config.storage.region || "").trim() || (normalizeProvider(config) === "r2" ? "auto" : "us-east-1");
  const accessKeyId = String(config.storage.accessKeyId || "");
  const secretAccessKey = String(config.storage.secretAccessKey || "");
  const sessionToken = String(config.storage.sessionToken || "");
  const url = buildS3ObjectRequestUrl(config, key);
  const payload = options.payload || "";
  const payloadHash = sha256Hex(payload);
  const amzDate = toAmzDate(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(options.headers || {}),
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${normalizeHeaderValue(headers[name])}\n`)
    .join("");
  const canonicalRequest = [
    requestMethod,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, "s3");
  const signature = hmacHex(signingKey, stringToSign);
  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
  return { url: url.toString(), headers };
}

function buildS3ObjectRequestUrl(config, key) {
  const endpoint = new URL(String(config.storage.endpoint || "").replace(/\/+$/g, ""));
  const bucket = String(config.storage.bucket || "").trim();
  const basePath = endpoint.pathname.replace(/\/+$/g, "");
  const pathSegments = basePath.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const endpointAlreadyIncludesBucket =
    endpoint.hostname === bucket ||
    endpoint.hostname.startsWith(`${bucket}.`) ||
    pathSegments[pathSegments.length - 1] === bucket;
  const keyPath = encodePath(key);
  endpoint.pathname = endpointAlreadyIncludesBucket
    ? joinUrlPath(basePath, keyPath)
    : joinUrlPath(basePath, encodeURIComponent(bucket), keyPath);
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function joinUrlPath(...parts) {
  return `/${parts.map((part) => String(part || "").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function normalizeHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function getSignatureKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function safePathSegment(value) {
  return String(value || "item").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "item";
}

function safeExtension(filename, mimeType) {
  const ext = path.extname(String(filename || "")).toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (ext && ext.length <= 12) return ext;
  const guessed = extensionFromMime(mimeType);
  return guessed ? `.${guessed}` : ".bin";
}

function extensionFromMime(mimeType = "") {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("pdf")) return "pdf";
  if (normalized.includes("markdown")) return "md";
  if (normalized.includes("text")) return "txt";
  return "";
}

function guessMimeType(filename = "") {
  const ext = path.extname(String(filename)).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".opus": "audio/opus",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  };
  return map[ext] || "application/octet-stream";
}

function encodePath(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}
