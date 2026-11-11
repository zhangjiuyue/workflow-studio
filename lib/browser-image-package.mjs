import { imageFileTypeFromBytes } from "./image-file-signature.mjs";

const MAX_FILES = 500;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export async function createBrowserImagePackage(input = {}, options = {}) {
  const files = normalizeFiles(input.files);
  const folder = safeFileName(input.folder || input.name || "workflow-images");
  const sheet = normalizeSheet(input.sheet);
  const rows = [sheet.headers || ["镜头序号", "图片文件", "图片提示词"]];
  const entries = [];
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前浏览器不支持下载外部图片。");

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const image = await readBrowserImage(file, fetchImpl, options.signal);
    const shotLabel = file.label || `镜头 ${String(index + 1).padStart(2, "0")}`;
    const imageName = safeZipPath(file.name || `images/scene_${String(index + 1).padStart(2, "0")}.${image.extension}`);
    entries.push([`${folder}/${imageName}`, image.bytes]);
    if (!sheet.rows) rows.push([shotLabel, imageName, file.prompt || ""]);
    options.onProgress?.({
      done: index + 1,
      total: files.length,
      progress: Math.max(5, Math.min(92, Math.round(((index + 1) / files.length) * 92))),
      detail: `浏览器已读取 ${index + 1}/${files.length} 张图片`,
    });
  }

  if (sheet.rows) rows.push(...sheet.rows);
  options.onProgress?.({
    done: files.length,
    total: files.length,
    progress: 96,
    detail: "正在浏览器中生成压缩包",
  });
  entries.push([
    `${folder}/${safeFileName(sheet.name || "分镜图片清单")}.xlsx`,
    excelWorkbookFromRows(rows, sheet.name || "分镜图片清单"),
  ]);
  return {
    blob: storedZipBlob(entries),
    fileName: `${safeFileName(input.fileName || `${folder}-分镜图片`)}.zip`,
    count: files.length,
  };
}

async function readBrowserImage(file, fetchImpl, signal) {
  let bytes;
  if (file.url.startsWith("data:image/")) {
    bytes = bytesFromDataUrl(file.url);
  } else {
    let response;
    try {
      response = await fetchImpl(file.url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error(`浏览器无法读取「${file.label || file.name || "图片"}」，外部图片可能不允许跨域下载或网络连接失败。`);
    }
    if (!response?.ok) {
      throw new Error(`浏览器读取「${file.label || file.name || "图片"}」失败：HTTP ${response?.status || 0}`);
    }
    const declaredSize = Number(response.headers?.get?.("content-length") || 0);
    if (declaredSize > MAX_IMAGE_BYTES) throw new Error(`「${file.label || file.name || "图片"}」超过 30MB。`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (!bytes.length) throw new Error(`「${file.label || file.name || "图片"}」内容为空。`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`「${file.label || file.name || "图片"}」超过 30MB。`);
  const type = imageFileTypeFromBytes(bytes);
  if (!type) throw new Error(`「${file.label || file.name || "图片"}」返回的内容不是支持的 PNG、JPEG、WebP 或 GIF 图片。`);
  return { bytes, ...type };
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new Error("没有可打包的图片。");
  if (files.length > MAX_FILES) throw new Error(`浏览器单次最多打包 ${MAX_FILES} 张图片。`);
  return files.map((file, index) => {
    const url = String(file?.url || "").trim();
    if (!url) throw new Error(`第 ${index + 1} 张图片地址为空。`);
    if (!url.startsWith("data:image/") && !/^https?:\/\//i.test(url)) {
      throw new Error(`第 ${index + 1} 张图片不是可公开读取的地址。`);
    }
    return {
      url,
      name: String(file?.name || "").trim(),
      label: String(file?.label || "").trim(),
      prompt: String(file?.prompt || ""),
    };
  });
}

function normalizeSheet(sheet) {
  if (!sheet || typeof sheet !== "object") return {};
  return {
    name: safeFileName(sheet.name || "分镜图片清单"),
    headers: Array.isArray(sheet.headers) && sheet.headers.length ? sheet.headers.map(stringCell) : null,
    rows: Array.isArray(sheet.rows) && sheet.rows.length
      ? sheet.rows.map((row) => Array.isArray(row) ? row.map(stringCell) : [stringCell(row)])
      : null,
  };
}

function excelWorkbookFromRows(rows, sheetName = "Sheet1") {
  const now = new Date().toISOString();
  return storedZipBytes([
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
  <dc:creator>Workflow Studio</dc:creator><cp:lastModifiedBy>Workflow Studio</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`],
    ["docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Workflow Studio</Application></Properties>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXmlAttr(excelSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF999999"/></left><right style="thin"><color rgb="FF999999"/></right><top style="thin"><color rgb="FF999999"/></top><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
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
      return `<c r="${ref}" t="inlineStr" s="${rowIndex === 0 ? 1 : 0}"><is><t xml:space="preserve">${escapeXmlText(cell)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}" ht="${rowIndex === 0 ? 28 : 90}" customHeight="1">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rowXml}</sheetData></worksheet>`;
}

function storedZipBlob(entries) {
  return new Blob(storedZipParts(entries), { type: "application/zip" });
}

function storedZipBytes(entries) {
  const parts = storedZipParts(entries);
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function storedZipParts(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const data = toBytes(content);
    const crc = crc32(data);
    const localHeader = zipHeader([0x04034b50, 20, 0x0800, 0, 0, 0, crc, data.length, data.length, nameBytes.length, 0], [4, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2]);
    localParts.push(localHeader, nameBytes, data);
    const centralHeader = zipHeader([0x02014b50, 20, 20, 0x0800, 0, 0, 0, crc, data.length, data.length, nameBytes.length, 0, 0, 0, 0, 0, offset], [4, 2, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2, 2, 2, 2, 4, 4]);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const count = entries.length;
  const endHeader = zipHeader([0x06054b50, 0, 0, count, count, centralSize, offset, 0], [4, 2, 2, 2, 2, 4, 4, 2]);
  return [...localParts, ...centralParts, endHeader];
}

function zipHeader(values, sizes) {
  const bytes = new Uint8Array(sizes.reduce((sum, size) => sum + size, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  values.forEach((value, index) => {
    const size = sizes[index];
    if (size === 2) view.setUint16(offset, value, true);
    if (size === 4) view.setUint32(offset, value >>> 0, true);
    offset += size;
  });
  return bytes;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function bytesFromDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:image\/[^;,]+;base64,(.+)$/i);
  if (!match) throw new Error("图片 data URL 格式不正确。");
  const binary = globalThis.atob(match[1].replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new TextEncoder().encode(String(content ?? ""));
}

function stringCell(value) {
  return String(value ?? "");
}

function safeFileName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").replace(/\.zip$/i, "").slice(0, 80) || "file";
}

function safeZipPath(name) {
  return String(name || "file").split("/").map(safeFileName).filter(Boolean).join("/") || "file";
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
  return String(value || "Sheet1").replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet1";
}

function escapeXmlText(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(value) {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}
