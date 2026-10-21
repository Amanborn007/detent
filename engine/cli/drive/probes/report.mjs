// Result shape shared by every probe. Values are primitives only, so a probe
// cannot accidentally carry file contents or env values into the report.
export const STATUSES = ["pass", "fail", "inconclusive", "skipped"];
export const REPORT_SCHEMA = "detent-drive-probes-v1";

const MAX_VALUE = 200;

export function result({ probe, expected, actual, status, note }) {
  const r = { probe, expected, actual, pass: status === "pass", status };
  if (note !== undefined) r.note = note;
  validateResult(r);
  return r;
}

export function validateResult(r) {
  if (!r || typeof r !== "object") throw new Error("probe result must be an object");
  if (typeof r.probe !== "string" || !r.probe) throw new Error("probe result needs a probe id");
  for (const k of ["expected", "actual"]) {
    const v = r[k];
    const ok = typeof v === "boolean" || typeof v === "number" ||
      (typeof v === "string" && v.length <= MAX_VALUE);
    if (!ok) throw new Error(`probe ${r.probe}: ${k} must be a boolean, number or string up to ${MAX_VALUE} chars`);
  }
  if (!STATUSES.includes(r.status)) throw new Error(`probe ${r.probe}: bad status ${r.status}`);
  if (typeof r.pass !== "boolean" || r.pass !== (r.status === "pass")) {
    throw new Error(`probe ${r.probe}: pass must equal status === "pass"`);
  }
  if (r.note !== undefined && (typeof r.note !== "string" || r.note.length > 300)) {
    throw new Error(`probe ${r.probe}: note must be a string up to 300 chars`);
  }
  return r;
}

export function summarize(results) {
  const s = { total: results.length, pass: 0, fail: 0, inconclusive: 0, skipped: 0 };
  for (const r of results) s[r.status]++;
  s.ok = s.fail === 0;
  return s;
}

export function buildReport({ results, meta = {}, now = new Date() }) {
  results.forEach(validateResult);
  return { schema: REPORT_SCHEMA, generated_at: now.toISOString(), meta, summary: summarize(results), results };
}
