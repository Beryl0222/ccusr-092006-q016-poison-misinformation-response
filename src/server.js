// HTTP API：零依赖 node:http JSON 服务。
// 错误统一为 { error: { code, message, details } }；领域冲突返回 409。

import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createService, ServiceError } from "./service.js";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
}

export function createServer(service = createService()) {
  const routes = [
    // 公众提交（重复来电自动合并进同一事件）
    ["POST", /^\/reports$/, async (req) => [201, service.createReport(await readBody(req))]],
    ["GET", /^\/reports\/(?<id>[^/]+)$/, async (_req, m) => [200, service.getReport(m.groups.id)]],
    // 暴露事件
    ["GET", /^\/incidents$/, async (_req, _m, q) => [200, service.listIncidents({ status: q.get("status") ?? undefined })]],
    ["GET", /^\/incidents\/(?<id>[^/]+)$/, async (_req, m) => [200, service.getIncidentView(m.groups.id)]],
    ["POST", /^\/incidents\/(?<id>[^/]+)\/assess$/, async (req, m) => [201, service.assessIncident(m.groups.id, await readBody(req))]],
    ["POST", /^\/incidents\/(?<id>[^/]+)\/close$/, async (req, m) => [200, service.closeIncident(m.groups.id, await readBody(req))]],
    ["GET", /^\/incidents\/(?<id>[^/]+)\/trace$/, async (_req, m) => [200, service.traceIncident(m.groups.id)]],
    // 公众说法与专家判断
    ["GET", /^\/claims$/, async (_req, _m, q) => [200, service.listClaims({ status: q.get("status") ?? undefined })]],
    ["GET", /^\/claims\/(?<id>[^/]+)$/, async (_req, m) => [200, service.getClaimView(m.groups.id)]],
    ["POST", /^\/claims\/(?<id>[^/]+)\/verdicts$/, async (req, m) => [201, service.addVerdict(m.groups.id, await readBody(req))]],
    // 指引版本与重评队列
    ["GET", /^\/guidelines$/, async () => [200, service.listGuidelines()]],
    ["POST", /^\/guidelines$/, async (req) => [201, service.publishGuideline(await readBody(req))]],
    ["GET", /^\/reevaluation-tasks$/, async (_req, _m, q) => [200, service.listReevaluationTasks({ status: q.get("status") ?? undefined })]],
    ["POST", /^\/reevaluation-tasks\/(?<id>[^/]+)\/complete$/, async (req, m) => [200, service.completeReevaluation(m.groups.id, await readBody(req))]],
    // 平台/社区更正回传
    ["POST", /^\/corrections$/, async (req) => [201, service.addCorrection(await readBody(req))]],
    // 事件日志（审计）
    ["GET", /^\/events$/, async (_req, _m, q) => [200, service.listEvents({ kind: q.get("kind") ?? undefined, subject_id: q.get("subject_id") ?? undefined })]],
  ];

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        const [status, body] = await handler(req, match, url.searchParams);
        return send(res, status, body);
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (err) {
      if (err instanceof ServiceError) {
        send(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      } else {
        send(res, 500, { error: { code: "INTERNAL", message: "服务内部错误" } });
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  createServer().listen(port, () => {
    console.log(`误导信息与暴露响应后端已启动: http://localhost:${port}`);
  });
}
