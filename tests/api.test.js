import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server.js";
import { CdcResponseService } from "../src/service.js";
import { SEED_GUIDELINE_V1 } from "../src/seed.js";

async function withServer(fn) {
  let current = new Date("2026-09-20T08:00:00+08:00");
  const service = new CdcResponseService({ now: () => current });
  service.publishGuideline(SEED_GUIDELINE_V1);
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const clock = { set: (iso) => (current = new Date(iso)) };
  try {
    await fn(api, clock);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("端到端：雨后混合来电的完整处置流程", async () => {
  await withServer(async (api, clock) => {
    // 1. 登记误导说法并研判。
    let res = await api("POST", "/claims", {
      text: "大蒜能验毒",
      category: "detection",
      source_links: [{ url: "https://video.example/garlic", platform: "短视频平台" }],
    });
    assert.equal(res.status, 201);
    const claimId = res.body.claim.claim_id;

    res = await api("POST", `/claims/${claimId}/reviews`, {
      reviewer: "毒理专家组",
      verdict: "REFUTED",
      evidence: [{ title: "毒理综述", reference: "DOI:10.xxxx/yyy" }],
      applicability: "全部野生蘑菇",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.review.version, 1);

    // 2. 第一通来电：看了短视频，吃了蘑菇，轻微头晕。
    res = await api("POST", "/submissions", {
      reporter_contact: "138-0000-0001",
      claim_sightings: [{ claim_id: claimId, source_link: "https://video.example/garlic" }],
      sample_clues: [{ description: "白色菌盖", public_identification: "AI识别可食", kept_sample: true }],
      meals: [{ eaten_at: "2026-09-19T18:30:00+08:00", location: "青山路家常菜馆" }],
      symptoms: [{ symptom: "头晕", observed_at: "2026-09-20T02:00:00+08:00" }],
    });
    assert.equal(res.status, 201);
    const incidentId = res.body.incident_id;
    assert.equal(res.body.assessment.action_level, "CONTINUE_OBSERVATION");
    assert.match(res.body.assessment.species_note, /不确认物种/);

    // 3. 重复来电合并：同餐者出现需立即就医症状。
    res = await api("POST", "/submissions", {
      reporter_contact: "13800000001",
      co_diners: [{ person_ref: "家人甲", also_symptomatic: true }],
      symptoms: [{ symptom: "持续呕吐", observed_at: "2026-09-20T06:00:00+08:00" }],
    });
    assert.equal(res.body.merged, true);
    assert.equal(res.body.assessment.action_level, "SEEK_IMMEDIATE_CARE");

    // 4. 值班溯源：升级由哪条公开信息促成。
    res = await api("GET", `/incidents/${incidentId}/trace`);
    assert.equal(res.body.escalations.length, 1);
    assert.equal(res.body.escalations[0].contributing_claims[0].text, "大蒜能验毒");
    assert.equal(res.body.escalations[0].contributing_claims[0].status, "REFUTED");

    // 5. 平台回传更正结果。
    res = await api("POST", `/claims/${claimId}/corrections`, {
      channel: "platform",
      result: "LABELLED",
      detail: "视频已加误导标识",
    });
    assert.equal(res.status, 201);

    // 6. 指引更新 → 未结案个案自动进重评队列。
    res = await api("POST", "/guidelines", {
      version: "2026.2",
      rules: { ...SEED_GUIDELINE_V1.rules, group_exposure_threshold: 1 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.queued_task_ids.length, 1);

    res = await api("GET", "/reevaluation-queue");
    assert.equal(res.body.tasks.length, 1);
    const taskId = res.body.tasks[0].task_id;
    res = await api("POST", `/reevaluation-queue/${taskId}/process`);
    assert.equal(res.status, 200);
    assert.equal(res.body.assessment.guideline_version, "2026.2");

    // 7. 来电人称症状暂缓，要求结案 → 被拒。
    await api("POST", "/submissions", {
      reporter_contact: "138-0000-0001",
      symptoms: [{ symptom: "持续呕吐", observed_at: "2026-09-20T10:00:00+08:00", status: "relieved" }],
    });
    res = await api("POST", `/incidents/${incidentId}/close`, { reason: "症状已缓解" });
    assert.equal(res.status, 409);
    assert.ok(res.body.earliest_close_at);

    // 8. 观察窗届满后结案成功。
    clock.set("2026-09-23T12:00:00+08:00");
    res = await api("POST", `/incidents/${incidentId}/close`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.incident.status, "CLOSED");
  });
});

test("API 入参校验与 404", async () => {
  await withServer(async (api) => {
    let res = await api("POST", "/submissions", { meals: [] });
    assert.equal(res.status, 400);
    assert.match(res.body.problems.join(), /reporter_contact/);

    res = await api("GET", "/incidents/inc-9999");
    assert.equal(res.status, 404);

    res = await api("GET", "/no-such-route");
    assert.equal(res.status, 404);
  });
});
