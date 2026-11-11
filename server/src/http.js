export async function readJsonBody(req) {
  const buffer = await readRawBody(req);
  const text = buffer.toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "请求内容不是有效 JSON。");
  }
}

export async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function httpError(status, message, detail = {}) {
  const error = new Error(message);
  error.status = status;
  error.detail = detail;
  return error;
}

export function notImplemented(scope) {
  return {
    ok: false,
    code: "NOT_IMPLEMENTED",
    message: `${scope} 接口已预留，后续接入数据库和权限后实现。`,
  };
}
