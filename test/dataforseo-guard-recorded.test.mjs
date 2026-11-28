// The cost guard against REAL DataForSEO responses (recorded 2026-11-28, generic queries, redacted), not hand-written stand-ins:
// the ledger records exactly the cost the API reported, every conservative estimate really is above the real cost, and the real
// account response has the shape the guard has to cope with.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BudgetError, createCostGuard, memoryLedger, estimateCost, costOf } from "../src/lib/dataforseo.mjs";
import { DFS_ENV } from "./dfs-fixtures.mjs";

const dir = new URL("./fixtures/dataforseo/", import.meta.url);
const rec = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));
const manifest = rec("manifest");
const PAID = manifest.calls.filter((c) => c.file && c.costUsd > 0);
const NOW = () => new Date("2026-11-28T10:00:00Z");
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// The balance endpoint's real response carries no balance in the fixture (redacted away), so the free GET is served with a plain
// balance of 50 here; the paid POSTs are served with the recorded body of that call.
function serve(body) {
  const f = async (url) => (String(url).endsWith("/appendix/user_data") ? jsonRes({ tasks: [{ status_code: 20000, result: [{ money: { balance: 50 } }] }] }) : jsonRes(body));
  return f;
}

test("recorded manifest: 11 calls (10 paid, 1 free), the total is what the calls add up to, and it is far under the run cap", () => {
  assert.equal(manifest.calls.length, 11);
  const sum = manifest.calls.reduce((s, c) => s + (c.costUsd || 0), 0);
  assert.ok(Math.abs(sum - manifest.spentUsd) < 1e-6, `${sum} vs ${manifest.spentUsd}`);
  assert.ok(manifest.spentUsd < 0.2);
});

for (const c of PAID) {
  test(`${c.name}: the ledger records exactly the real cost (${c.costUsd}) and the estimate was above it`, async () => {
    const body = rec(c.name);
    assert.equal(costOf(body), c.costUsd, "costOf reads the real top-level cost");
    const ledger = memoryLedger();
    const guard = createCostGuard({ cfg: { monthlyCapUsd: 1, minBalanceUsd: 5 }, job: "recorded", env: DFS_ENV, fetch: serve(body), ledger, label: "x.test", notify: async () => ({ sent: false }), now: NOW });
    const est = c.estimateUsd ?? estimateCost(c.endpoint, c.request);
    assert.ok(est >= c.costUsd, `estimate ${est} is below the real cost ${c.costUsd}`);
    const json = await guard.post(c.endpoint, [c.request], c.name.startsWith("llm") || c.endpoint.includes("ai_mode") || c.request.load_async_ai_overview ? { estimateUsd: c.estimateUsd } : {});
    assert.equal(json.tasks[0].status_code, 20000);
    const month = ledger.load().months["2026-11"];
    assert.ok(Math.abs(month.usd - c.costUsd) < 1e-9, `ledger ${month.usd}`);
    assert.equal(month.calls, 1);
    assert.equal(month.estimatedCalls ?? 0, 0, "a real cost was recorded, not an estimate");
  });
}

test("an endpoint without a price in the table (the LLM responses call) is refused without an estimate and allowed with one", async () => {
  const c = manifest.calls.find((x) => x.name === "llm-responses-sa-ar");
  const guard = createCostGuard({ cfg: { monthlyCapUsd: 1, minBalanceUsd: 5 }, job: "recorded", env: DFS_ENV, fetch: serve(rec("llm-responses-sa-ar")), ledger: memoryLedger(), notify: async () => ({ sent: false }), now: NOW });
  await assert.rejects(() => guard.post(c.endpoint, [c.request]), (e) => e instanceof BudgetError && e.reason === "no-estimate");
  assert.ok((await guard.post(c.endpoint, [c.request], { estimateUsd: 0.05 })).tasks[0].cost > 0.03, "the real call cost about 3 cents with web search on");
});

test("the recorded account response has the real envelope and a money block, but no balance", () => {
  const r = rec("user-data");
  assert.equal(r.tasks[0].status_code, 20000);
  assert.ok(r.tasks[0].result[0].money && !("balance" in r.tasks[0].result[0].money));
});

test("the real account response has no usable balance once redacted: the guard refuses with balance-unavailable and sends no paid request", async () => {
  const paid = [];
  const f = async (url, init = {}) => { if (init.method === "POST") { paid.push(url); return jsonRes({}); } return jsonRes(rec("user-data")); };
  const guard = createCostGuard({ cfg: { monthlyCapUsd: 1, minBalanceUsd: 5 }, job: "recorded", env: DFS_ENV, fetch: f, ledger: memoryLedger(), notify: async () => ({ sent: false }), now: NOW });
  await assert.rejects(() => guard.post("serp/google/organic/live/advanced", [{ keyword: "x", location_code: 2840, language_code: "en", depth: 10 }]), (e) => e instanceof BudgetError && e.reason === "balance-unavailable");
  assert.deepEqual(paid, []);
});

test("the recorded SERP, Labs and Backlinks bodies all carry a top-level cost equal to the task cost (what costOf relies on)", () => {
  for (const c of PAID) { const b = rec(c.name); assert.equal(b.cost, b.tasks[0].cost, c.name); assert.equal(typeof b.cost, "number"); }
});
