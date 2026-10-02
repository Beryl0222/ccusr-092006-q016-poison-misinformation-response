import assert from "node:assert/strict";
import test from "node:test";
import { makeService, BASE_SUBMISSION } from "./helpers.js";
import { SEED_GUIDELINE_V1 } from "../src/seed.js";

function guidelineV2(overrides = {}) {
  return {
    version: "2026.2",
    note: "收紧群体暴露阈值",
    rules: { ...SEED_GUIDELINE_V1.rules, ...overrides },
  };
}

test("指引更新后，未结案个案自动进入重评队列，已结案不进", () => {
  const { service, clock } = makeService();

  const open = service.receiveSubmission({
    ...BASE_SUBMISSION,
    symptoms: [{ symptom: "头晕", observed_at: "2026-09-20T02:00:00+08:00" }],
  });
  const closable = service.receiveSubmission({
    reporter_contact: "137-0000-0000",
    meals: [{ eaten_at: "2026-09-10T12:00:00+08:00", location: "老食堂" }],
    symptoms: [{ symptom: "头晕", observed_at: "2026-09-10T14:00:00+08:00" }],
  });
  clock.set("2026-09-20T09:00:00+08:00"); // 早已超过观察窗
  assert.equal(service.closeIncident(closable.incident_id, {}).ok, true);

  const published = service.publishGuideline(guidelineV2());
  assert.equal(published.ok, true);
  assert.equal(published.guideline.supersedes, "2026.1");
  assert.equal(published.queued_task_ids.length, 1);

  const queue = service.reevaluationQueue();
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].incident_id, open.incident_id);
  assert.equal(queue.tasks[0].from_version, "2026.1");
  assert.equal(queue.tasks[0].to_version, "2026.2");
});

test("处理重评：按新指引重新分诊，升级自动留痕", () => {
  const { service } = makeService();
  // 一名同餐者有症状，旧阈值 2 → 持续留观。
  const open = service.receiveSubmission({
    ...BASE_SUBMISSION,
    co_diners: [{ person_ref: "家人甲", also_symptomatic: true }],
  });
  assert.equal(open.assessment.action_level, "CONTINUE_OBSERVATION");

  // 新指引把群体阈值收紧到 1。
  const published = service.publishGuideline(guidelineV2({ group_exposure_threshold: 1 }));
  const [taskId] = published.queued_task_ids;

  const processed = service.processReevaluation(taskId);
  assert.equal(processed.ok, true);
  assert.equal(processed.assessment.action_level, "SEEK_IMMEDIATE_CARE");
  assert.equal(processed.assessment.guideline_version, "2026.2");
  assert.equal(processed.assessment.trigger, "GUIDELINE_UPDATE");

  const trace = service.incidentTrace(open.incident_id);
  assert.equal(trace.escalations.length, 1);
  assert.equal(trace.escalations[0].trigger, "GUIDELINE_UPDATE");
  assert.equal(trace.escalations[0].guideline_version, "2026.2");

  // 重复处理被拒绝。
  assert.equal(service.processReevaluation(taskId).status, 409);
});

test("评估引用的是当时有效指引，历史评估不被改写", () => {
  const { service } = makeService();
  const open = service.receiveSubmission({
    ...BASE_SUBMISSION,
    symptoms: [{ symptom: "头晕", observed_at: "2026-09-20T02:00:00+08:00" }],
  });
  service.publishGuideline(guidelineV2());

  const trace = service.incidentTrace(open.incident_id);
  assert.equal(trace.assessments.length, 1);
  assert.equal(trace.assessments[0].guideline_version, "2026.1"); // 仍是旧版本
  assert.equal(service.currentGuideline().guideline.version, "2026.2");
});
