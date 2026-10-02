import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTriage } from "../src/triage.js";

const guideline = {
  observation_window_hours: 24,
  delayed_onset_hours: 6,
  group_exposure_threshold: 2,
  red_flag_symptoms: ["CONFUSION", "SEIZURE"],
};

const meal_at = "2026-10-01T18:00:00+08:00";
const sym = (over = {}) => ({
  symptom_id: "sym-x",
  person_ref: "p1",
  symptom: "VOMITING",
  observed_at: "2026-10-01T21:00:00+08:00",
  status: "ACTIVE",
  ...over,
});

test("红旗症状处于活动期 → 联系急救", () => {
  const r = evaluateTriage({ meal_at, symptoms: [sym({ symptom: "CONFUSION" })], guideline });
  assert.equal(r.action_level, "CONTACT_EMERGENCY");
  assert.equal(r.reasons[0].rule, "RED_FLAG_SYMPTOM");
});

test("餐后延迟出现的胃肠症状 → 立即就医", () => {
  const r = evaluateTriage({ meal_at, symptoms: [sym({ observed_at: "2026-10-02T01:00:00+08:00" })], guideline });
  assert.equal(r.action_level, "SEEK_IMMEDIATE_CARE");
  assert.ok(r.reasons.some((x) => x.rule === "DELAYED_ONSET" && x.onset_hours === 7));
});

test("同餐症状人数达到阈值 → 立即就医", () => {
  const r = evaluateTriage({
    meal_at,
    symptoms: [sym(), sym({ symptom_id: "sym-y", person_ref: "p2", symptom: "DIARRHEA" })],
    guideline,
  });
  assert.equal(r.action_level, "SEEK_IMMEDIATE_CARE");
  assert.ok(r.reasons.some((x) => x.rule === "GROUP_EXPOSURE" && x.symptomatic_persons === 2));
});

test("轻微且非延迟 → 持续留观", () => {
  const r = evaluateTriage({ meal_at, symptoms: [sym()], guideline });
  assert.equal(r.action_level, "CONTINUE_OBSERVATION");
  assert.equal(r.reasons[0].rule, "DEFAULT_OBSERVATION");
});

test("已缓解的红旗症状不再触发急救，但暴露事实保留", () => {
  const r = evaluateTriage({ meal_at, symptoms: [sym({ symptom: "CONFUSION", status: "RELIEVED" })], guideline });
  assert.equal(r.action_level, "CONTINUE_OBSERVATION");
});

test("进食时间未知时跳过延迟发作规则", () => {
  const r = evaluateTriage({ meal_at: null, symptoms: [sym({ observed_at: "2026-10-02T05:00:00+08:00" })], guideline });
  assert.equal(r.action_level, "CONTINUE_OBSERVATION");
});
