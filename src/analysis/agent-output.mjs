// Checks what an agent wrote when it ran in GitHub Actions (claude-code-action on the Claude subscription) instead of the
// Python runtime. The same limits as the Python tools (engines/python/seo_engine/tools.py propose_topic and save_report),
// so both routes feed the same files. The agent's output is untrusted text: it is length-checked and stored, never run.
export const PAGE_TYPES = ["guide", "comparison", "use-case", "glossary", "service", "tool"];
const LIMITS = { title: [8, 120], primaryQuery: [3, 120], why: [20, 1200], evidence: [10, 1500] };

/** Valid proposals from a parsed JSON value, plus the reasons others were dropped. At most `max`. */
export function validateProposals(value, { max = 3 } = {}) {
  const ok = [], dropped = [];
  for (const [i, it] of (Array.isArray(value) ? value : []).entries()) {
    if (!it || typeof it !== "object") { dropped.push(`#${i + 1}: not an object`); continue; }
    const p = { pageType: PAGE_TYPES.includes(it.pageType) ? it.pageType : "guide" };
    let bad = "";
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      const v = String(it[k] ?? "").replace(/\s+/g, " ").trim();
      if (v.length < lo || v.length > hi) { bad = `${k} must be ${lo} to ${hi} characters`; break; }
      p[k] = v;
    }
    if (bad) dropped.push(`#${i + 1}: ${bad}`);
    else if (ok.length >= max) dropped.push(`#${i + 1}: at most ${max} proposals per run`);
    else ok.push(p);
  }
  if (!Array.isArray(value)) dropped.push("the proposals file is not a JSON array");
  return { ok, dropped };
}

/** Adds new proposals to the saved list (same shape the Python runtime writes); titles already there are skipped. */
export function mergeProposals(current, items, { agent, date }) {
  const list = Array.isArray(current) ? [...current] : [];
  const seen = new Set(list.map((x) => String(x?.title || "").toLowerCase()));
  let added = 0;
  for (const it of items) {
    if (seen.has(it.title.toLowerCase())) continue;
    list.push({ ...it, agent, date, status: "new" });
    seen.add(it.title.toLowerCase());
    added++;
  }
  return { list, added };
}

/** A report worth posting: at least 100 characters, capped at 40,000 (as save_report). Null when too short. */
export function cleanReport(markdown) {
  const t = String(markdown || "").trim();
  return t.length < 100 ? null : t.slice(0, 40000);
}
