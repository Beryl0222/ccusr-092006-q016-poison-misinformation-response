// 公众提交：一次来电/上报可携带六类事实，逐类校验、分开落库。
// 这里只做"形态"校验与归一化，合并与分诊在 incidents.js / triage.js 完成。

const SEVERITIES = Object.freeze(["mild", "moderate", "severe"]);

function isIsoDateTime(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

// 归一化联系人，生成合井用的接触指纹（不保存原始号码明文以外的派生形式）。
export function contactFingerprint(contact) {
  const digits = normalizeText(contact).replace(/[^0-9A-Za-z]/g, "").toLowerCase();
  return digits ? `contact:${digits}` : null;
}

// 餐次指纹：日期 + 归一化地点。同一餐次的重复来电据此合并。
export function mealFingerprint(eatenAt, location) {
  const day = isIsoDateTime(eatenAt) ? new Date(eatenAt).toISOString().slice(0, 10) : null;
  const place = normalizeText(location).toLowerCase().replace(/\s+/g, "");
  return day && place ? `meal:${day}|${place}` : null;
}

export function validateSubmission(input) {
  const problems = [];
  if (!input || typeof input !== "object") return ["提交内容必须是对象"];
  if (!normalizeText(input.reporter_contact)) problems.push("reporter_contact");
  if (input.received_at !== undefined && !isIsoDateTime(input.received_at)) problems.push("received_at 必须是时间串");

  for (const [index, sighting] of (input.claim_sightings ?? []).entries()) {
    if (!normalizeText(sighting.raw_text) && !normalizeText(sighting.claim_id)) {
      problems.push(`claim_sightings[${index}] 需要 raw_text 或 claim_id`);
    }
    if (sighting.source_link !== undefined && !normalizeText(sighting.source_link)) {
      problems.push(`claim_sightings[${index}].source_link`);
    }
  }
  for (const [index, clue] of (input.sample_clues ?? []).entries()) {
    if (!normalizeText(clue.description)) problems.push(`sample_clues[${index}].description`);
    // 系统不替医生确认物种：公众或 AI 的识别只能作为线索/说法保存。
    if ("confirmed_species" in clue) problems.push(`sample_clues[${index}] 不允许写入 confirmed_species`);
  }
  for (const [index, meal] of (input.meals ?? []).entries()) {
    if (!isIsoDateTime(meal.eaten_at)) problems.push(`meals[${index}].eaten_at`);
    if (!normalizeText(meal.location)) problems.push(`meals[${index}].location`);
  }
  for (const [index, diner] of (input.co_diners ?? []).entries()) {
    if (!normalizeText(diner.person_ref)) problems.push(`co_diners[${index}].person_ref`);
  }
  for (const [index, entry] of (input.symptoms ?? []).entries()) {
    if (!normalizeText(entry.symptom)) problems.push(`symptoms[${index}].symptom`);
    if (!isIsoDateTime(entry.observed_at)) problems.push(`symptoms[${index}].observed_at`);
    if (entry.severity !== undefined && !SEVERITIES.includes(entry.severity)) {
      problems.push(`symptoms[${index}].severity 只能是 ${SEVERITIES.join("/")}`);
    }
  }
  return problems;
}

// 把一次提交拆成六类记录，分别落库；返回主记录与各分集合记录。
export function splitSubmission(store, input) {
  const receivedAt = input.received_at ? new Date(input.received_at) : store.now();
  const submission = store.insert("submissions", {
    submission_id: store.nextId("sub"),
    reporter_contact: normalizeText(input.reporter_contact),
    contact_key: contactFingerprint(input.reporter_contact),
    received_at: receivedAt.toISOString(),
    incident_id: null, // 由合并逻辑回填
    note: normalizeText(input.note) || null,
  });

  const attach = (record) => ({ ...record, submission_id: submission.submission_id, incident_id: null });

  const sightings = (input.claim_sightings ?? []).map((s) =>
    store.insert("claim_sightings", attach({
      sighting_id: store.nextId("sight"),
      claim_id: normalizeText(s.claim_id) || null,
      raw_text: normalizeText(s.raw_text) || null,
      source_link: normalizeText(s.source_link) || null,
      seen_at: isIsoDateTime(s.seen_at) ? new Date(s.seen_at).toISOString() : null,
    })),
  );

  const sampleClues = (input.sample_clues ?? []).map((c) =>
    store.insert("sample_clues", attach({
      clue_id: store.nextId("clue"),
      description: normalizeText(c.description),
      photo_refs: Array.isArray(c.photo_refs) ? c.photo_refs.map(String) : [],
      found_location: normalizeText(c.found_location) || null,
      kept_sample: Boolean(c.kept_sample),
      // 公众自称的识别结果（含"AI识别可食"）只作为未证实线索保留。
      public_identification: normalizeText(c.public_identification) || null,
    })),
  );

  const meals = (input.meals ?? []).map((m) =>
    store.insert("meals", attach({
      meal_id: store.nextId("meal"),
      eaten_at: new Date(m.eaten_at).toISOString(),
      location: normalizeText(m.location),
      food_items: Array.isArray(m.food_items) ? m.food_items.map(String) : [],
      meal_key: mealFingerprint(m.eaten_at, m.location),
    })),
  );

  const coDiners = (input.co_diners ?? []).map((d) =>
    store.insert("co_diners", attach({
      diner_id: store.nextId("diner"),
      person_ref: normalizeText(d.person_ref),
      relationship: normalizeText(d.relationship) || null,
      also_symptomatic: Boolean(d.also_symptomatic),
    })),
  );

  const symptoms = (input.symptoms ?? []).map((s) =>
    store.insert("symptom_entries", attach({
      symptom_entry_id: store.nextId("sym"),
      person_ref: normalizeText(s.person_ref) || "reporter",
      symptom: normalizeText(s.symptom),
      observed_at: new Date(s.observed_at).toISOString(),
      severity: s.severity ?? "moderate",
      // "relieved" 表示来电人称症状暂缓——只记录，不构成结案依据。
      status: s.status === "relieved" ? "relieved" : "active",
      note: normalizeText(s.note) || null,
    })),
  );

  return { submission, sightings, sampleClues, meals, coDiners, symptoms };
}
