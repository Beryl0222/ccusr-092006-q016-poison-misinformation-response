// 指引版本管理：分诊规则随版本演进，评估必须引用"当时有效"的版本。
// 发布新版本不会改写历史评估，只会让未结案个案进入重评队列（见 service.js）。

export const ACTION_LEVELS = Object.freeze([
  "CONTINUE_OBSERVATION", // 持续留观
  "SEEK_IMMEDIATE_CARE", // 立即就医
  "CONTACT_EMERGENCY", // 联系急救
]);

// 级别可比较，便于判断"升级"。
export function levelRank(level) {
  const rank = ACTION_LEVELS.indexOf(level);
  if (rank === -1) throw new Error(`未知行动级别: ${level}`);
  return rank;
}

const REQUIRED_RULE_KEYS = Object.freeze([
  "emergency_symptoms", // 任一出现即联系急救
  "urgent_symptoms", // 任一出现即立即就医
  "group_exposure_threshold", // 同餐出现症状人数达到该值即立即就医
  "observation_hours_after_last_symptom", // 末次症状后至少留观小时数
  "observation_hours_after_meal", // 末次食用后至少覆盖的迟发窗口小时数
]);

export function validateGuidelineRules(rules) {
  const problems = [];
  for (const key of REQUIRED_RULE_KEYS) {
    if (!(key in rules)) problems.push(`rules.${key}`);
  }
  for (const key of ["emergency_symptoms", "urgent_symptoms"]) {
    if (key in rules && (!Array.isArray(rules[key]) || rules[key].length === 0)) {
      problems.push(`rules.${key} 必须为非空数组`);
    }
  }
  for (const key of ["group_exposure_threshold", "observation_hours_after_last_symptom", "observation_hours_after_meal"]) {
    if (key in rules && !(Number.isFinite(rules[key]) && rules[key] > 0)) {
      problems.push(`rules.${key} 必须为正数`);
    }
  }
  return problems;
}

// 在给定时刻生效的指引版本：effective_from 不晚于该时刻的最新版本；
// 生效时刻相同（例如同一批次发布）时，后发布的版本优先。
export function guidelineEffectiveAt(guidelines, at) {
  const time = new Date(at).getTime();
  const eligible = guidelines
    .filter((g) => new Date(g.effective_from).getTime() <= time)
    .sort(
      (a, b) =>
        new Date(b.effective_from).getTime() - new Date(a.effective_from).getTime() ||
        b.guideline_id.localeCompare(a.guideline_id),
    );
  return eligible[0] ?? null;
}

export function currentGuideline(guidelines, now) {
  return guidelineEffectiveAt(guidelines, now);
}
