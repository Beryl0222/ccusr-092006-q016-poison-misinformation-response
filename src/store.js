// 内存存储：交付形态为进程内仓库，便于测试与演示。
// 生产化时按同名集合替换为数据库实现即可，服务层不感知存储细节。

export function createStore() {
  return {
    reports: new Map(),           // report_id -> 公众提交（六类要素分开存放）
    incidents: new Map(),         // incident_id -> 暴露事件
    claims: new Map(),            // claim_id -> 公众说法登记
    verdicts: new Map(),          // verdict_id -> 专家判断（按说法版本递增）
    guidelines: [],               // 指引版本，按 effective_from 升序
    assessments: new Map(),       // assessment_id -> 行动级别评估（只追加）
    corrections: new Map(),       // correction_id -> 平台/社区更正回执
    reevaluationTasks: new Map(), // task_id -> 重评任务
    events: [],                   // 事件日志，只追加，供审计与溯源
    sequences: new Map(),         // id 前缀 -> 计数器
  };
}
