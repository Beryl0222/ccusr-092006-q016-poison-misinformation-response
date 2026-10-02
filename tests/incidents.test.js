import assert from "node:assert/strict";
import test from "node:test";
import { makeService, BASE_SUBMISSION } from "./helpers.js";

test("重复来电按联系人或餐次指纹合并进同一事件", () => {
  const { service } = makeService();

  const first = service.receiveSubmission({
    ...BASE_SUBMISSION,
    symptoms: [{ symptom: "头晕", observed_at: "2026-09-20T02:00:00+08:00" }],
  });
  assert.equal(first.ok, true);
  assert.equal(first.merged, false);

  // 同一联系人再次来电，补充样本线索。
  const second = service.receiveSubmission({
    reporter_contact: "13800000001", // 格式不同，指纹相同
    sample_clues: [{ description: "白色菌盖，留样冷藏", kept_sample: true }],
  });
  assert.equal(second.merged, true);
  assert.equal(second.incident_id, first.incident_id);

  // 不同联系人，但同一餐次（同日期同地点）也合并。
  const third = service.receiveSubmission({
    reporter_contact: "139-1111-2222",
    meals: [{ eaten_at: "2026-09-19T19:00:00+08:00", location: "青山路家常菜馆 " }],
  });
  assert.equal(third.merged, true);
  assert.equal(third.incident_id, first.incident_id);

  // 无关来电开新事件。
  const fourth = service.receiveSubmission({
    reporter_contact: "137-9999-8888",
    meals: [{ eaten_at: "2026-09-21T12:00:00+08:00", location: "城西食堂" }],
  });
  assert.equal(fourth.merged, false);
  assert.notEqual(fourth.incident_id, first.incident_id);
});

test("新信息促成升级时，溯源能看到哪条公开信息在场", () => {
  const { service } = makeService();
  const claim = service.registerClaim({
    text: "高温煮沸可以去毒",
    category: "detox",
    source_links: [{ url: "https://video.example/abc", platform: "短视频平台" }],
  }).claim;

  const first = service.receiveSubmission({
    ...BASE_SUBMISSION,
    claim_sightings: [{ claim_id: claim.claim_id, source_link: "https://video.example/abc" }],
    symptoms: [{ symptom: "头晕", observed_at: "2026-09-20T02:00:00+08:00" }],
  });
  assert.equal(first.assessment.action_level, "CONTINUE_OBSERVATION");

  // 同餐者陆续出现症状 → 升级为立即就医。
  const second = service.receiveSubmission({
    reporter_contact: "138-0000-0001",
    co_diners: [{ person_ref: "家人甲", also_symptomatic: true }],
    symptoms: [{ symptom: "持续呕吐", observed_at: "2026-09-20T06:00:00+08:00" }],
  });
  assert.equal(second.assessment.action_level, "SEEK_IMMEDIATE_CARE");

  const trace = service.incidentTrace(first.incident_id);
  assert.equal(trace.escalations.length, 1);
  const escalation = trace.escalations[0];
  assert.equal(escalation.from_level, "CONTINUE_OBSERVATION");
  assert.equal(escalation.to_level, "SEEK_IMMEDIATE_CARE");
  assert.deepEqual(
    escalation.contributing_claims.map((c) => c.text),
    ["高温煮沸可以去毒"],
  );
  assert.equal(escalation.contributing_claims[0].status, "UNDER_REVIEW");

  // 事件日志里也有 RISK_ESCALATED。
  assert.ok(trace.events.some((e) => e.kind === "RISK_ESCALATED"));
});

test("症状暂缓不能直接结案，观察窗届满后才可结案", () => {
  const { service, clock } = makeService();
  const first = service.receiveSubmission({
    ...BASE_SUBMISSION,
    symptoms: [{ symptom: "持续呕吐", observed_at: "2026-09-20T02:00:00+08:00" }],
  });
  const incidentId = first.incident_id;

  // 来电人称"呕吐暂缓"——记录为 relieved，但结案必须被拒绝。
  service.receiveSubmission({
    reporter_contact: "138-0000-0001",
    symptoms: [{ symptom: "持续呕吐", observed_at: "2026-09-20T10:00:00+08:00", status: "relieved" }],
  });
  const early = service.closeIncident(incidentId, { reason: "来电人称已缓解" });
  assert.equal(early.ok, false);
  assert.equal(early.status, 409);
  assert.ok(early.earliest_close_at);

  // 推进时钟超过两个观察窗（末次症状 09-20 10:00 + 48h；末次食用 09-19 18:30 + 72h）。
  clock.set("2026-09-23T12:00:00+08:00");
  const done = service.closeIncident(incidentId, {});
  assert.equal(done.ok, true);
  assert.equal(done.incident.status, "CLOSED");

  // 已结案事件不再接收合并：同一联系人再来电会开新事件。
  const after = service.receiveSubmission({ reporter_contact: "138-0000-0001" });
  assert.equal(after.merged, false);
  assert.notEqual(after.incident_id, incidentId);
});

test("提交校验：样本线索不允许写入 confirmed_species", () => {
  const { service } = makeService();
  const result = service.receiveSubmission({
    reporter_contact: "138-0000-0002",
    sample_clues: [{ description: "灰色菌", confirmed_species: "可食蘑菇" }],
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /confirmed_species/);
});
