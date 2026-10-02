// 种子指引：让服务启动即可分诊。数值为演示用占位，实际参数由疾控专家定稿。

export const SEED_GUIDELINE_V1 = {
  version: "2026.1",
  note: "初始版本（演示数据）",
  rules: {
    emergency_symptoms: ["意识障碍", "抽搐", "呼吸困难", "黄疸", "少尿"],
    urgent_symptoms: ["持续呕吐", "剧烈腹痛", "腹泻", "视物模糊", "大量出汗"],
    group_exposure_threshold: 2,
    observation_hours_after_last_symptom: 48,
    observation_hours_after_meal: 72,
  },
};

export function seedGuidelines(service) {
  service.publishGuideline(SEED_GUIDELINE_V1);
}
