import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.js";
import { createService } from "../src/service.js";

// 固定时钟，保证结案闸门行为与运行时刻无关。
async function withServer(fn) {
  const service = createService({ now: () => new Date("2026-10-01T22:00:00+08:00") });
  const server = createServer(service);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

test("HTTP 端到端：提交 → 评估 → 结案闸门 → 专家判断 → 更正 → 合并升级 → 溯源", async () => {
  await withServer(async (base) => {
    // 缺 channel → 400
    let res = await post(base, "/reports", {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_FAILED");

    // 公众提交：六类要素分开保存
    res = await post(base, "/reports", {
      channel: "hotline",
      reporter: { contact: "135****6666" },
      meal: { meal_at: "2026-10-01T18:00:00+08:00", location: "某餐馆" },
      claims: [
        {
          text: "AI识别说可食",
          category: "IDENTIFICATION_PROMISE",
          source_links: [{ url: "https://app.example/ai1", platform: "识别小程序" }],
        },
      ],
      sample_clues: [{ description: "白色菌盖，有菌环", photo_ref: "photo-9", kept: true }],
      co_diners: [{ person_ref: "aunt-1", relation: "同餐" }],
      symptoms: [{ symptom: "VOMITING", observed_at: "2026-10-01T21:00:00+08:00" }],
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    const incidentId = created.incident.incident_id;
    const claimId = created.report.claim_ids[0];
    assert.equal(created.assessment.action_level, "CONTINUE_OBSERVATION");

    // 事件视图：样本线索、说法等要素各自分开保存
    res = await fetch(`${base}/incidents/${incidentId}`);
    const view = await res.json();
    assert.equal(view.reports[0].sample_clues[0].kept, true);
    assert.equal(view.claims[0].status, "PENDING_REVIEW");

    // 观察窗未满 → 结案被闸门拦截（409）
    res = await post(base, `/incidents/${incidentId}/close`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "CLOSE_GUARD_REJECTED");

    // 专家判断：带证据、适用范围，版本从 1 开始
    res = await post(base, `/claims/${claimId}/verdicts`, {
      verdict: "REFUTED",
      evidence_refs: ["who:monograph-x"],
      applicable_scope: "照片或AI识别结果不能作为可食依据",
      reviewer: "expert-wang",
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).version, 1);

    // 内容平台回传更正结果
    res = await post(base, "/corrections", { claim_id: claimId, platform: "识别小程序", result: "CORRECTION_PUBLISHED" });
    assert.equal(res.status, 201);

    // 社区渠道再来电：同餐者出现症状 → 合并进同一事件 → 升级为立即就医
    res = await post(base, "/reports", {
      channel: "community",
      reporter: { contact: "135****7777" },
      meal: { meal_at: "2026-10-01T18:10:00+08:00", location: "某餐馆" },
      co_diners: [{ person_ref: "aunt-1" }],
      symptoms: [{ person_ref: "aunt-1", symptom: "DIARRHEA", observed_at: "2026-10-01T22:00:00+08:00" }],
    });
    assert.equal(res.status, 201);
    const merged = await res.json();
    assert.equal(merged.incident.incident_id, incidentId);
    assert.equal(merged.assessment.action_level, "SEEK_IMMEDIATE_CARE");

    // 溯源：值班人员可追到促成升级的公开信息、专家判断与平台更正
    res = await fetch(`${base}/incidents/${incidentId}/trace`);
    const trace = await res.json();
    assert.equal(trace.escalations.length, 1);
    assert.equal(trace.escalations[0].contributing_claims[0].text, "AI识别说可食");
    assert.equal(trace.escalations[0].contributing_claims[0].current_verdict.verdict, "REFUTED");
    assert.equal(trace.escalations[0].contributing_claims[0].corrections.length, 1);

    // 事件日志可审计
    res = await fetch(`${base}/events?subject_id=${incidentId}`);
    const events = await res.json();
    assert.ok(events.some((e) => e.kind === "RISK_ESCALATED"));

    // 未知路由 → 404
    res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});
