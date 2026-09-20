// poison_misinformation_response 领域资料的基础结构。

export const EVENT_KINDS = Object.freeze(["CLAIM_REPORTED", "EVIDENCE_REVIEWED", "EXPOSURE_LINKED", "RISK_ESCALATED", "CORRECTION_ACKNOWLEDGED"]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
