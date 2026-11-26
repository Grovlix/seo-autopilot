// Style guides (D74): rules a site's writers and reviewers follow for one language. Pure: no files, no network.
// A guide is Markdown. A rule is a "### <ID> [blocking] <title>" heading with an explanation under it; a line starting with
// "Avoid:" lists exact phrases in backticks that `lintText` finds. The built-in guide is knowledge/arabic-msa-style-guide.md;
// a site adds its own file (config styleGuide.files.<lang>), whose rules add to it or, with the same ID, replace one.
import { stripArabicMarks } from "../lib/text.mjs";

const HEADING = /^###\s+([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)\s+(\[blocking\]\s+)?(.+?)\s*$/;
const AR = "\\p{Script=Arabic}";
// MSA-5: a Latin comma, semicolon or question mark directly after an Arabic letter.
export const PUNCTUATION_RULE = "MSA-5";
const LATIN_PUNCT = new RegExp(`(?<=${AR})[,;?]`, "gu");

/** { rules: [{ id, title, blocking, body, avoid, source }] } from a guide's Markdown. Text before the first rule is ignored. */
export function parseGuide(text, source = "guide") {
  const rules = [];
  let cur = null;
  for (const line of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const h = line.match(HEADING);
    if (h) { cur = { id: h[1], title: h[3], blocking: Boolean(h[2]), body: "", avoid: [], source }; rules.push(cur); continue; }
    if (/^#{1,2}\s/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const a = line.match(/^Avoid:\s*(.+)$/);
    if (a) cur.avoid.push(...[...a[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
    cur.body += (cur.body ? "\n" : "") + line;
  }
  for (const r of rules) r.body = r.body.trim();
  return { rules };
}

/** Guides in order; a rule with an ID already seen replaces it in place, a new ID is added at the end. */
export function mergeGuides(...guides) {
  const rules = [];
  for (const g of guides) for (const r of g?.rules || []) {
    const i = rules.findIndex((x) => x.id === r.id);
    if (i >= 0) rules[i] = r; else rules.push(r);
  }
  return { rules };
}

/** The text an agent reads: every rule with its ID, and the instruction to cite the ID of any rule a text breaks. */
export function renderGuide(rules, { language } = {}) {
  const head = [`# Style rules for ${language || "this language"}`, "", "Follow every rule when you write. When you review, report each violation with the quoted text and the rule ID it breaks (for example \"MSA-3: `...`\"); cite the rule ID, never a general complaint. A rule marked [blocking] blocks the review; the others are non-blocking suggestions.", ""];
  const body = rules.flatMap((r) => [`### ${r.id}${r.blocking ? " [blocking]" : ""} ${r.title}`, r.body, ""]);
  return [...head, ...body].join("\n").trimEnd() + "\n";
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasArabic = (s) => new RegExp(AR, "u").test(s);

/** Regex for a phrase to avoid: whole words (a one-letter prefix such as و or ب is allowed), spaces any run of spaces; plain symbols match anywhere. */
function phraseRegex(phrase) {
  const p = stripArabicMarks(phrase).trim().split(/\s+/).map(esc).join("\\s+");
  return hasArabic(phrase) ? new RegExp(`(?<!${AR})[وفبكل]?${p}(?!${AR})`, "gu") : new RegExp(p, "gu");
}

// URLs and code are not prose: replaced by spaces of the same length so columns stay put.
const blank = (s) => s.replace(/https?:\/\/\S+/g, (m) => " ".repeat(m.length)).replace(/`[^`]*`/g, (m) => " ".repeat(m.length));

/**
 * Violations of a rule set in a text: [{ rule, title, blocking, line, text }], in line order. `text` is what matched, without
 * diacritics. Fenced code blocks, inline code and URLs are skipped. Latin punctuation after Arabic is MSA-5 (when present).
 */
export function lintText(text, rules) {
  const out = [];
  const regexes = rules.map((r) => ({ r, res: r.avoid.map(phraseRegex) }));
  const punct = rules.find((r) => r.id === PUNCTUATION_RULE);
  let fence = false;
  String(text || "").replace(/\r\n/g, "\n").split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const line = blank(stripArabicMarks(raw));
    const found = [];
    for (const { r, res } of regexes) for (const re of res) for (const m of line.matchAll(re)) found.push({ at: m.index, v: { rule: r.id, title: r.title, blocking: r.blocking, line: i + 1, text: m[0] } });
    if (punct && hasArabic(line)) for (const m of line.matchAll(LATIN_PUNCT)) found.push({ at: m.index, v: { rule: punct.id, title: punct.title, blocking: punct.blocking, line: i + 1, text: line.slice(Math.max(0, m.index - 12), m.index + 1).trim() } });
    out.push(...found.sort((a, b) => a.at - b.at).map((f) => f.v));
  });
  return out;
}

/** Markdown report of a lint run: one row per violation, with the rule it broke. */
export function lintMarkdown({ date, language, results }) {
  const total = results.reduce((n, r) => n + r.violations.length, 0), blocking = results.reduce((n, r) => n + r.violations.filter((v) => v.blocking).length, 0);
  const lines = [`# Style check, ${language} (${date})`, "", `${results.length} file(s), ${total} violation(s), ${blocking} of them in [blocking] rules.`];
  if (total) {
    lines.push("", "| File | Where | Rule | Text |", "|---|---|---|---|");
    for (const r of results) for (const v of r.violations) lines.push(`| ${r.file} | ${v.where || `line ${v.line}`} | ${v.rule}${v.blocking ? " [blocking]" : ""} ${v.title} | ${String(v.text).replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n") + "\n";
}
