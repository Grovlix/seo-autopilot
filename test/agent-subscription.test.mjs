// The weekly agents on a Claude subscription: claude-code-action writes files, seo-autopilot checks and saves them.
// Also: the Python runtime (Agent SDK) is the API-key route and skips cleanly without ANTHROPIC_API_KEY.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProposals, mergeProposals, cleanReport } from "../src/analysis/agent-output.mjs";
import { run, saveActionOutput } from "../src/jobs/agent.mjs";

const good = { title: "How to fix a broken sitemap", primaryQuery: "fix broken sitemap", why: "Queries about sitemap errors show impressions with no page.", evidence: "search-insights.md: 40 impressions for sitemap error queries", pageType: "guide" };
const quiet = async (fn) => { const log = console.log, lines = []; console.log = (...a) => lines.push(a.join(" ")); try { await fn(); } finally { console.log = log; } return lines; };

test("validateProposals keeps the Python tool's limits and caps the count", () => {
  const { ok, dropped } = validateProposals([good, { ...good, title: "short" }, { ...good, pageType: "landing" }, "x", { ...good, title: "Another valid title here" }, { ...good, title: "A fourth valid title here" }]);
  assert.equal(ok.length, 3);
  assert.equal(ok[1].pageType, "guide", "an unknown page type falls back to guide");
  assert.match(dropped.join("\n"), /title must be 8 to 120/);
  assert.match(dropped.join("\n"), /not an object/);
  assert.match(dropped.join("\n"), /at most 3/);
  assert.match(validateProposals({ not: "a list" }).dropped.join(), /not a JSON array/);
});

test("mergeProposals adds new ones with status new and skips titles already saved", () => {
  const { list, added } = mergeProposals([{ title: good.title.toUpperCase(), status: "issued" }], [good, { ...good, title: "Something new entirely" }], { agent: "seo-researcher", date: "2026-11-26" });
  assert.equal(added, 1);
  assert.deepEqual(list.at(-1), { ...good, title: "Something new entirely", agent: "seo-researcher", date: "2026-11-26", status: "new" });
});

test("cleanReport refuses a stub and caps a long report", () => {
  assert.equal(cleanReport("too short"), null);
  assert.equal(cleanReport("x".repeat(50000)).length, 40000);
});

test("saveActionOutput saves the report and proposals per site; bad files are reported, not fatal", async () => {
  const root = mkdtempSync(join(tmpdir(), "seo-agent-out-"));
  const site = { id: "ex", paths: { state: join(root, "state", "ex") } };
  mkdirSync(join(root, "out", "ex"), { recursive: true });
  writeFileSync(join(root, "out", "ex", "plan.md"), `# Plan\n\n${"Evidence-backed step. ".repeat(10)}`);
  writeFileSync(join(root, "out", "ex", "proposals.json"), JSON.stringify([good]));
  let saved;
  const lines = await quiet(() => { saved = saveActionOutput({ site, name: "seo-researcher", flags: { "report-file": join(root, "out", "{site}", "plan.md"), "proposals-file": join(root, "out", "{site}", "proposals.json") } }); });
  assert.equal(saved, true);
  const reports = join(site.paths.state, "agent-reports");
  assert.ok(existsSync(reports));
  assert.equal(JSON.parse(readFileSync(join(site.paths.state, "agent-proposals.json"), "utf8"))[0].status, "new");
  assert.match(lines.join("\n"), /1 new proposal/);

  writeFileSync(join(root, "out", "ex", "proposals.json"), "{ not json");
  const lines2 = await quiet(() => { saved = saveActionOutput({ site, name: "seo-researcher", flags: { "proposals-file": join(root, "out", "ex", "proposals.json") } }); });
  assert.equal(saved, false);
  assert.match(lines2.join("\n"), /not a JSON array/);
  const lines3 = await quiet(() => { saved = saveActionOutput({ site, name: "seo-strategist", flags: { "report-file": join(root, "missing.md") } }); });
  assert.equal(saved, false);
  assert.match(lines3.join("\n"), /file missing/);
});

test("the Python runtime needs ANTHROPIC_API_KEY: with only a subscription token it skips and points to the workflow", async () => {
  const site = { id: "ex", url: "https://ex.test/", paths: { state: mkdtempSync(join(tmpdir(), "seo-agent-")), data: "." } };
  const lines = await quiet(() => run({ site, cfg: { root: "." }, flags: {}, positional: ["seo-strategist"] }, { env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }));
  assert.match(lines.join("\n"), /skipped\. The Python runtime needs ANTHROPIC_API_KEY.*seo-agent GitHub workflow/);
});
