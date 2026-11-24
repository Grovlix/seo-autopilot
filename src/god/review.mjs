// Independent review (§6): a different actor from the one that produced the work checks it before it can be approved
// or deployed. This deterministic reviewer covers the checks that need no model: evidence present, scope kept to the
// job's own site, change size within the risk class, no untrusted instruction carried into actions, and numbers only
// with a source. Model-based review (seo-editor) plugs in through the same interface: (job, output) -> verdict.

import { findClaims } from "../analysis/facts.mjs";

export const REVIEWER = "quality-gate@1";

const INJECTION = /\b(ignore (all |your |previous )?(rules|instructions)|disregard (the )?(above|previous)|you are now|system prompt|run this command|curl\s+http|rm\s+-rf)\b/i;

/**
 * job: { id, siteId, kind, risk, agent }. output: { evidence: [...], changes: [{ url, field, from, to }], claims: [{ text, source }], actions: [string] }
 * Returns { reviewer, producer, verdict: "pass" | "fail" | "needs_changes", reasons: [...] }.
 */
export function reviewOutput(job, output = {}, { siteHost = null, maxChanges = { low: 0, medium: 25, high: 200 } } = {}) {
  const reasons = [];
  const producer = job.agent || job.kind;
  if (producer === REVIEWER) return { reviewer: REVIEWER, producer, verdict: "fail", reasons: ["a reviewer cannot review its own work"] };
  if (!Array.isArray(output.evidence) || output.evidence.length === 0) reasons.push("no evidence recorded");
  const changes = output.changes || [];
  if (changes.length > (maxChanges[job.risk] ?? 0)) reasons.push(`${changes.length} changes exceed the ${job.risk}-risk limit of ${maxChanges[job.risk] ?? 0}`);
  if (siteHost) for (const c of changes) { try { if (new URL(c.url).hostname.replace(/^www\./, "") !== siteHost.replace(/^www\./, "")) reasons.push(`change outside the site: ${c.url}`); } catch { reasons.push(`change without a valid URL: ${c.url}`); } }
  for (const c of output.claims || []) if (/\d/.test(c.text || "") && !c.source) reasons.push(`number without a source: "${String(c.text).slice(0, 80)}"`);
  for (const a of output.actions || []) if (INJECTION.test(a)) reasons.push("an action repeats instruction-like text from untrusted input");
  reasons.push(...adviceProblems(output, siteHost));
  const cost = Number(output.costUsd) || 0, budget = Number(job.budgetUsd) || 0;
  if (cost > budget + 1e-9) reasons.push(`over budget: spent $${cost.toFixed(4)} of $${budget.toFixed(4)}`);
  // Hard failures are not retried: retrying an out-of-scope, manipulated or overspending run would repeat it.
  const verdict = reasons.length === 0 ? "pass" : reasons.some((r) => /outside the site|instruction-like|own work|over budget/.test(r)) ? "fail" : "needs_changes";
  return { reviewer: REVIEWER, producer, verdict, reasons };
}

const DESTRUCTIVE = /\b(remov(e|es|ing)|delet(e|es|ing)|no-?index(es|ing)?|de-?index|redirect(s|ing)?|merg(e|es|ing)|disavow|unpublish)\b/gi;
// "do not merge", "instead of redirecting", "rather than removing": advice against the action is not the action.
const NEGATED = /\b(?:not|never|don['’]?t|no|without|instead of|rather than|avoid(?:ing)?|against)\s+(?:\w+\s+){0,2}$/i;
const destructive = (title) => [...String(title || "").matchAll(DESTRUCTIVE)].some((m) => !NEGATED.test(title.slice(Math.max(0, m.index - 40), m.index)));
const APPROVAL_PREFIX = /^After a person approves:/i;
const sameHost = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");
// Numbers in prose, without the ones inside addresses and paths ("/page-2", "https://x/2026/"), calendar dates
// ("2026-10-18", the data window an agent cites), names of standards ("ISO 8601", "HTTP 301", "WCAG 2.2") and
// length guidance ("60 characters", "600 pixels"), none of which is a claim about the site (production 2026-11-16).
export const numbersIn = (text) => String(text || "").replace(/https?:\/\/\S+/g, " ").replace(/(^|\s)\/\S*/g, " ")
  .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(/\b(?:ISO|RFC|HTTP|UTF|WCAG|TLS|IPv|PEP|ES|H)[- ]?\d[\d.]*\b/gi, " ")
  .replace(/\b\d[\d,]*\s?(?:characters?|chars?|pixels?|px|words?)\b/gi, " ")
  // HTTP status codes in technical advice ("returns 200", "a 301 redirect", "200-status URLs", "404 errors"), D66.
  .replace(/\b(?:returns?|returning|status(?: code)?|code|answers? with|in (?:one|a single)|an?|one)\s+[1-5]\d\d\b/gi, " ")
  .replace(/\b[1-5]\d\d(?=[- ](?:status|response|redirects?|errors?|codes?|URLs?|pages?|chains?)\b)/gi, " ")
  .match(/(?<![\w/])\d(?:[\d,]*\d)?(?:\.\d+)?/g) || [];
/**
 * The numbers stated in the site data an agent read (its JSON input), for the gate to accept as grounded (D66).
 * Identifiers and timestamps are not data: ids, dates and times are removed first, and a number glued to letters,
 * dots, slashes or hyphens ("3f2a", "v2", "/page-2", "1.2.3") is not taken.
 */
export const dataNumbersOf = (text) => [...new Set((String(text || "")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ")
  .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, " ")
  .replace(/https?:\/\/[^\s"]+/g, " ")
  .match(/(?<![\w./-])\d+(?:,\d{3})*(?:\.\d+)?(?![\w/-]|\.\d)/g) || []).map((n) => n.replace(/,/g, "")))];
const norm = (t) => String(t).toLowerCase().replace(/(\d),(\d)/g, "$1$2");

/**
 * D62: checks on an agent's advice (output.proposal.recommendations), which the general checks above barely touch:
 * every recommendation's address is on the site, every recommendation names its evidence, every number or factual
 * claim in the prose appears in a claim that has a source (src/analysis/facts.mjs finds the non-numeric ones: awards,
 * "#1", named clients), and removing, noindexing, redirecting or merging starts with "After a person approves:".
 * Each problem is fixable by the agent, so it asks for changes rather than failing the work.
 */
export function adviceProblems(output = {}, siteHost = null) {
  const recs = output.proposal?.recommendations;
  if (!Array.isArray(recs)) return [];
  const out = [];
  const t = (r) => `"${String(r.title || "").slice(0, 80)}"`;
  for (const r of recs) {
    if (r.url && siteHost) { try { if (!sameHost(new URL(r.url).hostname, siteHost)) out.push(`recommendation address not on this site: ${String(r.url).slice(0, 120)}`); } catch { out.push(`recommendation without a valid address: ${String(r.url).slice(0, 120)}`); } }
    if (!(r.evidence || []).some((e) => String(e).trim())) out.push(`recommendation without evidence: ${t(r)}`);
    if (destructive(String(r.title || "")) && !APPROVAL_PREFIX.test(String(r.title || "").trim())) out.push(`removing, noindexing, redirecting or merging must start with "After a person approves:": ${t(r)}`);
  }
  // A number is grounded when a sourced claim states it, or when it appears in the site data the agent was given
  // (output.dataNumbers, set by the agent runner from its own input; D66: "+7,393" from the priorities report).
  const sourced = norm((output.claims || []).filter((c) => String(c.source || "").trim()).map((c) => c.text).join("\n"));
  const inData = new Set((output.dataNumbers || []).map(norm));
  const prose = [output.proposal.summary, ...recs.flatMap((r) => [r.title, r.why])].filter(Boolean).map(String);
  const missing = new Set();
  for (const text of prose) {
    for (const n of numbersIn(text)) if (!sourced.includes(norm(n)) && !inData.has(norm(n).replace(/^\+/, ""))) missing.add(n);
    for (const c of findClaims(text)) if (!/\d/.test(c.claim) && !sourced.includes(norm(c.claim))) missing.add(c.claim);
  }
  if (missing.size) out.push(`numbers or claims without a sourced claim: ${[...missing].slice(0, 8).join(", ")}`);
  return out;
}
