// 误导说法：登记、专家研判（带证据/适用范围/版本）、平台与社区更正回传。
// 说法本身与"公众在哪次提交里目击了它"分开保存（后者在 claim_sightings）。

export const CLAIM_VERDICTS = Object.freeze(["REFUTED", "SUPPORTED", "INCONCLUSIVE"]);
export const CORRECTION_CHANNELS = Object.freeze(["platform", "community"]);
export const CORRECTION_RESULTS = Object.freeze(["LABELLED", "REMOVED", "REFUTED_POST", "NO_ACTION"]);

function text(value) {
  return String(value ?? "").trim();
}

export function validateClaim(input) {
  const problems = [];
  if (!text(input.text)) problems.push("text");
  if (!text(input.category)) problems.push("category");
  return problems;
}

export function validateReview(input) {
  const problems = [];
  if (!text(input.reviewer)) problems.push("reviewer");
  if (!CLAIM_VERDICTS.includes(input.verdict)) problems.push(`verdict 只能是 ${CLAIM_VERDICTS.join("/")}`);
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) problems.push("evidence 至少一条");
  if (!text(input.applicability)) problems.push("applicability（适用范围）");
  return problems;
}

export function validateCorrection(input) {
  const problems = [];
  if (!CORRECTION_CHANNELS.includes(input.channel)) problems.push(`channel 只能是 ${CORRECTION_CHANNELS.join("/")}`);
  if (!CORRECTION_RESULTS.includes(input.result)) problems.push(`result 只能是 ${CORRECTION_RESULTS.join("/")}`);
  return problems;
}

export function registerClaim(store, input) {
  const claim = store.insert("claims", {
    claim_id: store.nextId("claim"),
    text: text(input.text),
    category: text(input.category),
    source_links: (input.source_links ?? []).map((link) => ({
      url: text(link.url),
      platform: text(link.platform) || null,
      first_seen_at: link.first_seen_at ?? null,
    })),
    status: "UNDER_REVIEW",
    created_at: store.now().toISOString(),
  });
  store.appendEvent("CLAIM_REPORTED", claim.claim_id, { text: claim.text, category: claim.category });
  return claim;
}

// 专家判断按版本递增；最新一次判断决定说法当前状态。
export function addReview(store, claimId, input) {
  const claim = store.find("claims", "claim_id", claimId);
  if (!claim) return null;
  const version = store.where("claim_reviews", (r) => r.claim_id === claimId).length + 1;
  const review = store.insert("claim_reviews", {
    review_id: store.nextId("rev"),
    claim_id: claimId,
    version,
    reviewer: text(input.reviewer),
    verdict: input.verdict,
    evidence: input.evidence.map((item) => ({
      title: text(item.title),
      reference: text(item.reference) || null,
      note: text(item.note) || null,
    })),
    applicability: text(input.applicability),
    reviewed_at: (input.reviewed_at ? new Date(input.reviewed_at) : store.now()).toISOString(),
  });
  store.update("claims", "claim_id", claimId, { status: input.verdict });
  store.appendEvent("EVIDENCE_REVIEWED", claimId, {
    review_id: review.review_id,
    version,
    verdict: review.verdict,
  });
  return review;
}

export function addCorrection(store, claimId, input) {
  const claim = store.find("claims", "claim_id", claimId);
  if (!claim) return null;
  const correction = store.insert("corrections", {
    correction_id: store.nextId("corr"),
    claim_id: claimId,
    channel: input.channel,
    result: input.result,
    detail: text(input.detail) || null,
    reported_at: (input.reported_at ? new Date(input.reported_at) : store.now()).toISOString(),
  });
  store.appendEvent("CORRECTION_ACKNOWLEDGED", claimId, {
    correction_id: correction.correction_id,
    channel: correction.channel,
    result: correction.result,
  });
  return correction;
}

export function claimDetail(store, claimId) {
  const claim = store.find("claims", "claim_id", claimId);
  if (!claim) return null;
  return {
    ...claim,
    reviews: store.where("claim_reviews", (r) => r.claim_id === claimId),
    corrections: store.where("corrections", (c) => c.claim_id === claimId),
    sighting_count: store.where("claim_sightings", (s) => s.claim_id === claimId).length,
  };
}
