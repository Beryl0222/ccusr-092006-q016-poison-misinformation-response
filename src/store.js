// 内存存储：每类事实一个集合，另有一条追加式事件日志。
// 六类公众提交事实（说法目击、来源链接、样本线索、食用时间、同餐关系、症状时间线）
// 分别落集合，互不混放；事件日志供值班溯源与审计使用。

import { validateEvent } from "./poison_misinformation_response.js";

const COLLECTIONS = Object.freeze([
  "claims", // 误导说法（含来源链接）
  "claim_reviews", // 专家判断（证据、适用范围、版本）
  "corrections", // 平台/社区更正回传
  "submissions", // 提交主记录（仅索引信息，事实细节在下列分集合）
  "claim_sightings", // 公众目击的说法与来源链接
  "sample_clues", // 蘑菇样本线索
  "meals", // 食用时间与地点
  "co_diners", // 同餐关系
  "symptom_entries", // 症状时间线
  "incidents", // 事件
  "assessments", // 分诊评估
  "escalations", // 风险升级（含促成升级的公开信息）
  "guidelines", // 指引版本
  "reevaluation_tasks", // 重评队列
]);

export class Store {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.data = Object.fromEntries(COLLECTIONS.map((name) => [name, []]));
    this.events = [];
    this.counters = new Map();
  }

  nextId(prefix) {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}-${String(next).padStart(4, "0")}`;
  }

  insert(collection, record) {
    if (!this.data[collection]) throw new Error(`未知集合: ${collection}`);
    this.data[collection].push(record);
    return record;
  }

  update(collection, idField, id, patch) {
    const record = this.find(collection, idField, id);
    if (!record) throw new Error(`集合 ${collection} 中不存在 ${id}`);
    Object.assign(record, patch);
    return record;
  }

  find(collection, idField, id) {
    return this.data[collection].find((record) => record[idField] === id) ?? null;
  }

  where(collection, predicate) {
    return this.data[collection].filter(predicate);
  }

  all(collection) {
    return [...this.data[collection]];
  }

  // 追加事件日志；事件本身也走领域约定的最小字段校验。
  appendEvent(kind, subjectId, payload, occurredAt = null) {
    const event = {
      event_id: this.nextId("evt"),
      kind,
      occurred_at: (occurredAt ?? this.now()).toISOString(),
      subject_id: subjectId,
      payload,
    };
    const problems = validateEvent(event);
    if (problems.length > 0) throw new Error(`事件缺少字段: ${problems.join(", ")}`);
    this.events.push(event);
    return event;
  }

  eventsFor(subjectId) {
    return this.events.filter((event) => event.subject_id === subjectId);
  }
}
