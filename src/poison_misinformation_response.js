// poison_misinformation_response 领域资料的基础结构。
//
// 事件种类约定：前五种为最初资料约定，后续种类为后端运行所需追加。
// 所有事件都写入追加式事件日志，值班溯源与重评队列均以此为准。

export const EVENT_KINDS = Object.freeze([
  // 初始资料约定
  "CLAIM_REPORTED", // 公开说法被登记或被公众目击
  "EVIDENCE_REVIEWED", // 专家对说法作出带证据的判断
  "EXPOSURE_LINKED", // 提交被关联/合并进既有事件
  "RISK_ESCALATED", // 事件行动级别上调
  "CORRECTION_ACKNOWLEDGED", // 平台或社区回传更正结果
  // 后端运行追加
  "SUBMISSION_RECEIVED", // 公众提交落库（六类事实分开保存）
  "INCIDENT_OPENED", // 新事件开立
  "ASSESSMENT_RECORDED", // 一次分诊评估落档
  "GUIDELINE_PUBLISHED", // 新指引版本发布并生效
  "REEVALUATION_QUEUED", // 未结案个案进入重评队列
  "INCIDENT_CLOSED", // 事件结案（必须通过观察窗校验）
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
