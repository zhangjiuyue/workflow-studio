import { readJsonBody, sendJson, httpError } from "./http.js";

export class Router {
  constructor() {
    this.routes = [];
  }

  get(path, handler) {
    this.routes.push({ method: "GET", path, handler });
  }

  post(path, handler) {
    this.routes.push({ method: "POST", path, handler });
  }

  put(path, handler) {
    this.routes.push({ method: "PUT", path, handler });
  }

  delete(path, handler) {
    this.routes.push({ method: "DELETE", path, handler });
  }

  async handle(req, res, context) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const match = this.match(req.method, url.pathname);
    if (!match) {
      throw httpError(404, "接口不存在。");
    }
    const body = shouldReadJsonBody(req) ? await readJsonBody(req) : {};
    return match.route.handler({
      req,
      res,
      url,
      body,
      params: match.params,
      context,
    });
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, pathname);
      if (params) return { route, params };
    }
    return null;
  }
}

function shouldReadJsonBody(req) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return false;
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.startsWith("multipart/form-data")) return false;
  if (contentType.startsWith("application/octet-stream")) return false;
  return true;
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (patternPart !== pathPart) return null;
  }
  return params;
}

export function ok(data = {}) {
  return { ok: true, ...data };
}

export function reply(res, payload, status = 200) {
  sendJson(res, status, payload);
}
