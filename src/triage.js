// 分诊规则引擎（纯函数）：只依据可观察症状、群体暴露与当时有效指引
// 给出行动级别。系统不诊断、不确认物种；规则参数全部来自指引版本，
// 每条结论都附带可审计的理由（命中规则 + 涉及的症状条目）。

import { ACTION_LEVEL_RANK } from "./poison_misinformation_response.js";

// 胃肠症状集合，用于“延迟发作”规则。
export const GI_SYMPTOMS = Object.freeze(["VOMITING", "NAUSEA", "DIARRHEA", "ABDOMINAL_PAIN"]);

const HOUR_MS = 3_600_000;
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {object} input
 * @param {string|null} input.meal_at  最早一次进食时间（ISO），未知则为 null
 * @param {Array} input.symptoms       事件汇总的全部症状时间线条目
 * @param {object} input.guideline     当时有效的指引版本
 * @returns {{action_level: string, reasons: Array}}
 */
export function evaluateTriage({ meal_at, symptoms, guideline }) {
  let level = "CONTINUE_OBSERVATION";
  const reasons = [];
  const raise = (to, reason) => {
    if (ACTION_LEVEL_RANK[to] > ACTION_LEVEL_RANK[level]) level = to;
    reasons.push(reason);
  };

  // 规则一：任一红旗症状处于活动期 → 联系急救。
  // 已缓解（RELIEVED）的红旗症状不再触发本规则，但不影响结案闸门的观察窗要求。
  const activeRedFlags = symptoms.filter(
    (s) => s.status === "ACTIVE" && guideline.red_flag_symptoms.includes(s.symptom),
  );
  if (activeRedFlags.length > 0) {
    raise("CONTACT_EMERGENCY", {
      rule: "RED_FLAG_SYMPTOM",
      symptom_ids: activeRedFlags.map((s) => s.symptom_id ?? s.id),
    });
  }

  // 规则二：餐后延迟出现的胃肠症状 → 立即就医。
  if (meal_at) {
    const mealTime = Date.parse(meal_at);
    for (const s of symptoms) {
      if (!GI_SYMPTOMS.includes(s.symptom)) continue;
      const onsetHours = (Date.parse(s.observed_at) - mealTime) / HOUR_MS;
      if (onsetHours >= guideline.delayed_onset_hours) {
        raise("SEEK_IMMEDIATE_CARE", {
          rule: "DELAYED_ONSET",
          symptom_ids: [s.symptom_id ?? s.id],
          onset_hours: round1(onsetHours),
          threshold_hours: guideline.delayed_onset_hours,
        });
      }
    }
  }

  // 规则三：同餐出现症状人数达到群体暴露阈值 → 立即就医。
  // 有过症状记录的人都计入，症状缓解不改变暴露事实。
  const symptomaticPersons = new Set(symptoms.map((s) => s.person_ref)).size;
  if (symptomaticPersons >= guideline.group_exposure_threshold) {
    raise("SEEK_IMMEDIATE_CARE", {
      rule: "GROUP_EXPOSURE",
      symptomatic_persons: symptomaticPersons,
      threshold: guideline.group_exposure_threshold,
    });
  }

  if (reasons.length === 0) {
    reasons.push({ rule: "DEFAULT_OBSERVATION", observation_window_hours: guideline.observation_window_hours });
  }
  return { action_level: level, reasons };
}
