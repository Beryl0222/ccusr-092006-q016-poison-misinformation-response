// 事件生命周期：开立、重复来电合并、分诊评估、风险升级留痕、结案。
// 升级记录会带上"哪条公开信息促成了升级"，供值班人员溯源。

import { assess, evaluateClosure } from "./triage.js";
import { currentGuideline, levelRank } from "./guidelines.js";

const OPEN_STATUSES = Object.freeze(["OPEN", "MONITORING", "ESCALATED"]);

export function incidentFacts(store, incidentId) {
  return {
    sightings: store.where("claim_sightings", (s) => s.incident_id === incidentId),
    sampleClues: store.where("sample_clues", (c) => c.incident_id === incidentId),
    meals: store.where("meals", (m) => m.incident_id === incidentId),
    coDiners: store.where("co_diners", (d) => d.incident_id === incidentId),
    symptoms: store.where("symptom_entries", (s) => s.incident_id === incidentId),
  };
}

// 重复来电合并：共享联系人指纹或餐次指纹，即并入同一未结案事件。
export function findMergeTarget(store, split) {
  const keys = new Set();
  if (split.submission.contact_key) keys.add(split.submission.contact_key);
  for (const meal of split.meals) if (meal.meal_key) keys.add(meal.meal_key);
  if (keys.size === 0) return null;

  const openIncidents = store.where("incidents", (i) => OPEN_STATUSES.includes(i.status));
  for (const incident of openIncidents) {
    if (incident.contact_keys.some((k) => keys.has(k)) || incident.meal_keys.some((k) => keys.has(k))) {
      return incident;
    }
  }
  return null;
}

function attachToIncident(store, split, incidentId) {
  const collections = [
    ["submissions", split.submission],
    ["claim_sightings", split.sightings],
    ["sample_clues", split.sampleClues],
    ["meals", split.meals],
    ["co_diners", split.coDiners],
    ["symptom_entries", split.symptoms],
  ];
  for (const [, records] of collections) {
    for (const record of Array.isArray(records) ? records : [records]) {
      record.incident_id = incidentId;
    }
  }
}

function refreshKeys(incident, split) {
  if (split.submission.contact_key && !incident.contact_keys.includes(split.submission.contact_key)) {
    incident.contact_keys.push(split.submission.contact_key);
  }
  for (const meal of split.meals) {
    if (meal.meal_key && !incident.meal_keys.includes(meal.meal_key)) incident.meal_keys.push(meal.meal_key);
  }
}

// 接收一次提交：分存落库 → 合并或开立事件 → 按当时有效指引分诊 → 必要时升级留痕。
export function intakeSubmission(store, split) {
  const target = findMergeTarget(store, split);
  let incident;
  let merged;

  if (target) {
    incident = target;
    merged = true;
    attachToIncident(store, split, incident.incident_id);
    refreshKeys(incident, split);
    store.appendEvent("EXPOSURE_LINKED", incident.incident_id, {
      submission_id: split.submission.submission_id,
      matched_keys: [
        ...[split.submission.contact_key].filter((k) => k && incident.contact_keys.includes(k)),
        ...split.meals.map((m) => m.meal_key).filter((k) => k && incident.meal_keys.includes(k)),
      ],
    });
  } else {
    incident = store.insert("incidents", {
      incident_id: store.nextId("inc"),
      status: "OPEN",
      opened_at: store.now().toISOString(),
      contact_keys: [],
      meal_keys: [],
      closed_at: null,
      closure_reason: null,
    });
    merged = false;
    attachToIncident(store, split, incident.incident_id);
    refreshKeys(incident, split);
    store.appendEvent("INCIDENT_OPENED", incident.incident_id, {
      submission_id: split.submission.submission_id,
    });
  }
  store.appendEvent("SUBMISSION_RECEIVED", incident.incident_id, {
    submission_id: split.submission.submission_id,
    merged,
    fact_counts: {
      claim_sightings: split.sightings.length,
      sample_clues: split.sampleClues.length,
      meals: split.meals.length,
      co_diners: split.coDiners.length,
      symptoms: split.symptoms.length,
    },
  });

  const assessment = recordAssessment(store, incident, merged ? "NEW_SUBMISSION_MERGED" : "INITIAL");
  return { incident, merged, assessment };
}

// 用当时有效指引对事件做一次评估并落档；级别上调时记录升级与促成说法。
export function recordAssessment(store, incident, trigger, guideline = null) {
  const effective = guideline ?? currentGuideline(store.all("guidelines"), store.now());
  const facts = incidentFacts(store, incident.incident_id);
  const result = assess({ symptomEntries: facts.symptoms, coDiners: facts.coDiners, guideline: effective });

  const previous = store
    .where("assessments", (a) => a.incident_id === incident.incident_id)
    .sort((a, b) => b.assessed_at.localeCompare(a.assessed_at))[0];

  const assessment = store.insert("assessments", {
    assessment_id: store.nextId("asm"),
    incident_id: incident.incident_id,
    trigger,
    action_level: result.action_level,
    guideline_version: result.guideline_version,
    rationale: result.rationale,
    inputs_snapshot: result.inputs_snapshot,
    species_note: result.species_note,
    assessed_at: store.now().toISOString(),
  });
  store.appendEvent("ASSESSMENT_RECORDED", incident.incident_id, {
    assessment_id: assessment.assessment_id,
    action_level: assessment.action_level,
    guideline_version: assessment.guideline_version,
    trigger,
  });

  if (previous && levelRank(assessment.action_level) > levelRank(previous.action_level)) {
    recordEscalation(store, incident, previous, assessment, trigger);
  }
  if (incident.status === "OPEN") incident.status = "MONITORING";
  return assessment;
}

function recordEscalation(store, incident, previous, current, trigger) {
  // 促成升级的公开信息：截至当前评估，本事件各次提交目击到的说法。
  const contributing = store
    .where("claim_sightings", (s) => s.incident_id === incident.incident_id)
    .map((s) => s.claim_id ?? s.raw_text)
    .filter(Boolean);
  const escalation = store.insert("escalations", {
    escalation_id: store.nextId("esc"),
    incident_id: incident.incident_id,
    from_level: previous.action_level,
    to_level: current.action_level,
    trigger,
    guideline_version: current.guideline_version,
    contributing_claims: [...new Set(contributing)],
    created_at: store.now().toISOString(),
  });
  incident.status = "ESCALATED";
  store.appendEvent("RISK_ESCALATED", incident.incident_id, {
    escalation_id: escalation.escalation_id,
    from_level: escalation.from_level,
    to_level: escalation.to_level,
    contributing_claims: escalation.contributing_claims,
  });
  return escalation;
}

// 结案：必须通过观察窗校验；症状暂缓本身永远不够。
export function closeIncident(store, incidentId, { reason, now = null } = {}) {
  const incident = store.find("incidents", "incident_id", incidentId);
  if (!incident) return { notFound: true };
  const guideline = currentGuideline(store.all("guidelines"), now ?? store.now());
  const facts = incidentFacts(store, incidentId);
  const verdict = evaluateClosure({
    incident,
    symptomEntries: facts.symptoms,
    meals: facts.meals,
    guideline,
    now: now ?? store.now(),
  });
  if (!verdict.closable) return { rejected: true, ...verdict };

  incident.status = "CLOSED";
  incident.closed_at = (now ?? store.now()).toISOString();
  incident.closure_reason = String(reason ?? "").trim() || "观察窗届满且无活动症状";
  store.appendEvent("INCIDENT_CLOSED", incidentId, {
    closure_reason: incident.closure_reason,
    guideline_version: guideline.version,
  });
  return { closed: true, incident };
}

// 值班溯源：事件时间线 + 每次升级由哪些公开信息促成（含说法当前研判状态）。
export function incidentTrace(store, incidentId) {
  const incident = store.find("incidents", "incident_id", incidentId);
  if (!incident) return null;
  const escalations = store
    .where("escalations", (e) => e.incident_id === incidentId)
    .map((e) => ({
      ...e,
      contributing_claims: e.contributing_claims.map((ref) => {
        const claim = store.find("claims", "claim_id", ref);
        return claim
          ? { claim_id: claim.claim_id, text: claim.text, status: claim.status }
          : { claim_id: null, raw_text: ref, status: "UNREGISTERED" };
      }),
    }));
  return {
    incident,
    assessments: store.where("assessments", (a) => a.incident_id === incidentId),
    escalations,
    events: store.eventsFor(incidentId),
  };
}
