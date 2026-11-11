import { mediaHttp } from '../security/public-http.js';
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import * as fontkit from "fontkit";
import sharp from "sharp";
import { httpError } from "../http.js";
import { saveGeneratedImageObject } from "../storage/object-storage.js";
import { imageFileTypeFromBytes } from "../lib/image-file-signature.mjs";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_PACKAGE_FILES = 500;
const MAX_FILE_BYTES = 120 * 1024 * 1024;
const MAX_ZIP_BYTES = 3800 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 60000;
const FILE_FETCH_TIMEOUT_MS = 120000;
const require = createRequire(import.meta.url);
const notoSansScRoot = path.dirname(require.resolve("@fontsource-variable/noto-sans-sc/package.json"));
let notoSansScUnicodeCache = null;
const notoSansScFontCache = new Map();

export async function createImageZipPackage(input = {}) {
  const files = normalizePackageFiles(input.files);
  const folder = safeFileName(input.folder || input.name || "workflow-images");
  const sheet = normalizePackageSheet(input.sheet);
  const rows = [sheet.headers || ["镜头序号", "图片文件", "图片提示词"]];
  const zipPath = await createTempZipPath();
  const zipStream = createWriteStream(zipPath);
  zipStream.on("error", () => {});
  const centralParts = [];
  let offset = 0;

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const image = await readImageSource(file.url);
      const shotLabel = file.label || `镜头 ${String(index + 1).padStart(2, "0")}`;
      const imageName = safeZipPath(file.name || `images/scene_${String(index + 1).padStart(2, "0")}.${image.extension}`);
      offset = await appendZipFile(zipStream, centralParts, offset, `${folder}/${imageName}`, image.buffer);
      if (!sheet.rows) rows.push([shotLabel, imageName, file.prompt || ""]);
      input.onProgress?.(index + 1, files.length);
    }

    if (sheet.rows) rows.push(...sheet.rows);
    offset = await appendZipFile(
      zipStream,
      centralParts,
      offset,
      `${folder}/${sheet.name || "分镜图片清单"}.xlsx`,
      excelWorkbookFromRows(rows, sheet.name || "分镜图片清单"),
    );
    await writeZipFooter(zipStream, centralParts, offset);
    await closeWriteStream(zipStream);
    const zipStats = await stat(zipPath);

    return {
      fileName: `${safeFileName(input.fileName || `${folder}-分镜图片`)}.zip`,
      filePath: zipPath,
      size: zipStats.size,
      cleanup: () => unlink(zipPath).catch(() => {}),
    };
  } catch (error) {
    zipStream.destroy();
    await unlink(zipPath).catch(() => {});
    throw error;
  }
}

export async function createImageDownload(input = {}) {
  const url = String(input.url || "").trim();
  if (!url) throw httpError(400, "图片地址为空。");
  const image = await readImageSource(url);
  const baseName = safeFileName(input.fileName || input.name || "generated-image");
  const nameWithoutExtension = baseName.replace(/\.[a-z0-9]+$/i, "") || "generated-image";
  return {
    buffer: image.buffer,
    mimeType: image.mimeType || imageMimeFromExtension(image.extension) || "image/png",
    fileName: `${nameWithoutExtension}.${image.extension || "png"}`,
  };
}

export async function createImageWatermark(input = {}, user = {}, config = {}) {
  const url = String(input.url || "").trim();
  const text = normalizeWatermarkText(input.text || input.name || input.label);
  if (!url) throw httpError(400, "图片地址为空。");
  if (!text) throw httpError(400, "水印文字不能为空。");
  if (!user?.id) throw httpError(401, "请先登录。");

  const source = await readImageSource(url);
  const normalized = await sharp(source.buffer, { animated: false })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const width = Number(normalized.info?.width || 0);
  const height = Number(normalized.info?.height || 0);
  if (!width || !height) throw httpError(400, "图片尺寸解析失败。");

  const watermarkSvg = await createNameWatermarkSvg({ width, height, text });
  const buffer = await sharp(normalized.data)
    .composite([{ input: Buffer.from(watermarkSvg), left: 0, top: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const baseName = safeImageBaseName(input.fileName || input.name || text || "role-name");
  const saved = await saveGeneratedImageObject(config, user.id, {
    buffer,
    filename: `${baseName}-name.png`,
    mimeType: "image/png",
  });

  return {
    url: saved.url,
    fileUrl: saved.url,
    imageUrl: saved.url,
    key: saved.key,
    thumbnailUrl: saved.thumbnailUrl || "",
    imageThumbnailUrl: saved.thumbnailUrl || "",
    mimeType: saved.mimeType || "image/png",
    sizeBytes: saved.sizeBytes || buffer.length,
    text,
  };
}

export async function createFileDownload(input = {}) {
  const url = String(input.url || "").trim();
  if (!url) throw httpError(400, "文件地址为空。");
  const file = await readFileSource(url);
  const baseName = safeFileName(input.fileName || input.name || "download");
  const nameWithoutExtension = baseName.replace(/\.[a-z0-9]+$/i, "") || "download";
  return {
    buffer: file.buffer,
    mimeType: file.mimeType || "application/octet-stream",
    fileName: `${nameWithoutExtension}.${file.extension || "bin"}`,
  };
}

export async function createFileZipPackage(input = {}) {
  const files = normalizeFilePackageFiles(input.files);
  const folder = safeFileName(input.folder || input.name || "flowstudio-files");
  const zipPath = await createTempZipPath();
  const zipStream = createWriteStream(zipPath);
  zipStream.on("error", () => {});
  const centralParts = [];
  let offset = 0;

  try {
    for (let index = 0; index < files.length; index += 1) {
      const item = files[index];
      const file = await readFileSource(item.url);
      const fileName = safeZipPath(item.name || `files/file_${String(index + 1).padStart(2, "0")}.${file.extension || "bin"}`);
      offset = await appendZipFile(zipStream, centralParts, offset, `${folder}/${fileName}`, file.buffer);
      input.onProgress?.(index + 1, files.length);
    }

    const manifestRows = [
      ["序号", "文件", "说明"],
      ...files.map((file, index) => [
        String(index + 1).padStart(2, "0"),
        file.name || "",
        file.label || "",
      ]),
    ];
    offset = await appendZipFile(
      zipStream,
      centralParts,
      offset,
      `${folder}/${safeFileName(input.manifestName || "文件清单")}.xlsx`,
      excelWorkbookFromRows(manifestRows, input.manifestName || "文件清单"),
    );
    await writeZipFooter(zipStream, centralParts, offset);
    await closeWriteStream(zipStream);
    const zipStats = await stat(zipPath);

    return {
      fileName: `${safeFileName(input.fileName || `${folder}-files`)}.zip`,
      filePath: zipPath,
      size: zipStats.size,
      cleanup: () => unlink(zipPath).catch(() => {}),
    };
  } catch (error) {
    zipStream.destroy();
    await unlink(zipPath).catch(() => {});
    throw error;
  }
}

function normalizePackageFiles(files) {
  if (!Array.isArray(files) || !files.length) throw httpError(400, "请先选择要打包的图片。");
  return files.map((file, index) => {
    const url = String(file?.url || "").trim();
    if (!url) throw httpError(400, `第 ${index + 1} 张图片地址为空。`);
    return {
      url,
      name: String(file?.name || "").trim(),
      label: String(file?.label || "").trim(),
      prompt: String(file?.prompt || ""),
    };
  });
}

function normalizeFilePackageFiles(files) {
  if (!Array.isArray(files) || !files.length) throw httpError(400, "请先选择要打包的文件。");
  if (files.length > MAX_PACKAGE_FILES) throw httpError(400, `单次最多打包 ${MAX_PACKAGE_FILES} 个文件。`);
  return files.map((file, index) => {
    const url = String(file?.url || "").trim();
    if (!url) throw httpError(400, `第 ${index + 1} 个文件地址为空。`);
    return {
      url,
      name: String(file?.name || "").trim(),
      label: String(file?.label || "").trim(),
    };
  });
}

function normalizePackageSheet(sheet) {
  if (!sheet || typeof sheet !== "object") return {};
  const headers = Array.isArray(sheet.headers) && sheet.headers.length
    ? sheet.headers.map((cell) => String(cell ?? ""))
    : null;
  const rows = Array.isArray(sheet.rows) && sheet.rows.length
    ? sheet.rows.map((row) => Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [String(row ?? "")])
    : null;
  return {
    name: safeFileName(sheet.name || "分镜图片清单"),
    headers,
    rows,
  };
}

async function readImageSource(url) {
  if (url.startsWith("data:image/")) return dataUrlToImage(url);
  if (!url.startsWith("/files/") && !/^https?:\/\//i.test(url)) throw httpError(400, "图片地址必须是 http、https 或 data:image。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await mediaHttp.fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Workflow Studio Image Packager" },
      maxBytes: MAX_IMAGE_BYTES, timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    throw httpError(502, `图片读取失败：${error.name === "AbortError" ? "请求超时" : error.message || "网络连接失败"}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw httpError(response.status === 404 ? 404 : 502, `图片读取失败：${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw httpError(400, "图片文件为空。");
  if (buffer.length > MAX_IMAGE_BYTES) throw httpError(413, "单张图片不能超过 30MB。");
  const detectedType = imageFileTypeFromBytes(buffer);
  if (!detectedType && !/^image\//i.test(contentType)) throw httpError(400, "图片地址返回的不是图片文件。");
  return {
    buffer,
    extension: detectedType?.extension || imageExtensionFromMime(contentType) || imageExtensionFromUrl(url) || "png",
    mimeType: detectedType?.mimeType || contentType.split(";")[0] || imageMimeFromExtension(imageExtensionFromUrl(url)) || "image/png",
  };
}

function dataUrlToImage(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[^;,]+);base64,(.+)$/i);
  if (!match) throw httpError(400, "图片 data URL 格式不正确。");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw httpError(400, "图片文件为空。");
  if (buffer.length > MAX_IMAGE_BYTES) throw httpError(413, "单张图片不能超过 30MB。");
  return {
    buffer,
    extension: imageExtensionFromMime(match[1]) || "png",
    mimeType: match[1],
  };
}

function normalizeWatermarkText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

async function createNameWatermarkSvg({ width, height, text }) {
  const outline = await createWatermarkTextOutline(text);
  const edge = Math.min(width, height);
  const margin = clamp(Math.round(edge * 0.04), 18, 56);
  const paddingX = clamp(Math.round(edge * 0.022), 14, 34);
  const paddingY = clamp(Math.round(edge * 0.014), 9, 22);
  const maxLabelWidth = Math.max(80, width - margin * 2);
  let fontSize = clamp(Math.round(edge * 0.07), 22, 72);
  const maxTextWidth = Math.max(40, maxLabelWidth - paddingX * 2);
  const outlineWidthUnits = Math.max(outline.widthUnits, 1);
  if ((outlineWidthUnits * fontSize) / outline.unitsPerEm > maxTextWidth) {
    fontSize = clamp(Math.floor((maxTextWidth * outline.unitsPerEm) / outlineWidthUnits), 16, fontSize);
  }
  const scale = fontSize / outline.unitsPerEm;
  const textWidth = Math.ceil(outlineWidthUnits * scale);
  const textHeight = Math.ceil((outline.maxY - outline.minY) * scale);
  const labelWidth = Math.min(maxLabelWidth, textWidth + paddingX * 2);
  const labelHeight = Math.ceil(Math.max(fontSize, textHeight) + paddingY * 2);
  const x = margin;
  const y = Math.max(margin, height - margin - labelHeight);
  const radius = clamp(Math.round(labelHeight * 0.28), 8, 18);
  const textX = x + paddingX;
  const baselineY = y + labelHeight / 2 + ((outline.maxY + outline.minY) / 2) * scale;
  const strokeWidth = clamp(Math.round(outline.unitsPerEm * 0.036), 18, 44);
  const paths = outline.paths
    .map((item) => `<path transform="translate(${roundSvgNumber(item.x)} 0)" d="${item.d}"/>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="${x}" y="${y}" width="${labelWidth}" height="${labelHeight}" rx="${radius}" fill="#ffffff" opacity="0.64"/>
  <g transform="translate(${roundSvgNumber(textX)} ${roundSvgNumber(baselineY)}) scale(${roundSvgNumber(scale)} ${roundSvgNumber(-scale)})" fill="#050505" stroke="#050505" stroke-width="${strokeWidth}" stroke-linejoin="round">
    ${paths}
  </g>
</svg>`;
}

async function createWatermarkTextOutline(text = "") {
  const unicode = await loadNotoSansScUnicode();
  const paths = [];
  let cursorX = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let unitsPerEm = 1000;

  for (const char of Array.from(String(text || ""))) {
    if (/\s/.test(char)) {
      cursorX += unitsPerEm * 0.5;
      continue;
    }
    const subset = fontSubsetForCodePoint(char.codePointAt(0), unicode);
    const font = await loadNotoSansScFont(subset);
    if (!font) continue;
    unitsPerEm = font.unitsPerEm || unitsPerEm;
    const glyph = font.glyphForCodePoint(char.codePointAt(0));
    const d = glyph?.path?.toSVG?.() || "";
    const advanceWidth = Number(glyph?.advanceWidth || unitsPerEm);
    if (d) {
      paths.push({ x: cursorX, d });
      const bbox = glyph.bbox || {};
      minY = Math.min(minY, Number.isFinite(bbox.minY) ? bbox.minY : 0);
      maxY = Math.max(maxY, Number.isFinite(bbox.maxY) ? bbox.maxY : unitsPerEm);
    }
    cursorX += advanceWidth;
  }

  if (!paths.length) throw httpError(500, "水印文字字体解析失败。");

  return {
    paths,
    widthUnits: cursorX || unitsPerEm,
    minY: Number.isFinite(minY) ? minY : 0,
    maxY: Number.isFinite(maxY) ? maxY : unitsPerEm,
    unitsPerEm,
  };
}

async function loadNotoSansScUnicode() {
  if (notoSansScUnicodeCache) return notoSansScUnicodeCache;
  const raw = await readFile(path.join(notoSansScRoot, "unicode.json"), "utf8");
  const unicode = JSON.parse(raw);
  notoSansScUnicodeCache = {
    raw: unicode,
    entries: Object.entries(unicode).map(([key, ranges]) => ({
      subset: key.replace(/[[\]]/g, ""),
      ranges: String(ranges || "").split(",").map(parseUnicodeRange).filter(Boolean),
    })),
  };
  return notoSansScUnicodeCache;
}

function fontSubsetForCodePoint(codePoint, unicode = {}) {
  const match = unicode.entries?.find((entry) => entry.ranges.some(([start, end]) => codePoint >= start && codePoint <= end));
  return match?.subset || "";
}

function parseUnicodeRange(value = "") {
  const match = String(value).trim().match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/);
  if (!match) return null;
  const start = Number.parseInt(match[1], 16);
  const end = Number.parseInt(match[2] || match[1], 16);
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
}

async function loadNotoSansScFont(subset) {
  if (!subset) return null;
  if (notoSansScFontCache.has(subset)) return notoSansScFontCache.get(subset);
  const filePath = path.join(notoSansScRoot, "files", `noto-sans-sc-${subset}-wght-normal.woff2`);
  const font = await readFile(filePath).then((buffer) => fontkit.create(buffer)).catch(() => null);
  notoSansScFontCache.set(subset, font);
  return font;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundSvgNumber(value) {
  return Number(value || 0).toFixed(3).replace(/\.?0+$/g, "");
}

async function readFileSource(url) {
  if (url.startsWith("data:")) return dataUrlToFile(url);
  if (!url.startsWith("/files/") && !/^https?:\/\//i.test(url)) throw httpError(400, "文件地址必须是 http、https 或 data URL。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await mediaHttp.fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Workflow Studio File Packager" },
      maxBytes: MAX_FILE_BYTES, timeoutMs: FILE_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    throw httpError(502, `文件读取失败：${error.name === "AbortError" ? "请求超时" : error.message || "网络连接失败"}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw httpError(response.status === 404 ? 404 : 502, `文件读取失败：${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw httpError(400, "文件为空。");
  if (buffer.length > MAX_FILE_BYTES) throw httpError(413, "单个文件不能超过 120MB。");
  return {
    buffer,
    extension: fileExtensionFromMime(contentType) || fileExtensionFromUrl(url) || "bin",
    mimeType: contentType.split(";")[0] || fileMimeFromExtension(fileExtensionFromUrl(url)) || "application/octet-stream",
  };
}

function dataUrlToFile(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) throw httpError(400, "文件 data URL 格式不正确。");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw httpError(400, "文件为空。");
  if (buffer.length > MAX_FILE_BYTES) throw httpError(413, "单个文件不能超过 120MB。");
  return {
    buffer,
    extension: fileExtensionFromMime(match[1]) || "bin",
    mimeType: match[1],
  };
}

function excelWorkbookFromRows(rows, sheetName = "Sheet1") {
  return createZipBuffer([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`],
    ["docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Workflow Studio</dc:creator>
  <cp:lastModifiedBy>Workflow Studio</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`],
    ["docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Workflow Studio</Application>
</Properties>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${escapeXmlAttr(excelSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF999999"/></left><right style="thin"><color rgb="FF999999"/></right><top style="thin"><color rgb="FF999999"/></top><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`],
    ["xl/worksheets/sheet1.xml", excelWorksheetXmlFromRows(rows)],
  ]);
}

function excelWorksheetXmlFromRows(rows) {
  const maxCols = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 1), 0);
  const cols = Array.from({ length: maxCols }, (_, index) => {
    const width = index === 0 ? 70 : index === 1 ? 12 : index === 2 ? 36 : index >= 5 ? 14 : 18;
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const rowXml = rows.map((row, rowIndex) => {
    const cells = (Array.isArray(row) ? row : [row]).map((cell, colIndex) => {
      const ref = `${excelColumnName(colIndex + 1)}${rowIndex + 1}`;
      const style = rowIndex === 0 ? 1 : 0;
      return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${escapeXmlText(String(cell ?? ""))}</t></is></c>`;
    }).join("");
    const height = rowIndex === 0 ? 28 : 90;
    return `<row r="${rowIndex + 1}" ht="${height}" customHeight="1">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function excelColumnName(index) {
  let value = Number(index) || 1;
  let name = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function excelSheetName(value = "Sheet1") {
  const name = String(value || "Sheet1").replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31);
  return name || "Sheet1";
}

function createZipBuffer(entries) {
  const parts = [];
  const centralParts = [];
  let offset = 0;
  entries.forEach(([name, content]) => {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const crc = crc32(data);
    const localHeader = zipHeader([
      0x04034b50, 20, 0x0800, 0, 0, 0, crc, data.length, data.length, nameBytes.length, 0,
    ], [4, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2]);
    parts.push(localHeader, nameBytes, data);
    const centralHeader = zipHeader([
      0x02014b50, 20, 20, 0x0800, 0, 0, 0, crc, data.length, data.length, nameBytes.length, 0, 0, 0, 0, 0, offset,
    ], [4, 2, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2, 2, 2, 2, 4, 4]);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  });
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = zipHeader([
    0x06054b50, 0, 0, centralParts.length / 2, centralParts.length / 2, centralSize, offset, 0,
  ], [4, 2, 2, 2, 2, 4, 4, 2]);
  return Buffer.concat([...parts, ...centralParts, endHeader]);
}

function escapeXmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(value) {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

async function createTempZipPath() {
  const directory = path.join(tmpdir(), "flowstudio-image-packages");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `${randomUUID()}.zip`);
}

async function appendZipFile(stream, centralParts, offset, name, fileData) {
  const nameBytes = Buffer.from(name, "utf8");
  const data = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData);
  const crc = crc32(data);
  const localHeader = zipHeader([
    0x04034b50, 20, 0x0800, 0, 0, 0, crc, data.length, data.length, nameBytes.length, 0,
  ], [4, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2]);
  const nextOffset = offset + localHeader.length + nameBytes.length + data.length;
  assertZipSize(nextOffset);
  await writeStreamPart(stream, localHeader);
  await writeStreamPart(stream, nameBytes);
  await writeStreamPart(stream, data);

  const centralHeader = zipHeader([
    0x02014b50, 20, 20, 0x0800, 0, 0, 0, crc, data.length, data.length, nameBytes.length, 0, 0, 0, 0, 0, offset,
  ], [4, 2, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2, 2, 2, 2, 4, 4]);
  centralParts.push(centralHeader, nameBytes);
  return nextOffset;
}

async function writeZipFooter(stream, centralParts, offset) {
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  assertZipSize(offset + centralSize + 22);
  const endHeader = zipHeader([
    0x06054b50, 0, 0, centralParts.length / 2, centralParts.length / 2, centralSize, offset, 0,
  ], [4, 2, 2, 2, 2, 4, 4, 2]);
  for (const part of centralParts) await writeStreamPart(stream, part);
  await writeStreamPart(stream, endHeader);
}

async function writeStreamPart(stream, part) {
  await new Promise((resolve, reject) => {
    stream.write(part, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeWriteStream(stream) {
  stream.end();
  await Promise.race([
    once(stream, "finish"),
    once(stream, "error").then(([error]) => { throw error; }),
  ]);
}

function assertZipSize(size) {
  if (size <= MAX_ZIP_BYTES) return;
  throw httpError(413, "图片压缩包超过 ZIP 单文件安全上限，请减少单次下载图片或分批下载。");
}

function zipHeader(values, sizes) {
  const buffer = Buffer.alloc(sizes.reduce((sum, size) => sum + size, 0));
  let offset = 0;
  values.forEach((value, index) => {
    const size = sizes[index];
    if (size === 2) buffer.writeUInt16LE(value, offset);
    if (size === 4) buffer.writeUInt32LE(value >>> 0, offset);
    offset += size;
  });
  return buffer;
}

function crc32(bytes) {
  if (!crc32.table) {
    crc32.table = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  }
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ crc32.table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function imageExtensionFromMime(mime = "") {
  const normalized = String(mime).split(";")[0].trim().toLowerCase();
  return {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  }[normalized] || "";
}

function imageExtensionFromUrl(url = "") {
  const pathname = String(url).split("?")[0].split("#")[0];
  const extension = pathname.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (!["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) return "";
  return extension === "jpeg" ? "jpg" : extension;
}

function imageMimeFromExtension(extension = "") {
  const normalized = String(extension).toLowerCase().replace(/^\./, "");
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  }[normalized] || "";
}

function fileExtensionFromMime(mime = "") {
  const normalized = String(mime).split(";")[0].trim().toLowerCase();
  return {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/opus": "opus",
    "audio/ogg": "ogg",
    "video/mp4": "mp4",
    "application/zip": "zip",
    "text/plain": "txt",
  }[normalized] || imageExtensionFromMime(normalized);
}

function fileExtensionFromUrl(url = "") {
  const pathname = String(url).split("?")[0].split("#")[0];
  const extension = pathname.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (!extension || extension.length > 12) return "";
  return extension === "jpeg" ? "jpg" : extension;
}

function fileMimeFromExtension(extension = "") {
  const normalized = String(extension).toLowerCase().replace(/^\./, "");
  return {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    opus: "audio/opus",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    zip: "application/zip",
    txt: "text/plain; charset=utf-8",
    ...{
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    },
  }[normalized] || "";
}

function safeFileName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").replace(/\.zip$/i, "").slice(0, 80) || "file";
}

function safeImageBaseName(name) {
  return safeFileName(name).replace(/\.(?:jpe?g|png|webp|gif|avif)$/i, "").replace(/-+$/g, "") || "role-name";
}

function safeZipPath(name) {
  return String(name || "file").split("/").map(safeFileName).filter(Boolean).join("/") || "file";
}
