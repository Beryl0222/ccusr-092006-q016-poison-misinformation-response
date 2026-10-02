// 无依赖 JSON API：node:http 直接暴露应用服务用例。
// 运行：npm start（默认 8080 端口，PORT 环境变量可改）。

import { createServer } from "node:http";
import { CdcResponseService } from "./service.js";
import { seedGuidelines } from "./seed.js";

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

// 路由表：[方法, 路径模式（:param 占位）, 处理函数]。
const ROUTES = [
  ["POST", "/submissions", (svc, body) => svc.receiveSubmission(body)],
  ["POST", "/claims", (svc, body) => svc.registerClaim(body)],
  ["GET", "/claims/:claimId", (svc, _body, p) => svc.claimDetail(p.claimId)],
  ["POST", "/claims/:claimId/reviews", (svc, body, p) => svc.addClaimReview(p.claimId, body)],
  ["POST", "/claims/:claimId/corrections", (svc, body, p) => svc.addClaimCorrection(p.claimId, body)],
  ["GET", "/claims/:claimId/impact", (svc, _body, p) => svc.claimImpact(p.claimId)],
  ["POST", "/guidelines", (svc, body) => svc.publishGuideline(body)],
  ["GET", "/guidelines/current", (svc) => svc.currentGuideline()],
  ["GET", "/reevaluation-queue", (svc) => svc.reevaluationQueue()],
  ["POST", "/reevaluation-queue/:taskId/process", (svc, _body, p) => svc.processReevaluation(p.taskId)],
  ["GET", "/incidents/:incidentId", (svc, _body, p) => svc.incidentDetail(p.incidentId)],
  ["GET", "/incidents/:incidentId/trace", (svc, _body, p) => svc.incidentTrace(p.incidentId)],
  ["POST", "/incidents/:incidentId/close", (svc, body, p) => svc.closeIncident(p.incidentId, body)],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    const matched = patternParts.every((part, i) => {
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(pathParts[i]);
        return true;
      }
      return part === pathParts[i];
    });
    if (matched) return { handler, params };
  }
  return null;
}

export function createApp(service = new CdcResponseService()) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = matchRoute(req.method, url.pathname);
    if (!route) return send(res, 404, { ok: false, problems: ["路由不存在"] });

    let body = {};
    if (req.method === "POST") {
      body = await readJson(req);
      if (body === null) return send(res, 400, { ok: false, problems: ["请求体不是合法 JSON"] });
    }
    try {
      const result = route.handler(service, body, route.params);
      const { ok, status, ...rest } = result;
      return send(res, status, { ok, ...rest });
    } catch (error) {
      return send(res, 500, { ok: false, problems: [`内部错误: ${error.message}`] });
    }
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const service = new CdcResponseService();
  seedGuidelines(service);
  const port = Number(process.env.PORT ?? 8080);
  createApp(service).listen(port, () => {
    console.log(`中毒误导信息响应后端已启动: http://localhost:${port}`);
  });
}
