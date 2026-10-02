// 应用服务：把提交、说法、指引、事件、重评队列编排成用例级 API。
// HTTP 层与测试都通过本服务进入，保证规则只在一处实现。

import { Store } from "./store.js";
import { validateSubmission, splitSubmission } from "./submissions.js";
import {
  validateClaim,
  validateReview,
  validateCorrection,
  registerClaim,
  addReview,
  addCorrection,
  claimDetail,
} from "./claims.js";
import { validateGuidelineRules, currentGuideline } from "./guidelines.js";
import { intakeSubmission, recordAssessment, closeIncident, incidentTrace, incidentFacts } from "./incidents.js";

const OPEN_STATUSES = ["OPEN", "MONITORING", "ESCALATED"];

export class CdcResponseService {
  constructor({ now } = {}) {
    this.store = new Store(now ? { now } : {});
  }

  // --- 公众提交 ---
  receiveSubmission(input) {
    const problems = validateSubmission(input);
    if (problems.length > 0) return { ok: false, status: 400, problems };
    if (!currentGuideline(this.store.all("guidelines"), this.store.now())) {
      return { ok: false, status: 409, problems: ["尚无生效指引，无法分诊"] };
    }
    const split = splitSubmission(this.store, input);
    const { incident, merged, assessment } = intakeSubmission(this.store, split);
    return {
      ok: true,
      status: 201,
      submission_id: split.submission.submission_id,
      incident_id: incident.incident_id,
      merged,
      assessment,
    };
  }

  // --- 说法登记与研判 ---
  registerClaim(input) {
    const problems = validateClaim(input);
    if (problems.length > 0) return { ok: false, status: 400, problems };
    const claim = registerClaim(this.store, input);
    return { ok: true, status: 201, claim };
  }

  addClaimReview(claimId, input) {
    const problems = validateReview(input);
    if (problems.length > 0) return { ok: false, status: 400, problems };
    const review = addReview(this.store, claimId, input);
    if (!review) return { ok: false, status: 404, problems: ["说法不存在"] };
    return { ok: true, status: 201, review };
  }

  addClaimCorrection(claimId, input) {
    const problems = validateCorrection(input);
    if (problems.length > 0) return { ok: false, status: 400, problems };
    const correction = addCorrection(this.store, claimId, input);
    if (!correction) return { ok: false, status: 404, problems: ["说法不存在"] };
    return { ok: true, status: 201, correction };
  }

  claimDetail(claimId) {
    const detail = claimDetail(this.store, claimId);
    return detail ? { ok: true, status: 200, claim: detail } : { ok: false, status: 404, problems: ["说法不存在"] };
  }

  // 说法影响面：哪些事件的风险升级有它促成。
  claimImpact(claimId) {
    const escalations = this.store
      .all("escalations")
      .filter((e) => e.contributing_claims.includes(claimId))
      .map((e) => ({
        escalation_id: e.escalation_id,
        incident_id: e.incident_id,
        from_level: e.from_level,
        to_level: e.to_level,
        created_at: e.created_at,
      }));
    return { ok: true, status: 200, claim_id: claimId, escalations };
  }

  // --- 指引版本 ---
  publishGuideline(input) {
    const problems = [];
    if (!String(input.version ?? "").trim()) problems.push("version");
    problems.push(...validateGuidelineRules(input.rules ?? {}));
    if (this.store.find("guidelines", "version", input.version)) problems.push("version 已存在");
    if (problems.length > 0) return { ok: false, status: 400, problems };

    const guideline = this.store.insert("guidelines", {
      guideline_id: this.store.nextId("gl"),
      version: String(input.version).trim(),
      effective_from: (input.effective_from ? new Date(input.effective_from) : this.store.now()).toISOString(),
      supersedes: currentGuideline(this.store.all("guidelines"), this.store.now())?.version ?? null,
      rules: input.rules,
      note: String(input.note ?? "").trim() || null,
    });
    this.store.appendEvent("GUIDELINE_PUBLISHED", guideline.guideline_id, {
      version: guideline.version,
      supersedes: guideline.supersedes,
    });

    // 指引更新后，尚未结束的个案自动进入重评队列。
    const queued = [];
    for (const incident of this.store.where("incidents", (i) => OPEN_STATUSES.includes(i.status))) {
      const task = this.store.insert("reevaluation_tasks", {
        task_id: this.store.nextId("reval"),
        incident_id: incident.incident_id,
        from_version: guideline.supersedes,
        to_version: guideline.version,
        status: "PENDING",
        queued_at: this.store.now().toISOString(),
        processed_at: null,
      });
      this.store.appendEvent("REEVALUATION_QUEUED", incident.incident_id, {
        task_id: task.task_id,
        to_version: guideline.version,
      });
      queued.push(task);
    }
    return { ok: true, status: 201, guideline, queued_task_ids: queued.map((t) => t.task_id) };
  }

  currentGuideline() {
    const guideline = currentGuideline(this.store.all("guidelines"), this.store.now());
    return guideline
      ? { ok: true, status: 200, guideline }
      : { ok: false, status: 404, problems: ["尚无生效指引"] };
  }

  reevaluationQueue() {
    return { ok: true, status: 200, tasks: this.store.where("reevaluation_tasks", (t) => t.status === "PENDING") };
  }

  // 处理重评：按新指引重新分诊；若级别上调，recordAssessment 会自动留升级痕。
  processReevaluation(taskId) {
    const task = this.store.find("reevaluation_tasks", "task_id", taskId);
    if (!task) return { ok: false, status: 404, problems: ["重评任务不存在"] };
    if (task.status !== "PENDING") return { ok: false, status: 409, problems: ["任务已处理"] };
    const incident = this.store.find("incidents", "incident_id", task.incident_id);
    if (!incident || incident.status === "CLOSED") {
      task.status = "SKIPPED";
      task.processed_at = this.store.now().toISOString();
      return { ok: true, status: 200, task, assessment: null };
    }
    const guideline = this.store.find("guidelines", "version", task.to_version);
    const assessment = recordAssessment(this.store, incident, "GUIDELINE_UPDATE", guideline);
    task.status = "DONE";
    task.processed_at = this.store.now().toISOString();
    return { ok: true, status: 200, task, assessment };
  }

  // --- 事件查询与结案 ---
  incidentDetail(incidentId) {
    const incident = this.store.find("incidents", "incident_id", incidentId);
    if (!incident) return { ok: false, status: 404, problems: ["事件不存在"] };
    return { ok: true, status: 200, incident, facts: incidentFacts(this.store, incidentId) };
  }

  incidentTrace(incidentId) {
    const trace = incidentTrace(this.store, incidentId);
    return trace ? { ok: true, status: 200, ...trace } : { ok: false, status: 404, problems: ["事件不存在"] };
  }

  closeIncident(incidentId, input = {}) {
    const result = closeIncident(this.store, incidentId, { reason: input.reason, now: input.now ?? null });
    if (result.notFound) return { ok: false, status: 404, problems: ["事件不存在"] };
    if (result.rejected) {
      return { ok: false, status: 409, problems: result.reasons, earliest_close_at: result.earliest_close_at };
    }
    return { ok: true, status: 200, incident: result.incident };
  }
}
