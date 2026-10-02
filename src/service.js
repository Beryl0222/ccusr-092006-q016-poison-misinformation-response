// 应用服务：把领域规则串成热线值班可用的操作。
// 原则：
//  - 系统不诊断、不确认蘑菇物种，只依据可观察症状、群体暴露与当时有效指引
//    给出行动级别；
//  - 公众提交的说法、来源链接、样本线索、食用时间、同餐关系、症状时间线
//    分开保存；
//  - 重复来电合并进同一事件；症状短暂缓解不能直接结案；
//  - 每一次评估、升级、结案/拒结都写入事件日志，值班人员可追溯到
//    究竟哪条公开信息促成了风险升级。

import {
  ACTION_LEVEL_RANK,
  CLAIM_CATEGORIES,
  CORRECTION_RESULTS,
  SYMPTOM_CODES,
  SYMPTOM_STATUS,
  VERDICTS,
} from "./poison_misinformation_response.js";
import { createStore } from "./store.js";
import { defaultGuideline, effectiveGuideline } from "./guidelines.js";
import { evaluateTriage } from "./triage.js";

export class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new ServiceError(400, "VALIDATION_FAILED", message, details);
const notFound = (what) => new ServiceError(404, "NOT_FOUND", `${what}不存在`);
const conflict = (code, message, details) => new ServiceError(409, code, message, details);

const HOUR_MS = 3_600_000;
// 重复来电合并：进食时间差在该窗口内，且地点或同餐人重合，即视为同一事件。
const MERGE_MEAL_WINDOW_HOURS = 3;
const round1 = (n) => Math.round(n * 10) / 10;
const normalizeText = (text) => text.trim().toLowerCase().replace(/\s+/g, " ");

export function createService({ store = createStore(), now = () => new Date() } = {}) {
  if (store.guidelines.length === 0) store.guidelines.push(defaultGuideline());
  const clock = () => new Date(now());
  const iso = () => clock().toISOString();

  function nextId(prefix) {
    const n = (store.sequences.get(prefix) ?? 0) + 1;
    store.sequences.set(prefix, n);
    return `${prefix}-${String(n).padStart(6, "0")}`;
  }

  function emit(kind, subject_id, payload) {
    const event = { event_id: nextId("evt"), kind, occurred_at: iso(), subject_id, payload };
    store.events.push(event);
    return event;
  }

  function mustIncident(incident_id) {
    const incident = store.incidents.get(incident_id);
    if (!incident) throw notFound(`事件 ${incident_id}`);
    return incident;
  }

  function incidentReports(incident) {
    return incident.report_ids.map((id) => store.reports.get(id));
  }

  function incidentSymptoms(incident) {
    return incidentReports(incident).flatMap((r) => r.symptoms);
  }

  function incidentClaimIds(incident) {
    return [...new Set(incidentReports(incident).flatMap((r) => r.claim_ids))];
  }

  function earliestMeal(incident) {
    const meals = incidentReports(incident)
      .map((r) => r.meal?.meal_at)
      .filter(Boolean)
      .map(Date.parse);
    return meals.length ? new Date(Math.min(...meals)).toISOString() : null;
  }

  function latestAssessment(incident) {
    return incident.last_assessment_id ? store.assessments.get(incident.last_assessment_id) : null;
  }

  // ---------- 公众提交 ----------

  function createReport(input = {}) {
    const problems = [];
    if (!input.channel) problems.push("channel");
    if (input.meal?.meal_at && Number.isNaN(Date.parse(input.meal.meal_at))) problems.push("meal.meal_at");
    (input.claims ?? []).forEach((c, i) => {
      if (!c.text?.trim()) problems.push(`claims[${i}].text`);
      if (c.category && !CLAIM_CATEGORIES.includes(c.category)) problems.push(`claims[${i}].category`);
    });
    (input.symptoms ?? []).forEach((s, i) => {
      if (!SYMPTOM_CODES.includes(s.symptom)) problems.push(`symptoms[${i}].symptom`);
      if (!s.observed_at || Number.isNaN(Date.parse(s.observed_at))) problems.push(`symptoms[${i}].observed_at`);
      if (s.status && !SYMPTOM_STATUS.includes(s.status)) problems.push(`symptoms[${i}].status`);
    });
    (input.co_diners ?? []).forEach((d, i) => {
      if (!d.person_ref) problems.push(`co_diners[${i}].person_ref`);
    });
    if (problems.length) throw badRequest("提交内容缺少必要字段或取值非法", problems);

    // 传输层幂等：同一渠道同一外部编号只登记一次。
    if (input.external_ref) {
      const dup = [...store.reports.values()].find(
        (r) => r.channel === input.channel && r.external_ref === input.external_ref,
      );
      if (dup) {
        const incident = store.incidents.get(dup.incident_id);
        return { report: dup, incident, assessment: latestAssessment(incident), deduplicated: true };
      }
    }

    const incident = findOrCreateIncident(input);
    const contact = input.reporter?.contact ?? null;
    const defaultPerson = input.reporter?.person_ref ?? (contact ? `contact:${contact}` : "reporter");
    const report = {
      report_id: nextId("rep"),
      external_ref: input.external_ref ?? null,
      channel: input.channel,
      received_at: iso(),
      reporter: { contact, person_ref: input.reporter?.person_ref ?? null },
      incident_id: incident.incident_id,
      // 食用时间单独保存。
      meal: input.meal
        ? { meal_at: input.meal.meal_at ?? null, description: input.meal.description ?? null, location: input.meal.location ?? null }
        : null,
      claim_ids: [],
      // 蘑菇样本线索单独保存：只记录可观察描述与留存状态，系统不确认物种。
      sample_clues: (input.sample_clues ?? []).map((c) => ({
        clue_id: nextId("clu"),
        description: c.description ?? null,
        photo_ref: c.photo_ref ?? null,
        location: c.location ?? null,
        kept: Boolean(c.kept),
      })),
      // 同餐关系单独保存。
      co_diners: (input.co_diners ?? []).map((d) => ({ person_ref: d.person_ref, relation: d.relation ?? null })),
      // 症状时间线单独保存。
      symptoms: (input.symptoms ?? []).map((s) => ({
        symptom_id: nextId("sym"),
        person_ref: s.person_ref ?? defaultPerson,
        symptom: s.symptom,
        observed_at: new Date(Date.parse(s.observed_at)).toISOString(),
        status: s.status ?? "ACTIVE",
        note: s.note ?? null,
      })),
    };

    // 说法单独登记到说法库，跨事件去重，供专家判断与平台更正挂接。
    for (const c of input.claims ?? []) {
      report.claim_ids.push(registerClaim(c, report).claim_id);
    }

    store.reports.set(report.report_id, report);
    incident.report_ids.push(report.report_id);
    updateMergeKeys(incident, report, input);
    emit("EXPOSURE_LINKED", incident.incident_id, { report_id: report.report_id, claim_ids: report.claim_ids });

    // 每次提交后按当时有效指引自动重估，值班人员立即可见最新行动级别。
    const assessment = assessIncident(incident.incident_id, { assessed_by: "intake" });
    return { report, incident, assessment, deduplicated: false };
  }

  function registerClaim(input, report) {
    const key = normalizeText(input.text);
    let claim = [...store.claims.values()].find((c) => c.normalized_text === key);
    if (!claim) {
      claim = {
        claim_id: nextId("clm"),
        text: input.text.trim(),
        normalized_text: key,
        category: input.category ?? "OTHER",
        status: "PENDING_REVIEW",
        source_links: [],
        report_ids: [],
        verdict_ids: [],
        correction_ids: [],
        first_seen_at: iso(),
      };
      store.claims.set(claim.claim_id, claim);
      emit("CLAIM_REPORTED", claim.claim_id, { report_id: report.report_id, category: claim.category });
    }
    if (!claim.report_ids.includes(report.report_id)) claim.report_ids.push(report.report_id);
    // 来源链接逐条保存并按 URL 去重。
    for (const link of input.source_links ?? []) {
      if (!link?.url) continue;
      if (!claim.source_links.some((l) => l.url === link.url)) {
        claim.source_links.push({ url: link.url, platform: link.platform ?? null, captured_at: iso() });
      }
    }
    return claim;
  }

  function findOrCreateIncident(input) {
    if (input.incident_id) {
      const incident = store.incidents.get(input.incident_id);
      if (!incident) throw notFound(`事件 ${input.incident_id}`);
      if (incident.status === "CLOSED") {
        throw conflict("INCIDENT_CLOSED", "事件已结案，不能并入新提交", { incident_id: incident.incident_id });
      }
      return incident;
    }
    const contact = input.reporter?.contact ?? null;
    const mealAt = input.meal?.meal_at ? Date.parse(input.meal.meal_at) : null;
    const location = input.meal?.location?.trim().toLowerCase() || null;
    const persons = [
      input.reporter?.person_ref,
      ...(input.co_diners ?? []).map((d) => d.person_ref),
    ].filter(Boolean);
    for (const incident of store.incidents.values()) {
      if (incident.status !== "OPEN") continue;
      // 同一来电人再次来电 → 同一事件。
      if (contact && incident.merge_keys.contacts.includes(contact)) return incident;
      // 进食时间接近，且地点或同餐人重合 → 同一事件。
      if (mealAt && incident.merge_keys.meal_at) {
        const dtHours = Math.abs(mealAt - Date.parse(incident.merge_keys.meal_at)) / HOUR_MS;
        if (dtHours <= MERGE_MEAL_WINDOW_HOURS) {
          if (location && incident.merge_keys.location === location) return incident;
          if (persons.some((p) => incident.merge_keys.persons.includes(p))) return incident;
        }
      }
    }
    const incident = {
      incident_id: nextId("inc"),
      status: "OPEN",
      opened_at: iso(),
      closed_at: null,
      report_ids: [],
      current_level: null,
      last_assessment_id: null,
      last_assessed_guideline_version: null,
      merge_keys: { contacts: [], meal_at: input.meal?.meal_at ?? null, location, persons: [] },
    };
    store.incidents.set(incident.incident_id, incident);
    return incident;
  }

  function updateMergeKeys(incident, report, input) {
    const contact = report.reporter.contact;
    if (contact && !incident.merge_keys.contacts.includes(contact)) incident.merge_keys.contacts.push(contact);
    if (!incident.merge_keys.meal_at && report.meal?.meal_at) incident.merge_keys.meal_at = report.meal.meal_at;
    if (!incident.merge_keys.location && report.meal?.location) {
      incident.merge_keys.location = report.meal.location.trim().toLowerCase();
    }
    const refs = [input.reporter?.person_ref, ...report.co_diners.map((d) => d.person_ref)].filter(Boolean);
    for (const p of refs) {
      if (!incident.merge_keys.persons.includes(p)) incident.merge_keys.persons.push(p);
    }
  }

  // ---------- 行动级别评估 ----------

  function assessIncident(incident_id, { assessed_by = "system" } = {}) {
    const incident = mustIncident(incident_id);
    if (incident.status === "CLOSED") throw conflict("INCIDENT_CLOSED", "事件已结案，不再评估", { incident_id });
    const guideline = effectiveGuideline(store.guidelines, iso());
    if (!guideline) throw conflict("NO_EFFECTIVE_GUIDELINE", "当前没有生效中的指引", {});
    const { action_level, reasons } = evaluateTriage({
      meal_at: earliestMeal(incident),
      symptoms: incidentSymptoms(incident),
      guideline,
    });
    const previous = latestAssessment(incident);
    const claimIds = incidentClaimIds(incident);
    const assessment = {
      assessment_id: nextId("asm"),
      incident_id,
      guideline_version: guideline.version,
      action_level,
      reasons,
      contributing_claim_ids: claimIds,
      assessed_by,
      assessed_at: iso(),
    };
    store.assessments.set(assessment.assessment_id, assessment);
    incident.current_level = action_level;
    incident.last_assessment_id = assessment.assessment_id;
    incident.last_assessed_guideline_version = guideline.version;
    emit("ASSESSMENT_RECORDED", incident_id, {
      assessment_id: assessment.assessment_id,
      action_level,
      guideline_version: guideline.version,
    });
    if (previous && ACTION_LEVEL_RANK[action_level] > ACTION_LEVEL_RANK[previous.action_level]) {
      // 升级留痕：带来源说法与命中规则，值班人员可据此追溯。
      emit("RISK_ESCALATED", incident_id, {
        from_level: previous.action_level,
        to_level: action_level,
        assessment_id: assessment.assessment_id,
        guideline_version: guideline.version,
        claim_ids: claimIds,
        reasons,
      });
    }
    return assessment;
  }

  // ---------- 结案闸门 ----------

  function closeIncident(incident_id, { closed_by = "duty" } = {}) {
    const incident = mustIncident(incident_id);
    if (incident.status === "CLOSED") throw conflict("ALREADY_CLOSED", "事件已结案", { incident_id });
    const guideline = effectiveGuideline(store.guidelines, iso());
    const problems = [];
    const queued = [...store.reevaluationTasks.values()].find(
      (t) => t.incident_id === incident_id && t.status === "QUEUED",
    );
    if (queued) problems.push({ rule: "REEVALUATION_PENDING", task_id: queued.task_id });
    // 症状短暂缓解不能直接结案：以最后一次症状记录（含“已缓解”）为起点，
    // 须满指引要求的观察窗。
    const symptoms = incidentSymptoms(incident);
    if (guideline && symptoms.length) {
      const lastAt = Math.max(...symptoms.map((s) => Date.parse(s.observed_at)));
      const elapsedHours = (clock().getTime() - lastAt) / HOUR_MS;
      if (elapsedHours < guideline.observation_window_hours) {
        problems.push({
          rule: "OBSERVATION_WINDOW",
          elapsed_hours: round1(elapsedHours),
          required_hours: guideline.observation_window_hours,
        });
      }
    }
    const latest = latestAssessment(incident);
    if (latest && latest.action_level !== "CONTINUE_OBSERVATION") {
      problems.push({ rule: "ACTION_LEVEL_ACTIVE", action_level: latest.action_level, assessment_id: latest.assessment_id });
    }
    if (problems.length) {
      emit("CASE_CLOSE_REJECTED", incident_id, { closed_by, problems });
      throw conflict("CLOSE_GUARD_REJECTED", "未达到结案条件：症状缓解不等于观察结束", problems);
    }
    incident.status = "CLOSED";
    incident.closed_at = iso();
    emit("CASE_CLOSED", incident_id, { closed_by, guideline_version: guideline?.version ?? null });
    return incident;
  }

  // ---------- 专家判断 ----------

  function addVerdict(claim_id, input = {}) {
    const claim = store.claims.get(claim_id);
    if (!claim) throw notFound(`说法 ${claim_id}`);
    const problems = [];
    if (!VERDICTS.includes(input.verdict)) problems.push("verdict");
    if (!input.reviewer) problems.push("reviewer");
    if (!input.applicable_scope) problems.push("applicable_scope");
    if (!Array.isArray(input.evidence_refs) || input.evidence_refs.length === 0) problems.push("evidence_refs");
    if (problems.length) throw badRequest("专家判断缺少必要字段", problems);
    // 版本随判断次数递增，历史判断全部保留。
    const version = claim.verdict_ids.length + 1;
    const verdict = {
      verdict_id: nextId("vrd"),
      claim_id,
      version,
      verdict: input.verdict,
      evidence_refs: input.evidence_refs,
      applicable_scope: input.applicable_scope,
      reviewer: input.reviewer,
      reviewed_at: iso(),
    };
    store.verdicts.set(verdict.verdict_id, verdict);
    claim.verdict_ids.push(verdict.verdict_id);
    claim.status = "REVIEWED";
    emit("EVIDENCE_REVIEWED", claim_id, { verdict_id: verdict.verdict_id, version, verdict: verdict.verdict });
    return verdict;
  }

  // ---------- 指引版本与重评队列 ----------

  function publishGuideline(input = {}) {
    const problems = [];
    if (!input.version) problems.push("version");
    if (!input.effective_from || Number.isNaN(Date.parse(input.effective_from))) problems.push("effective_from");
    if (problems.length) throw badRequest("指引缺少必要字段", problems);
    if (store.guidelines.some((g) => g.version === input.version)) {
      throw conflict("DUPLICATE_VERSION", `指引版本 ${input.version} 已存在`, { version: input.version });
    }
    const base = effectiveGuideline(store.guidelines, iso()) ?? defaultGuideline();
    const guideline = {
      id: input.id ?? base.id,
      version: input.version,
      effective_from: new Date(Date.parse(input.effective_from)).toISOString(),
      observation_window_hours: input.observation_window_hours ?? base.observation_window_hours,
      delayed_onset_hours: input.delayed_onset_hours ?? base.delayed_onset_hours,
      group_exposure_threshold: input.group_exposure_threshold ?? base.group_exposure_threshold,
      red_flag_symptoms: input.red_flag_symptoms ?? [...base.red_flag_symptoms],
      published_at: iso(),
    };
    store.guidelines.push(guideline);
    store.guidelines.sort((a, b) => Date.parse(a.effective_from) - Date.parse(b.effective_from));
    emit("GUIDELINE_PUBLISHED", guideline.version, { id: guideline.id, effective_from: guideline.effective_from });

    // 指引更新后，尚未结束的个案自动进入重评队列；已结案的不打扰。
    const queuedTasks = [];
    for (const incident of store.incidents.values()) {
      if (incident.status !== "OPEN") continue;
      let task = [...store.reevaluationTasks.values()].find(
        (t) => t.incident_id === incident.incident_id && t.status === "QUEUED",
      );
      if (task) {
        task.to_version = guideline.version;
      } else {
        task = {
          task_id: nextId("req"),
          incident_id: incident.incident_id,
          reason: "GUIDELINE_UPDATED",
          from_version: incident.last_assessed_guideline_version,
          to_version: guideline.version,
          status: "QUEUED",
          created_at: iso(),
          completed_at: null,
          result_assessment_id: null,
        };
        store.reevaluationTasks.set(task.task_id, task);
        emit("REEVALUATION_QUEUED", incident.incident_id, {
          task_id: task.task_id,
          from_version: task.from_version,
          to_version: task.to_version,
        });
      }
      queuedTasks.push(task);
    }
    return { guideline, queued_tasks: queuedTasks };
  }

  function completeReevaluation(task_id, { assessed_by = "duty" } = {}) {
    const task = store.reevaluationTasks.get(task_id);
    if (!task) throw notFound(`重评任务 ${task_id}`);
    if (task.status !== "QUEUED") throw conflict("TASK_NOT_QUEUED", "重评任务不在待处理状态", { task_id });
    const assessment = assessIncident(task.incident_id, { assessed_by });
    task.status = "DONE";
    task.completed_at = iso();
    task.result_assessment_id = assessment.assessment_id;
    return { task, assessment };
  }

  // ---------- 平台/社区更正回传 ----------

  function addCorrection(input = {}) {
    const problems = [];
    if (!input.claim_id) problems.push("claim_id");
    if (!input.platform) problems.push("platform");
    if (!CORRECTION_RESULTS.includes(input.result)) problems.push("result");
    if (problems.length) throw badRequest("更正回传缺少必要字段", problems);
    const claim = store.claims.get(input.claim_id);
    if (!claim) throw notFound(`说法 ${input.claim_id}`);
    const correction = {
      correction_id: nextId("cor"),
      claim_id: claim.claim_id,
      platform: input.platform,
      result: input.result,
      note: input.note ?? null,
      url: input.url ?? null,
      received_at: iso(),
    };
    store.corrections.set(correction.correction_id, correction);
    claim.correction_ids.push(correction.correction_id);
    emit("CORRECTION_ACKNOWLEDGED", claim.claim_id, {
      correction_id: correction.correction_id,
      platform: correction.platform,
      result: correction.result,
    });
    return correction;
  }

  // ---------- 查询与溯源 ----------

  function getReport(report_id) {
    const report = store.reports.get(report_id);
    if (!report) throw notFound(`提交 ${report_id}`);
    return report;
  }

  function listIncidents({ status } = {}) {
    return [...store.incidents.values()].filter((i) => !status || i.status === status);
  }

  function getIncidentView(incident_id) {
    const incident = mustIncident(incident_id);
    return {
      ...incident,
      reports: incidentReports(incident),
      latest_assessment: latestAssessment(incident) ?? null,
      claims: incidentClaimIds(incident).map((id) => store.claims.get(id)),
      pending_reevaluation: [...store.reevaluationTasks.values()].filter(
        (t) => t.incident_id === incident_id && t.status === "QUEUED",
      ),
    };
  }

  function listClaims({ status } = {}) {
    return [...store.claims.values()].filter((c) => !status || c.status === status);
  }

  function getClaimView(claim_id) {
    const claim = store.claims.get(claim_id);
    if (!claim) throw notFound(`说法 ${claim_id}`);
    return {
      ...claim,
      verdicts: claim.verdict_ids.map((id) => store.verdicts.get(id)),
      corrections: claim.correction_ids.map((id) => store.corrections.get(id)),
    };
  }

  function listGuidelines() {
    return [...store.guidelines];
  }

  function listReevaluationTasks({ status } = {}) {
    return [...store.reevaluationTasks.values()].filter((t) => !status || t.status === status);
  }

  function listEvents({ kind, subject_id } = {}) {
    return store.events.filter((e) => (!kind || e.kind === kind) && (!subject_id || e.subject_id === subject_id));
  }

  // 升级溯源：按时间列出评估与升级记录，升级记录展开促成升级的公开信息
  // （说法原文、来源链接、专家判断、平台更正），值班人员可直接追责到条。
  function traceIncident(incident_id) {
    const incident = mustIncident(incident_id);
    const assessments = [...store.assessments.values()]
      .filter((a) => a.incident_id === incident_id)
      .sort((a, b) => Date.parse(a.assessed_at) - Date.parse(b.assessed_at));
    const enrichClaim = (claim_id) => {
      const claim = store.claims.get(claim_id);
      if (!claim) return { claim_id };
      const verdicts = claim.verdict_ids.map((id) => store.verdicts.get(id));
      return {
        claim_id,
        text: claim.text,
        category: claim.category,
        source_links: claim.source_links,
        current_verdict: verdicts.at(-1) ?? null,
        corrections: claim.correction_ids.map((id) => store.corrections.get(id)),
      };
    };
    const escalations = store.events
      .filter((e) => e.kind === "RISK_ESCALATED" && e.subject_id === incident_id)
      .map((e) => ({
        occurred_at: e.occurred_at,
        from_level: e.payload.from_level,
        to_level: e.payload.to_level,
        guideline_version: e.payload.guideline_version,
        assessment_id: e.payload.assessment_id,
        reasons: e.payload.reasons,
        contributing_claims: (e.payload.claim_ids ?? []).map(enrichClaim),
      }));
    return {
      incident_id,
      status: incident.status,
      current_level: incident.current_level,
      guideline_versions_used: [...new Set(assessments.map((a) => a.guideline_version))],
      assessments,
      escalations,
    };
  }

  return {
    store,
    createReport,
    getReport,
    listIncidents,
    getIncidentView,
    assessIncident,
    closeIncident,
    addVerdict,
    publishGuideline,
    listGuidelines,
    listReevaluationTasks,
    completeReevaluation,
    addCorrection,
    listClaims,
    getClaimView,
    listEvents,
    traceIncident,
  };
}
