import assert from "node:assert/strict";
import test from "node:test";
import { assess, evaluateClosure, SPECIES_DISCLAIMER } from "../src/triage.js";
import { SEED_GUIDELINE_V1 } from "../src/seed.js";

const guideline = { version: SEED_GUIDELINE_V1.version, rules: SEED_GUIDELINE_V1.rules };

function symptom(symptom, overrides = {}) {
  return { person_ref: "reporter", symptom, observed_at: "2026-09-20T02:00:00+08:00", status: "active", ...overrides };
}

test("出现急救级症状 → 联系急救", () => {
  const result = assess({ symptomEntries: [symptom("意识障碍")], coDiners: [], guideline });
  assert.equal(result.action_level, "CONTACT_EMERGENCY");
  assert.equal(result.guideline_version, "2026.1");
});

test("出现需立即就医症状 → 立即就医", () => {
  const result = assess({ symptomEntries: [symptom("持续呕吐")], coDiners: [], guideline });
  assert.equal(result.action_level, "SEEK_IMMEDIATE_CARE");
});

test("同餐者陆续出现症状达到群体阈值 → 立即就医", () => {
  const result = assess({
    symptomEntries: [symptom("头晕")],
    coDiners: [{ person_ref: "家人甲", also_symptomatic: true }],
    guideline,
  });
  assert.equal(result.action_level, "SEEK_IMMEDIATE_CARE");
  assert.match(result.rationale.join(), /群体暴露/);
});

test("轻微症状未达阈值 → 持续留观", () => {
  const result = assess({ symptomEntries: [symptom("头晕")], coDiners: [], guideline });
  assert.equal(result.action_level, "CONTINUE_OBSERVATION");
});

test("症状暂缓不等于安全：全部暂缓仍维持留观并提示假愈期", () => {
  const result = assess({
    symptomEntries: [symptom("持续呕吐", { status: "relieved" })],
    coDiners: [],
    guideline,
  });
  assert.equal(result.action_level, "CONTINUE_OBSERVATION");
  assert.match(result.rationale.join(), /假愈期/);
});

test("评估结果不确认物种", () => {
  const result = assess({ symptomEntries: [symptom("头晕")], coDiners: [], guideline });
  assert.equal(result.species_note, SPECIES_DISCLAIMER);
  assert.ok(!("species" in result) && !("confirmed_species" in result));
});

test("结案观察窗：末次症状与末次食用都要覆盖", () => {
  const incident = { status: "MONITORING" };
  const symptoms = [symptom("头晕")]; // 2026-09-20T02:00+08:00
  const meals = [{ eaten_at: "2026-09-19T18:30:00+08:00" }];

  // 症状后 24 小时：两个窗口都没过。
  let verdict = evaluateClosure({
    incident,
    symptomEntries: symptoms,
    meals,
    guideline,
    now: "2026-09-21T02:00:00+08:00",
  });
  assert.equal(verdict.closable, false);
  assert.equal(verdict.reasons.length, 2);

  // 症状后 49 小时、食用后约 55.5 小时：症状窗过了，迟发窗没过。
  verdict = evaluateClosure({
    incident,
    symptomEntries: symptoms,
    meals,
    guideline,
    now: "2026-09-22T03:00:00+08:00",
  });
  assert.equal(verdict.closable, false);
  assert.equal(verdict.reasons.length, 1);
  assert.match(verdict.reasons[0], /迟发窗口/);

  // 食用后 73 小时：两个窗口都过。
  verdict = evaluateClosure({
    incident,
    symptomEntries: symptoms,
    meals,
    guideline,
    now: "2026-09-22T19:31:00+08:00",
  });
  assert.equal(verdict.closable, true);
});
