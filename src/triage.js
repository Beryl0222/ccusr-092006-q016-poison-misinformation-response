// 分诊引擎：纯函数，只依据可观察症状、群体暴露与当时有效指引给出行动级别。
// 明确边界：本引擎不确认物种、不下诊断；样本线索仅供专业人员后续研判。

import { levelRank } from "./guidelines.js";

export const SPECIES_DISCLAIMER = "系统不确认物种；样本线索仅记录待专业人员研判";

function normalizeSymptom(text) {
  return String(text ?? "").trim();
}

// 汇总一次评估所需的可观察输入。
export function summarizeExposure({ symptomEntries, coDiners }) {
  const activeEntries = symptomEntries.filter((entry) => entry.status !== "relieved");
  const relievedEntries = symptomEntries.filter((entry) => entry.status === "relieved");
  const symptomaticPersons = new Set(activeEntries.map((entry) => entry.person_ref));
  // 同餐者被报告"也出现症状"也计入群体暴露，即使本人尚未直接来电。
  for (const diner of coDiners) {
    if (diner.also_symptomatic) symptomaticPersons.add(diner.person_ref);
  }
  return {
    activeSymptoms: [...new Set(activeEntries.map((entry) => normalizeSymptom(entry.symptom)))],
    symptomaticPersonCount: symptomaticPersons.size,
    hasRelievedOnly: activeEntries.length === 0 && relievedEntries.length > 0,
    latestSymptomAt: symptomEntries
      .map((entry) => new Date(entry.observed_at).getTime())
      .reduce((max, t) => Math.max(max, t), 0) || null,
  };
}

// 依据指引规则给出行动级别与触发理由。
export function assess({ symptomEntries, coDiners, guideline }) {
  if (!guideline) throw new Error("缺少有效指引，无法分诊");
  const summary = summarizeExposure({ symptomEntries, coDiners });
  const rules = guideline.rules;
  const rationale = [];

  const emergencyHits = summary.activeSymptoms.filter((s) => rules.emergency_symptoms.includes(s));
  if (emergencyHits.length > 0) {
    rationale.push(`出现急救级症状: ${emergencyHits.join("、")}`);
    return buildResult("CONTACT_EMERGENCY", summary, guideline, rationale);
  }

  const urgentHits = summary.activeSymptoms.filter((s) => rules.urgent_symptoms.includes(s));
  if (urgentHits.length > 0) {
    rationale.push(`出现需立即就医症状: ${urgentHits.join("、")}`);
    return buildResult("SEEK_IMMEDIATE_CARE", summary, guideline, rationale);
  }

  if (summary.symptomaticPersonCount >= rules.group_exposure_threshold) {
    rationale.push(
      `群体暴露: ${summary.symptomaticPersonCount} 人出现症状，达到阈值 ${rules.group_exposure_threshold}`,
    );
    return buildResult("SEEK_IMMEDIATE_CARE", summary, guideline, rationale);
  }

  if (summary.hasRelievedOnly) {
    // 症状暂缓不等于安全：迟发型毒素存在"假愈期"，维持留观。
    rationale.push("症状报告暂缓但仍在观察窗内，维持留观（警惕假愈期）");
  } else if (summary.activeSymptoms.length > 0) {
    rationale.push("症状未达就医阈值，持续留观");
  } else {
    rationale.push("暂无活动症状，按指引持续留观至观察窗结束");
  }
  return buildResult("CONTINUE_OBSERVATION", summary, guideline, rationale);
}

function buildResult(level, summary, guideline, rationale) {
  return {
    action_level: level,
    level_rank: levelRank(level),
    guideline_version: guideline.version,
    rationale,
    inputs_snapshot: {
      active_symptoms: summary.activeSymptoms,
      symptomatic_person_count: summary.symptomaticPersonCount,
      has_relieved_only: summary.hasRelievedOnly,
    },
    species_note: SPECIES_DISCLAIMER,
  };
}

// 结案校验：症状暂缓不能直接结案，必须同时满足两个观察窗。
// 返回 { closable, reasons, earliest_close_at }。
export function evaluateClosure({ incident, symptomEntries, meals, guideline, now }) {
  if (incident.status === "CLOSED") {
    return { closable: false, reasons: ["事件已结案"], earliest_close_at: null };
  }
  const reasons = [];
  const candidates = [];
  const nowMs = new Date(now).getTime();

  const latestSymptomMs = symptomEntries
    .map((entry) => new Date(entry.observed_at).getTime())
    .reduce((max, t) => Math.max(max, t), 0);
  if (latestSymptomMs > 0) {
    const until = latestSymptomMs + guideline.rules.observation_hours_after_last_symptom * 3600_000;
    candidates.push(until);
    if (nowMs < until) {
      reasons.push(
        `末次症状后未满 ${guideline.rules.observation_hours_after_last_symptom} 小时观察期（症状暂缓不构成结案条件）`,
      );
    }
  }

  const latestMealMs = meals
    .map((meal) => new Date(meal.eaten_at).getTime())
    .reduce((max, t) => Math.max(max, t), 0);
  if (latestMealMs > 0) {
    const until = latestMealMs + guideline.rules.observation_hours_after_meal * 3600_000;
    candidates.push(until);
    if (nowMs < until) {
      reasons.push(`末次食用后未覆盖 ${guideline.rules.observation_hours_after_meal} 小时迟发窗口`);
    }
  }

  const activeEmergency = symptomEntries.some(
    (entry) => entry.status !== "relieved" && guideline.rules.emergency_symptoms.includes(normalizeSymptom(entry.symptom)),
  );
  if (activeEmergency) reasons.push("仍存在未缓解的急救级症状");

  const earliest = candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : null;
  return { closable: reasons.length === 0, reasons, earliest_close_at: earliest };
}
