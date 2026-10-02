import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../src/service.js";
import { validateEvent } from "../src/poison_misinformation_response.js";

// 固定时钟，便于精确控制观察窗。
function harness(startIso = "2026-10-01T20:00:00+08:00") {
  let t = Date.parse(startIso);
  const service = createService({ now: () => new Date(t) });
  return { service, advanceHours: (h) => { t += h * 3_600_000; } };
}

test("重复来电合并进同一事件，说法跨事件去重", () => {
  const { service } = harness();
  const first = service.createReport({
    channel: "hotline",
    reporter: { contact: "138****0000" },
    meal: { meal_at: "2026-10-01T18:00:00+08:00", location: "某小区3栋" },
    claims: [
      {
        text: "大蒜可以验毒",
        category: "IDENTIFICATION_PROMISE",
        source_links: [{ url: "https://video.example/v1", platform: "短视频" }],
      },
    ],
    symptoms: [{ symptom: "VOMITING", observed_at: "2026-10-01T21:00:00+08:00" }],
  });
  const second = service.createReport({
    channel: "hotline",
    reporter: { contact: "138****0000" },
    meal: { meal_at: "2026-10-01T18:30:00+08:00", location: "某小区3栋" },
    claims: [{ text: "大蒜可以验毒", source_links: [{ url: "https://video.example/v2", platform: "短视频" }] }],
    co_diners: [{ person_ref: "uncle-1", relation: "家属" }],
    symptoms: [{ person_ref: "uncle-1", symptom: "DIARRHEA", observed_at: "2026-10-01T22:00:00+08:00" }],
  });

  assert.equal(second.incident.incident_id, first.incident.incident_id);
  assert.equal(second.incident.report_ids.length, 2);

  // 同一说法只登记一次，来源链接逐条保存
  const claims = service.listClaims();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].source_links.length, 2);

  // 同餐两人出现症状 → 群体暴露 → 立即就医，并留下升级记录
  assert.equal(second.assessment.action_level, "SEEK_IMMEDIATE_CARE");
  assert.ok(second.assessment.reasons.some((r) => r.rule === "GROUP_EXPOSURE"));
  const escalations = service.listEvents({ kind: "RISK_ESCALATED", subject_id: first.incident.incident_id });
  assert.equal(escalations.length, 1);
});

test("传输层幂等：同渠道同外部编号只登记一次", () => {
  const { service } = harness();
  const input = {
    channel: "hotline",
    external_ref: "call-2026-1001-01",
    reporter: { contact: "131****9999" },
    symptoms: [{ symptom: "NAUSEA", observed_at: "2026-10-01T19:00:00+08:00" }],
  };
  const first = service.createReport(input);
  const dup = service.createReport(input);
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.report.report_id, first.report.report_id);
  assert.equal(service.listIncidents().length, 1);
});

test("症状短暂缓解不能直接结案，须满观察窗", () => {
  const { service, advanceHours } = harness();
  service.createReport({
    channel: "hotline",
    reporter: { contact: "139****1111" },
    meal: { meal_at: "2026-10-01T18:00:00+08:00" },
    symptoms: [{ symptom: "VOMITING", observed_at: "2026-10-01T21:00:00+08:00" }],
  });
  // 来电人称“吐完不吐了”——时间线记录为已缓解，但事件不因此了结
  const follow = service.createReport({
    channel: "hotline",
    reporter: { contact: "139****1111" },
    symptoms: [{ symptom: "VOMITING", observed_at: "2026-10-01T23:00:00+08:00", status: "RELIEVED", note: "来电人称呕吐已停" }],
  });
  assert.equal(follow.assessment.action_level, "CONTINUE_OBSERVATION");
  const incidentId = follow.incident.incident_id;

  // 缓解当下结案 → 被闸门拦截并留痕
  assert.throws(
    () => service.closeIncident(incidentId),
    (err) => err.code === "CLOSE_GUARD_REJECTED" && err.details.some((p) => p.rule === "OBSERVATION_WINDOW"),
  );
  // 17 小时后仍不足 24 小时观察窗
  advanceHours(17);
  assert.throws(() => service.closeIncident(incidentId), /结案条件/);
  // 满 24 小时后可以结案；重复结案报错
  advanceHours(10);
  const closed = service.closeIncident(incidentId);
  assert.equal(closed.status, "CLOSED");
  assert.throws(() => service.closeIncident(incidentId), (err) => err.code === "ALREADY_CLOSED");

  const kinds = service.listEvents({ subject_id: incidentId }).map((e) => e.kind);
  assert.ok(kinds.includes("CASE_CLOSE_REJECTED"));
  assert.ok(kinds.includes("CASE_CLOSED"));
});

test("红旗症状升级后，溯源可追到促成升级的公开信息及其专家判断", () => {
  const { service } = harness();
  const first = service.createReport({
    channel: "hotline",
    reporter: { contact: "137****2222" },
    meal: { meal_at: "2026-10-01T18:00:00+08:00" },
    claims: [
      {
        text: "高温煮沸就能去毒",
        category: "DETOX_METHOD",
        source_links: [{ url: "https://video.example/hot", platform: "短视频" }],
      },
    ],
    symptoms: [{ symptom: "NAUSEA", observed_at: "2026-10-01T20:30:00+08:00" }],
  });
  assert.equal(first.assessment.action_level, "CONTINUE_OBSERVATION");

  const claimId = first.report.claim_ids[0];
  service.addVerdict(claimId, {
    verdict: "REFUTED",
    evidence_refs: ["doi:10.0000/example.1", "cdc-internal:memo-2026-07"],
    applicable_scope: "常见耐热毒素（如鹅膏肽类）常规烹饪不分解",
    reviewer: "expert-zhang",
  });

  const incidentId = first.incident.incident_id;
  const second = service.createReport({
    channel: "hotline",
    reporter: { contact: "137****2222" },
    symptoms: [{ symptom: "CONFUSION", observed_at: "2026-10-01T23:30:00+08:00" }],
  });
  assert.equal(second.assessment.action_level, "CONTACT_EMERGENCY");

  const trace = service.traceIncident(incidentId);
  assert.equal(trace.escalations.length, 1);
  const escalation = trace.escalations[0];
  assert.equal(escalation.from_level, "CONTINUE_OBSERVATION");
  assert.equal(escalation.to_level, "CONTACT_EMERGENCY");
  assert.equal(escalation.guideline_version, "2026.1");
  assert.equal(escalation.contributing_claims[0].text, "高温煮沸就能去毒");
  assert.equal(escalation.contributing_claims[0].current_verdict.verdict, "REFUTED");
  assert.equal(escalation.contributing_claims[0].current_verdict.version, 1);

  // 平台回传更正后，同一条溯源记录里能看到更正结果
  service.addCorrection({ claim_id: claimId, platform: "短视频平台A", result: "RATED_FALSE", url: "https://video.example/hot" });
  const traced = service.traceIncident(incidentId);
  assert.equal(traced.escalations[0].contributing_claims[0].corrections.length, 1);
  assert.equal(service.listEvents({ kind: "CORRECTION_ACKNOWLEDGED" }).length, 1);
});

test("事件日志全部符合领域事件契约", () => {
  const { service } = harness();
  service.createReport({
    channel: "hotline",
    reporter: { contact: "130****8888" },
    claims: [{ text: "呕吐完就没事了", category: "OBSERVATION_ADVICE" }],
    symptoms: [{ symptom: "VOMITING", observed_at: "2026-10-01T19:00:00+08:00" }],
  });
  for (const event of service.listEvents()) {
    assert.deepEqual(validateEvent(event), []);
  }
});
