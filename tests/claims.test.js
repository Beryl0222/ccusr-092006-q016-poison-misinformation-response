import assert from "node:assert/strict";
import test from "node:test";
import { makeService, BASE_SUBMISSION } from "./helpers.js";

test("专家判断带证据、适用范围与递增版本，最新判断决定说法状态", () => {
  const { service } = makeService();
  const claim = service.registerClaim({ text: "大蒜变黑说明蘑菇有毒", category: "detection" }).claim;
  assert.equal(claim.status, "UNDER_REVIEW");

  const r1 = service.addClaimReview(claim.claim_id, {
    reviewer: "毒理专家组",
    verdict: "INCONCLUSIVE",
    evidence: [{ title: "地区监测年报", reference: "CDC-2025-011" }],
    applicability: "仅限本地区常见种",
  });
  assert.equal(r1.review.version, 1);
  assert.equal(service.claimDetail(claim.claim_id).claim.status, "INCONCLUSIVE");

  const r2 = service.addClaimReview(claim.claim_id, {
    reviewer: "毒理专家组",
    verdict: "REFUTED",
    evidence: [{ title: "毒理综述", reference: "DOI:10.xxxx/yyy", note: "大蒜变色与毒素无关" }],
    applicability: "全部野生蘑菇",
  });
  assert.equal(r2.review.version, 2);
  const detail = service.claimDetail(claim.claim_id);
  assert.equal(detail.claim.status, "REFUTED");
  assert.equal(detail.claim.reviews.length, 2);
  assert.equal(detail.claim.reviews[1].applicability, "全部野生蘑菇");
});

test("判断必须带证据与适用范围", () => {
  const { service } = makeService();
  const claim = service.registerClaim({ text: "AI 识别可食", category: "identification" }).claim;
  const bad = service.addClaimReview(claim.claim_id, { reviewer: "专家组", verdict: "REFUTED" });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(), /evidence/);
  assert.match(bad.problems.join(), /applicability/);
});

test("平台与社区回传更正结果并留痕", () => {
  const { service } = makeService();
  const claim = service.registerClaim({ text: "高温去毒", category: "detox" }).claim;

  const c1 = service.addClaimCorrection(claim.claim_id, {
    channel: "platform",
    result: "LABELLED",
    detail: "短视频已加误导提示",
  });
  assert.equal(c1.ok, true);
  const c2 = service.addClaimCorrection(claim.claim_id, { channel: "community", result: "REFUTED_POST" });
  assert.equal(c2.ok, true);

  const detail = service.claimDetail(claim.claim_id);
  assert.equal(detail.claim.corrections.length, 2);
  const events = service.store.eventsFor(claim.claim_id);
  assert.equal(events.filter((e) => e.kind === "CORRECTION_ACKNOWLEDGED").length, 2);

  const invalid = service.addClaimCorrection(claim.claim_id, { channel: "sms", result: "LABELLED" });
  assert.equal(invalid.ok, false);
});

test("说法影响面：列出它促成升级的事件", () => {
  const { service } = makeService();
  const claim = service.registerClaim({ text: "银器验毒", category: "detection" }).claim;

  const first = service.receiveSubmission({
    ...BASE_SUBMISSION,
    claim_sightings: [{ claim_id: claim.claim_id }],
    symptoms: [{ symptom: "头晕", observed_at: "2026-09-20T02:00:00+08:00" }],
  });
  service.receiveSubmission({
    reporter_contact: "138-0000-0001",
    symptoms: [{ symptom: "意识障碍", observed_at: "2026-09-20T05:00:00+08:00" }],
  });

  const impact = service.claimImpact(claim.claim_id);
  assert.equal(impact.escalations.length, 1);
  assert.equal(impact.escalations[0].incident_id, first.incident_id);
  assert.equal(impact.escalations[0].to_level, "CONTACT_EMERGENCY");
});
