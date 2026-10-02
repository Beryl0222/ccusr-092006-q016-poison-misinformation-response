// poison_misinformation_response 领域资料的基础结构。
// 本文件同时是后端服务共用的术语表：事件种类、行动级别、说法分类、症状编码等
// 在这里统一定义，业务、运营与研发按同一套术语讨论。

export const EVENT_KINDS = Object.freeze([
  "CLAIM_REPORTED",          // 公众说法首次登记
  "EVIDENCE_REVIEWED",       // 专家对说法作出判断
  "EXPOSURE_LINKED",         // 公众提交并入暴露事件
  "RISK_ESCALATED",          // 事件行动级别上调
  "CORRECTION_ACKNOWLEDGED", // 内容平台/社区回传更正结果
  "GUIDELINE_PUBLISHED",     // 新版指引发布
  "REEVALUATION_QUEUED",     // 未结个案进入重评队列
  "ASSESSMENT_RECORDED",     // 一次行动级别评估落档
  "CASE_CLOSED",             // 事件结案
  "CASE_CLOSE_REJECTED",     // 结案被安全闸门拦截（留痕审计）
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

// 行动级别：系统只依据可观察症状、群体暴露与当时有效指引给出行动建议，
// 不替医生诊断，也不确认蘑菇物种。数组按严重度升序排列。
export const ACTION_LEVELS = Object.freeze([
  "CONTINUE_OBSERVATION", // 持续留观
  "SEEK_IMMEDIATE_CARE",  // 立即就医
  "CONTACT_EMERGENCY",    // 联系急救
]);

export const ACTION_LEVEL_RANK = Object.freeze({
  CONTINUE_OBSERVATION: 1,
  SEEK_IMMEDIATE_CARE: 2,
  CONTACT_EMERGENCY: 3,
});

// 公众说法的分类（误导信息的主要形态）。
export const CLAIM_CATEGORIES = Object.freeze([
  "DETOX_METHOD",           // “高温去毒”等去毒方法类
  "IDENTIFICATION_PROMISE", // “AI识别可食”“大蒜验毒”等鉴别承诺类
  "HOME_REMEDY",            // 民间偏方类
  "OBSERVATION_ADVICE",     // “吐完就没事”等观察建议类
  "OTHER",
]);

// 专家对说法的判断结论。
export const VERDICTS = Object.freeze([
  "REFUTED",              // 驳斥
  "SUPPORTED",            // 支持
  "PARTIALLY_SUPPORTED",  // 部分成立
  "INSUFFICIENT_EVIDENCE",// 证据不足
]);

// 可观察症状编码。分诊只使用这些可观察项，不使用物种推断。
export const SYMPTOM_CODES = Object.freeze([
  "VOMITING",        // 呕吐
  "NAUSEA",          // 恶心
  "DIARRHEA",        // 腹泻
  "ABDOMINAL_PAIN",  // 腹痛
  "DIZZINESS",       // 头晕
  "SWEATING",        // 出汗
  "CONFUSION",       // 意识模糊
  "SEIZURE",         // 抽搐
  "DYSPNEA",         // 呼吸困难
  "JAUNDICE",        // 黄疸
  "OLIGURIA",        // 少尿
  "BLOODY_STOOL",    // 血便
  "SYNCOPE",         // 晕厥
  "OTHER",
]);

// 症状时间线条目的状态。
export const SYMPTOM_STATUS = Object.freeze(["ACTIVE", "RELIEVED"]);

// 内容平台/社区回传的更正结果。
export const CORRECTION_RESULTS = Object.freeze([
  "CORRECTION_PUBLISHED", // 已发布更正
  "CONTENT_REMOVED",      // 内容已下架
  "RATED_FALSE",          // 已标记为不实
]);

export const INCIDENT_STATUS = Object.freeze(["OPEN", "CLOSED"]);
