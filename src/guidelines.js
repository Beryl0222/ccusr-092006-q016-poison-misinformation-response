// 指引版本：分诊规则的全部参数都来自“当时有效”的指引版本，
// 评估记录会带上所用版本号，指引更新后未结个案进入重评队列。

export function defaultGuideline() {
  return {
    id: "mushroom-exposure-triage",
    version: "2026.1",
    effective_from: "2026-01-01T00:00:00.000Z",
    // 最后一次症状（含“已缓解”记录）之后需要继续留观的小时数，未满不得结案。
    observation_window_hours: 24,
    // 餐后多少小时才出现的胃肠症状视为“延迟发作”，提示更高风险。
    delayed_onset_hours: 6,
    // 同餐出现症状人数达到该阈值即构成群体暴露。
    group_exposure_threshold: 2,
    // 红旗症状：任一处于活动期即建议联系急救。
    red_flag_symptoms: ["CONFUSION", "SEIZURE", "DYSPNEA", "JAUNDICE", "OLIGURIA", "BLOODY_STOOL", "SYNCOPE"],
  };
}

// 取 at 时刻生效的指引：effective_from 不晚于 at 的最新一版。
export function effectiveGuideline(guidelines, at) {
  const t = Date.parse(at);
  let current = null;
  for (const g of guidelines) {
    if (Date.parse(g.effective_from) <= t && (!current || Date.parse(g.effective_from) > Date.parse(current.effective_from))) {
      current = g;
    }
  }
  return current;
}
