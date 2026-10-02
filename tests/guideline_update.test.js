import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../src/service.js";

function harness(startIso = "2026-10-01T20:00:00+08:00") {
  let t = Date.parse(startIso);
  const service = createService({ now: () => new Date(t) });
  return { service, advanceHours: (h) => { t += h * 3_600_000; } };
}

test("指引更新后未结个案自动进入重评队列，已结案的不入队", () => {
  const { service, advanceHours } = harness();
  // 事件A：餐后3小时呕吐，按 2026.1（延迟阈值6小时）为持续留观
  const a = service.createReport({
    channel: "hotline",
    reporter: { contact: "136****3333" },
    meal: { meal_at: "2026-10-01T18:00:00+08:00" },
    symptoms: [{ symptom: "VOMITING", observed_at: "2026-10-01T21:00:00+08:00" }],
  });
  assert.equal(a.assessment.action_level, "CONTINUE_OBSERVATION");
  // 事件B：同类情况，先走完观察窗结案
  const b = service.createReport({
    channel: "hotline",
    reporter: { contact: "136****4444" },
    meal: { meal_at: "2026-10-01T18:00:00+08:00" },
    symptoms: [{ symptom: "VOMITING", observed_at: "2026-10-01T21:00:00+08:00" }],
  });
  advanceHours(25); // 距最后症状已满 24 小时观察窗
  service.closeIncident(b.incident.incident_id);

  // 发布 2026.2：延迟发作阈值收紧到 2 小时
  const published = service.publishGuideline({
    version: "2026.2",
    effective_from: "2026-10-02T00:00:00+08:00",
    delayed_onset_hours: 2,
  });
  assert.equal(published.queued_tasks.length, 1);
  const task = published.queued_tasks[0];
  assert.equal(task.incident_id, a.incident.incident_id);
  assert.equal(task.from_version, "2026.1");
  assert.equal(task.to_version, "2026.2");

  // 重评队列未清时不能结案
  assert.throws(
    () => service.closeIncident(a.incident.incident_id),
    (err) => err.code === "CLOSE_GUARD_REJECTED" && err.details.some((p) => p.rule === "REEVALUATION_PENDING"),
  );

  // 完成重评：按新指引，餐后3小时发作越过2小时阈值 → 立即就医
  const done = service.completeReevaluation(task.task_id, { assessed_by: "duty-li" });
  assert.equal(done.task.status, "DONE");
  assert.equal(done.assessment.guideline_version, "2026.2");
  assert.equal(done.assessment.action_level, "SEEK_IMMEDIATE_CARE");

  // 升级记录带新指引版本，事件使用过的指引版本完整可查
  const trace = service.traceIncident(a.incident.incident_id);
  assert.equal(trace.escalations.at(-1).guideline_version, "2026.2");
  assert.deepEqual(trace.guideline_versions_used, ["2026.1", "2026.2"]);

  // 已结案的事件B全程未被重评打扰
  assert.equal(service.listReevaluationTasks({ status: "QUEUED" }).length, 0);
  assert.equal(service.getIncidentView(b.incident.incident_id).status, "CLOSED");
});

test("重复发布同版本号指引被拒绝", () => {
  const { service } = harness();
  service.publishGuideline({ version: "2026.2", effective_from: "2026-10-02T00:00:00+08:00" });
  assert.throws(
    () => service.publishGuideline({ version: "2026.2", effective_from: "2026-10-03T00:00:00+08:00" }),
    (err) => err.code === "DUPLICATE_VERSION",
  );
});
