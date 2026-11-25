// Structural and security checks on the workflow templates that `init` and `upgrade` write into other people's repositories.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "../src/cli/init.mjs";
import { upgrade, plan, lineDiff } from "../src/cli/upgrade.mjs";

const dir = fileURLToPath(new URL("../templates/workflows/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));
const text = (f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");

test("there are workflow templates", () => assert.ok(files.length >= 8));

for (const f of files) {
  test(`${f}: structure`, () => {
    const t = text(f);
    assert.ok(!/\t/.test(t), "no tab characters");
    assert.match(t, /^name:\s*\S+/m);
    assert.match(t, /^on:/m);
    assert.match(t, /^jobs:/m);
    assert.match(t, /^permissions:/m, "explicit permissions");
    // Block scalars (| and >-) may be indented freely; everything else must use 2-space steps.
    let block = -1;
    for (const line of t.split("\n")) {
      const ind = line.match(/^ */)[0].length;
      if (block >= 0) { if (!line.trim() || ind > block) continue; block = -1; }
      assert.equal(ind % 2, 0, `odd indentation: ${line.slice(0, 60)}`);
      if (/(:|-)\s+[|>][-+]?\s*$/.test(line)) block = ind;
    }
    assert.equal((t.match(/\$\{\{/g) || []).length, (t.match(/\}\}/g) || []).length - (t.match(/\{\{[A-Z_]+\}\}/g) || []).length, "balanced expressions");
  });

  test(`${f}: security rules`, () => {
    const t = text(f);
    assert.ok(!/pull_request_target/.test(t), "never pull_request_target");
    // Untrusted text must never be interpolated into a shell script.
    const runBlocks = [...t.matchAll(/^\s+run:\s*(\|[^\n]*\n((?:\s{10,}.*\n?)*)|[^\n]*)/gm)].map((m) => m[0]);
    for (const b of runBlocks) assert.ok(!/\$\{\{\s*github\.event\.(issue|pull_request|comment|review|head_commit)\.(title|body|message|label)/.test(b) && !/\$\{\{\s*github\.head_ref/.test(b), `untrusted value in run: ${b.slice(0, 80)}`);
    // Third-party actions must be pinned to a full commit SHA; first-party actions may use a version tag.
    for (const m of t.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)) {
      const ref = m[1];
      if (/^(actions|github)\//.test(ref)) continue;
      if (/^\.\/\.github\/workflows\/seo-[a-z-]+\.yml$/.test(ref)) continue; // our own workflows, in the same repository
      assert.match(ref, /@[0-9a-f]{40}$/, `unpinned third-party action ${ref}`);
    }
  });
}

test("seo-check has no secrets and read-only permissions", () => {
  const t = text("seo-check.yml");
  assert.ok(!/secrets\./.test(t.replace(/#.*$/gm, "")));
  assert.match(t, /permissions:\n\s+contents: read/);
});

test("auto-merge and review are opt-in by repository variable and restricted to seo/ branches in the same repository", () => {
  const am = text("seo-automerge.yml"), rv = text("seo-review.yml");
  assert.match(am, /checks: read/, "needs checks: read to look up the seo-check result");
  assert.match(am, /vars\.SEO_AUTOMERGE == 'true'/);
  assert.match(am, /startsWith\(github\.event\.workflow_run\.head_branch, 'seo\/'\)/);
  assert.match(am, /head_repository\.full_name == github\.repository/);
  assert.match(am, /vars\.SEO_AUTOPILOT_PAUSED != 'true'/, "the kill switch stops auto-merge");
  assert.match(am, /run autopilot --decide/, "the policy decides, in tested code");
  assert.match(am, /check review\)" != "success"/, "the reviewer must have passed on this exact commit, not an earlier one");
  assert.match(am, /--match-head-commit "\$SHA"/, "the merge is pinned to the checked commit");
  assert.match(text("seo-release.yml"), /vars\.SEO_AUTOPILOT_PAUSED != 'true'/, "the kill switch stops publishing");
  assert.match(rv, /vars\.SEO_REVIEW == 'true'/);
  assert.match(rv, /startsWith\(github\.head_ref, 'seo\/'\)/);
});

test("the autopilot loop is opt-in and pausable, and the build check it calls never receives secrets", () => {
  const t = text("seo-autopilot.yml");
  assert.match(t, /vars\.SEO_AUTOPILOT == 'true' && vars\.SEO_AUTOPILOT_PAUSED != 'true'/);
  assert.match(t, /run autopilot --pick/, "the policy picks the work, in tested code");
  const check = t.slice(t.indexOf("\n  check:"), t.indexOf("\n  review:"));
  assert.match(check, /uses: \.\/\.github\/workflows\/seo-check\.yml/);
  assert.ok(!/secrets/.test(check), "seo-check is called without secrets");
  assert.match(check, /contents: read/);
  for (const job of ["draft", "review"]) assert.match(t.slice(t.indexOf(`\n  ${job}:`)), /secrets: inherit/, job);
  for (const f of ["seo-implement.yml", "seo-check.yml", "seo-review.yml", "seo-automerge.yml"]) assert.match(text(f), /workflow_call:/, `${f} can be called by the autopilot`);
  assert.match(text("seo-implement.yml"), /if: \$\{\{ !inputs\.issue \}\}/, "the approver check is skipped only when the autopilot calls it");
});

test("watch and undo: reverts go through a pull request and a no-secrets build, the pause leaves the merge to a person", () => {
  const t = text("seo-watch.yml");
  assert.match(t, /vars\.SEO_AUTOPILOT == 'true'/);
  assert.match(t, /git revert --no-edit/);
  assert.ok(!/git push origin (main|master|HEAD)\b/.test(t) && !/git push\s*$/m.test(t), "never pushes to the default branch");
  const check = t.slice(t.indexOf("\n  check:"), t.indexOf("\n  merge:"));
  assert.match(check, /seo-check\.yml/); assert.ok(!/secrets/.test(check));
  assert.match(t.slice(t.indexOf("\n  merge:")), /vars\.SEO_AUTOPILOT_PAUSED != 'true'/);
  assert.match(t, /--match-head-commit/);
  assert.match(text("seo-automerge.yml"), /--add-label seo-watch/, "auto-merge marks undo-level changes for the watch");
});

test("monthly report: runs on the 1st, reads merged pull requests and opens one report issue without touching the site", () => {
  const t = text("seo-monthly.yml");
  assert.match(t, /cron: "\d+ \d+ 1 \* \*"/);
  assert.match(t, /run monthly --prs/);
  assert.match(t, /pull-requests: read/);
  assert.ok(!/gh pr merge|git push/.test(t), "report only");
});

test("work orders: the weekly team step gets the autopilot switch, the implementer only follows the three content agents", () => {
  assert.match(text("seo-weekly.yml"), /SEO_AUTOPILOT: \$\{\{ vars\.SEO_AUTOPILOT \}\}/);
  const t = text("seo-implement.yml");
  assert.match(t, /seo-work-order/);
  for (const a of ["seo-snippet-optimizer", "seo-internal-linker", "seo-refresher"]) assert.match(t, new RegExp(`agents/${a}\\.md`));
  assert.match(t, /any other agent label means: comment that it needs a person/);
});

test("research suite: free Search Console steps always run; steps that spend credits only when their switch is on", () => {
  assert.match(text("seo-daily.yml"), /run rank\n/);
  const w = text("seo-weekly.yml"), m = text("seo-monthly.yml");
  for (const job of ["keywords", "gap", "authority"]) assert.match(w, new RegExp(`run ${job}\\n`), job);
  assert.match(w.slice(w.lastIndexOf("\n", w.indexOf("run rank --serp") - 1) - 900, w.indexOf("run rank --serp")), /if: vars\.SEO_RANK_LIVE == 'true'/, "live rank checks cost SERP credits");
  assert.match(m.slice(m.indexOf("AI visibility"), m.indexOf("run ai-visibility")), /if: vars\.SEO_AI_VISIBILITY == 'true'/, "AI answers cost API calls");
  assert.ok(m.indexOf("run forecast") < m.indexOf("run monthly"), "the forecast feeds the monthly report");
  assert.ok(w.indexOf("run gap") < w.indexOf("run team"), "the team plan sees the research reports");
});

test("only people with write access can approve a change for the implementer, and the kill switch stops it", () => {
  const t = text("seo-implement.yml");
  assert.match(t, /collaborators\/\$ACTOR\/permission/);
  assert.match(t, /admin\|maintain\|write\)/);
  assert.ok(t.indexOf("collaborators/$ACTOR/permission") < t.indexOf("anthropics/claude-code-action"), "the check runs before the agent");
  assert.match(t, /vars\.SEO_AUTOPILOT_PAUSED != 'true'/);
});

test("the implementer cannot run build or install commands and may only edit content paths", () => {
  const t = text("seo-implement.yml");
  assert.ok(!/Bash\((npm|npx|node|yarn|pnpm)/.test(t));
  assert.match(t, /\{\{EDIT_TOOLS\}\}/);
  assert.ok(!/Edit\(\*\*\)|Write\(\*\*\)|Bash\(\*\)/.test(t));
});

test("init renders every placeholder; upgrade reports, adds missing files and keeps the pinned spec", async () => {
  const proj = mkdtempSync(join(tmpdir(), "seo-up-"));
  const log = console.log; console.log = () => {};
  const cwd = process.cwd(); process.chdir(proj);
  try {
    await init({ flags: { url: "https://up.test/", name: "Up", spec: "github:me/fork#v2.1.0", include: "src/content/*.json" } });
    for (const f of readdirSync(join(proj, ".github", "workflows"))) assert.ok(!/\{\{[A-Z_]+\}\}/.test(readFileSync(join(proj, ".github", "workflows", f), "utf8")), `placeholder left in ${f}`);
    let p = plan({ cwd: proj });
    assert.ok(p.items.every((i) => i.status === "current"));
    assert.equal(p.spec, "github:me/fork#v2.1.0");
    // Simulate an older project: delete one workflow and edit another.
    const wf = join(proj, ".github", "workflows");
    const { rmSync } = await import("node:fs");
    rmSync(join(wf, "seo-geo-test.yml"), { force: true });
    rmSync(join(wf, "seo-review.yml"));
    writeFileSync(join(wf, "seo-daily.yml"), readFileSync(join(wf, "seo-daily.yml"), "utf8").replace("run daily", "run daily --custom"));
    p = plan({ cwd: proj });
    assert.equal(p.items.find((i) => i.file === "seo-review.yml").status, "missing");
    assert.equal(p.items.find((i) => i.file === "seo-daily.yml").status, "differs");
    const report = upgrade({ cwd: proj, flags: {} });
    assert.match(report, /missing\s+\.github\/workflows\/seo-review\.yml/);
    assert.ok(!existsSync(join(wf, "seo-review.yml")), "report mode changes nothing");
    upgrade({ cwd: proj, flags: { apply: true } });
    assert.ok(existsSync(join(wf, "seo-review.yml")), "--apply adds the missing workflow");
    assert.match(readFileSync(join(wf, "seo-daily.yml"), "utf8"), /--custom/, "--apply keeps edited workflows");
    upgrade({ cwd: proj, flags: { force: true } });
    assert.ok(!/--custom/.test(readFileSync(join(wf, "seo-daily.yml"), "utf8")), "--force replaces them");
    assert.ok(existsSync(join(proj, "seo-autopilot", "agents", "seo-editor.md")), "agents refreshed");
  } finally { process.chdir(cwd); console.log = log; }
});

test("lineDiff reports added and removed lines", () => {
  const d = lineDiff("a\nb\nc", "a\nc\nd");
  assert.deepEqual(d, { removed: ["b"], added: ["d"] });
});

test("the autopilot picks nothing when the repository has no AI secret (no failing run twice a day)", () => {
  const t = text("seo-autopilot.yml");
  const pick = t.slice(t.indexOf("\n  pick:"), t.indexOf("\n  draft:"));
  assert.match(pick, /HAS_AI: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN != '' \|\| secrets\.ANTHROPIC_API_KEY != '' \}\}/);
  assert.ok(pick.indexOf('if [ "$HAS_AI" != "true" ]') < pick.indexOf("gh issue list"), "checked before any work");
});

test("drafted pull requests start seo-check and seo-review by dispatch, from a job without the agent's token", () => {
  const t = text("seo-implement.yml");
  const checks = t.slice(t.indexOf("\n  checks:"));
  assert.match(checks, /needs: implement/);
  assert.match(checks, /actions: write/);
  assert.match(checks, /gh workflow run seo-check\.yml --ref "seo\/issue-\$N" -f ref="seo\/issue-\$N" -f base="\$base"/);
  assert.match(checks, /gh workflow run seo-review\.yml --ref "seo\/issue-\$N" -f pr="\$pr"/);
  assert.match(checks, /format\('\{0\}', inputs\.start_checks\) != 'false'/, "the autopilot runs check and review itself; null (no input) must still run");
  const code = t.replace(/#.*$/gm, ""), implement = code.slice(code.indexOf("\n  implement:"), code.indexOf("\n  checks:"));
  assert.ok(!/actions: write/.test(code.slice(0, code.indexOf("\njobs:"))) && !/actions: write/.test(implement), "the drafting agent's token cannot start workflows");
  for (const f of ["seo-check.yml", "seo-review.yml"]) assert.match(text(f), /workflow_dispatch:/, `${f} can be dispatched`);
  const ap = text("seo-autopilot.yml");
  assert.match(ap.slice(ap.indexOf("\n  draft:"), ap.indexOf("\n  locate:")), /start_checks: false/);
});

test("dispatched and called runs post commit statuses on the checked commit; the build job never holds a write token", () => {
  const c = text("seo-check.yml");
  const build = c.slice(c.indexOf("\n  build:"), c.indexOf("\n  status:"));
  assert.ok(!/statuses|permissions:/.test(build), "the build job keeps the read-only workflow permissions");
  const st = c.slice(c.indexOf("\n  status:"));
  assert.match(st, /needs: build/);
  assert.match(st, /statuses: write/);
  assert.match(st, /context=seo-check/);
  assert.ok(!/actions\/checkout/.test(st), "the status job never checks out pull request code");
  const r = text("seo-review.yml");
  assert.match(r, /statuses: write/);
  assert.match(r, /context=seo-review -f description="Reviewer agent running"/);
  assert.ok(r.indexOf("Reviewer agent running") < r.indexOf("anthropics/claude-code-action"), "pending is posted before the agent runs");
  assert.match(r.slice(r.indexOf("Post the review result")), /if: always\(\)/);
  const am = text("seo-automerge.yml");
  assert.match(am, /statuses: read/);
  assert.match(am, /commits\/\$SHA\/status/, "automerge reads the commit status on the exact commit");
  assert.match(am, /ctx=seo-check; \[ "\$1" = review \] && ctx=seo-review/);
});

test("every model job runs on a Claude subscription token; API keys stay optional", () => {
  // Drafting, review and the weekly agents: claude-code-action with the OAuth token.
  for (const f of ["seo-implement.yml", "seo-review.yml", "seo-agent.yml"]) {
    const t = text(f);
    assert.match(t, /anthropics\/claude-code-action@[0-9a-f]{40}/, f);
    assert.match(t, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/, f);
  }
  // The Agent SDK is not used for subscription runs (its docs ask third-party products to use API keys).
  const ag = text("seo-agent.yml");
  assert.ok(!/claude-agent-sdk|setup-python/.test(ag));
  assert.match(ag, /Write\(seo-agent-out\/\*\*\)/);
  assert.ok(!/Bash/.test(ag.replace(/#.*$/gm, "")), "the weekly agents get no shell");
  assert.match(ag, /--issue --report-file "seo-agent-out\/\{site\}\/strategist\.md"/);
  assert.match(ag, /--issues --report-file "seo-agent-out\/\{site\}\/researcher\.md" --proposals-file "seo-agent-out\/\{site\}\/proposals\.json"/);
  // In-process AI helpers: the Claude Code CLI, installed (pinned) only when the token is set, and the token passed to them.
  for (const f of ["seo-daily.yml", "seo-weekly.yml"]) {
    const t = text(f).replace(/#.*$/gm, "");
    assert.match(t, /HAS_CLAUDE_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN != '' \}\}/, f);
    assert.match(t, /if: env\.HAS_CLAUDE_TOKEN == 'true'\n\s+run: npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+\n/, f);
    for (const block of t.split("\n      - name:").filter((b) => /ANTHROPIC_API_KEY/.test(b))) assert.match(block, /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/, `${f}: every AI step gets the subscription token`);
  }
});
