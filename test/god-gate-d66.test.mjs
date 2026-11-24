// D66 (production 2026-11-20 to 24): the quality gate flagged HTTP status codes and numbers from the site's own data as
// unsourced; retries started with too little budget and were cut off; one unreadable fact-check went to a person; the
// gate compared spend with the job's stored budget (0) instead of the one it ran with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adviceProblems, reviewOutput, numbersIn, dataNumbersOf } from "../src/god/review.mjs";
import { MemoryStore } from "../src/god/stores.mjs";
import { runOnce, RETRY_HEADROOM } from "../src/god/worker.mjs";
import { makeAgentHandler } from "../src/god/agent-runner.mjs";

const rec = (title, why = "w") => ({ title, why, evidence: ["e"] });
const out = (recs, extra = {}) => ({ evidence: ["e"], proposal: { summary: "s", recommendations: recs }, claims: [], ...extra });
const unsourced = (o) => adviceProblems(o).find((p) => /without a sourced claim/.test(p)) || "";

test("gate: HTTP status codes in technical advice are not claims", () => {
  for (const t of ["Check whether /login returns 200 or redirects", "List only canonical, 200-status URLs in the sitemap",
    "The sitemap should list only indexable, 200 URLs", "Redirect in one 301 to /terms/", "Use a 301 redirect, not a 302 redirect",
    "Fix the 404 errors", "Avoid redirect chains: 3 hops", "The status code 410 tells Google the page is gone"]) {
    assert.doesNotMatch(unsourced(out([rec(t)])), /\b(200|301|302|404|410)\b/, t);
  }
  assert.match(unsourced(out([rec("Avoid redirect chains: 3 hops")])), /\b3\b/, "other numbers are still checked");
  assert.match(unsourced(out([rec("Traffic fell by 200 visits")])), /200/, "a count is still a claim");
});

test("gate: a number that appears in the site data the agent read is grounded", () => {
  const o = out([rec("Do not chase the +7,393 click estimate", "50,790 impressions and 7 clicks at position 4.6")]);
  assert.match(unsourced(o), /7,393/);
  assert.equal(unsourced({ ...o, dataNumbers: ["7393", "50790", "7", "4.6"] }), "", "all in the data: nothing missing");
  assert.match(unsourced({ ...o, dataNumbers: ["7393"] }), /50,790/, "only the ones in the data are accepted");
  assert.deepEqual(numbersIn("returns 200; 1,234 clicks"), ["1,234"]);
  // Ids, dates and versions in the data are not numbers the agent may quote.
  assert.deepEqual(dataNumbersOf('{"id":"0091f32b-0002-4cd3-a4bd-0c69335472d9","at":"2026-11-24T10:00:00Z","clicks":7393,"note":"7,393 clicks","url":"https://x.test/page-340","v":"v2","ver":"1.2.3"}'), ["7393"]);
});

test("gate: spend is checked against the budget the job ran with", () => {
  const job = { kind: "agent:seo-reporter", risk: "low", budgetUsd: 0.5 };
  assert.ok(!reviewOutput(job, { evidence: ["e"], costUsd: 0.3 }).reasons.some((r) => /over budget/.test(r)));
  assert.ok(reviewOutput({ ...job, budgetUsd: 0 }, { evidence: ["e"], costUsd: 0.3 }).reasons.some((r) => /over budget/.test(r)), "a $0 job would be failed");
});

const NOW = "2026-11-24T10:00:00Z";
const queuedJob = (store, extra = {}) => { const j = store.createJob({ siteId: "A", kind: "agent:seo-researcher", title: "t", ...extra }); store.transition(j.id, "scoped", "t"); store.transition(j.id, "queued", "t"); return j; };
const advice = (costUsd) => ({ evidence: ["e"], costUsd, proposal: { summary: "Traffic fell by 900 visits", recommendations: [rec("x")] }, claims: [] });

test("worker: a $0 job is reviewed against the budget it ran with, not failed as over budget", async () => {
  const store = new MemoryStore(); store.clock = () => NOW;
  const j = queuedJob(store, { budgetUsd: 0 });
  const r = await runOnce({ store, handlers: { "agent:*": async () => ({ ...advice(0.2), proposal: { summary: "ok", recommendations: [rec("x")] } }) }, budgetOf: () => 0.5 });
  assert.notEqual(r.outcome, "review_fail", JSON.stringify(r));
  assert.ok(!(r.reasons || []).some((x) => /over budget/.test(x)));
  assert.notEqual(store.get(j.id).status, "escalated");
});

test("worker: a retry starts only with 1.25x the first attempt's cost left", async () => {
  assert.equal(RETRY_HEADROOM, 1.25);
  for (const cost of [0.2, 0.22]) { // 0.30 left of 0.25 needed, 0.28 left of 0.275: both retried
    const store = new MemoryStore(); store.clock = () => NOW;
    const j = queuedJob(store, { budgetUsd: 0.5 });
    await runOnce({ store, handlers: { "agent:*": async () => advice(cost) } });
    const left = 0.5 - cost, need = cost * RETRY_HEADROOM;
    assert.equal(store.get(j.id).status === "queued", left >= need, `cost ${cost}: left ${left} need ${need}`);
  }
  const store = new MemoryStore(); store.clock = () => NOW;
  const j = queuedJob(store, { budgetUsd: 0.5 });
  await runOnce({ store, handlers: { "agent:*": async () => advice(0.24) } }); // 0.26 left < 0.30 needed
  assert.equal(store.get(j.id).status, "escalated");
});

const SITE = { id: "A", name: "Plumber", url: "https://plumber.test/" };
const GOOD = { summary: "s", recommendations: [{ title: "Add FAQ schema to /x", why: "w", evidence: ["e"], impact: "medium", effort: "low", risk: "low", needsApproval: false }], claims: [], questions: [] };
const reply = (text) => ({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 2000, output_tokens: 500 } });
const seq = (list, calls) => async (_u, o) => { calls.push(JSON.parse(o.body)); return new Response(JSON.stringify(list[Math.min(calls.length - 1, list.length - 1)]), { status: 200 }); };
const mem = () => { const s = new MemoryStore(); s.clock = () => NOW; s.writeMemory("A", [{ kind: "strategy", key: "initial", value: { status: "approved" }, basis: "verified" }, { kind: "report", key: "audit", value: { generatedAt: NOW, summary: { pagesCrawled: 7393 }, issues: [] }, basis: "verified" }]); return s; };

test("runner: an unreadable fact-check is asked once more; the second answer counts", async () => {
  const calls = [];
  const h = makeAgentHandler({ store: mem(), siteOf: async () => SITE, apiKey: "k", fetchImpl: seq([reply(JSON.stringify(GOOD)), reply("I think it is fine."), reply('{"verdict":"pass","problems":[],"summary":"ok"}')], calls) });
  const o = await h({ siteId: "A", kind: "agent:seo-schema-engineer", title: "T", inputs: { agent: "seo-schema-engineer" } }, { budgetUsd: 0.75 });
  assert.equal(calls.length, 3);
  assert.match(calls[2].messages[0].content, /JSON object only/);
  assert.equal(o.escalate, undefined); assert.equal(o.secondReview.verdict, "pass");
  assert.ok(o.dataNumbers.includes("7393"), "numbers from the site data are reported to the gate");
  const twice = []; const bad = await makeAgentHandler({ store: mem(), siteOf: async () => SITE, apiKey: "k", fetchImpl: seq([reply(JSON.stringify(GOOD)), reply("no"), reply("still no")], twice) })({ siteId: "A", kind: "agent:seo-schema-engineer", title: "T", inputs: { agent: "seo-schema-engineer" } }, { budgetUsd: 0.75 });
  assert.equal(twice.length, 3, "asked at most once more"); assert.match(bad.escalate, /unreadable/);
});
