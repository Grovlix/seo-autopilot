// The style-guide hook (D74, milestone 3): parsing, merging, the checks, the job, config, and that every drafting and review
// prompt reads the guide and cites rule IDs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "../src/core/config.mjs";
import { parseGuide, mergeGuides, renderGuide, lintText } from "../src/analysis/style-guide.mjs";
import { run, resolveGuide } from "../src/jobs/style.mjs";
import { JOBS } from "../src/jobs/index.mjs";
import { listAgents, listSkills } from "../src/core/agents.mjs";

const BUILTIN = readFileSync(new URL("../knowledge/arabic-msa-style-guide.md", import.meta.url), "utf8");
const builtin = parseGuide(BUILTIN, "built-in");

test("the built-in guide: rule IDs, titles, blocking tags and the phrases to avoid", () => {
  const ids = builtin.rules.map((r) => r.id);
  assert.ok(ids.length >= 8 && new Set(ids).size === ids.length, ids.join());
  assert.deepEqual(ids.filter((i) => !/^MSA-\d+$/.test(i)), []);
  const calque = builtin.rules.find((r) => r.id === "MSA-2");
  assert.equal(calque.blocking, true); assert.match(calque.title, /calques/);
  assert.ok(calque.avoid.includes("الخاص بك") && calque.avoid.includes("الخاصة بك"));
  assert.ok(builtin.rules.find((r) => r.id === "MSA-3").avoid.includes("تم الحفظ بنجاح"));
  assert.equal(builtin.rules.find((r) => r.id === "MSA-1").blocking, false);
  assert.ok(builtin.rules.every((r) => r.body.length > 20));
});

test("parseGuide: a rule is a ### heading; Avoid lines add phrases; text before the first rule is ignored", () => {
  const g = parseGuide("# T\nintro\n\n### X-1 [blocking] A title\nBody one.\nAvoid: `a b`, `c`\n\n### X-2 Other\nBody.\nAvoid: `d`\n", "f");
  assert.deepEqual(g.rules.map((r) => [r.id, r.title, r.blocking, r.avoid]), [["X-1", "A title", true, ["a b", "c"]], ["X-2", "Other", false, ["d"]]]);
  assert.deepEqual(parseGuide("no rules here", "f").rules, []);
});

test("mergeGuides: a site rule with a new ID adds, the same ID replaces", () => {
  const site = parseGuide("### MSA-3 Site version\nOnly this.\nAvoid: `x`\n\n### SITE-1 [blocking] Brand\nWrite the brand one way.\nAvoid: `Wrong`\n", "site.md");
  const m = mergeGuides(builtin, site);
  assert.equal(m.rules.find((r) => r.id === "MSA-3").title, "Site version");
  assert.equal(m.rules.find((r) => r.id === "MSA-3").source, "site.md");
  assert.equal(m.rules.at(-1).id, "SITE-1");
  assert.equal(m.rules.length, builtin.rules.length + 1);
});

test("renderGuide: the block an agent reads names every rule ID and tells it to cite them", () => {
  const text = renderGuide(builtin.rules, { language: "ar" });
  for (const r of builtin.rules) assert.ok(text.includes(r.id), r.id);
  assert.match(text, /cite the rule ID/i);
  assert.match(text, /\[blocking\]/);
});

test("lint: finds each stock phrase with its rule, line and the text that matched, ignoring diacritics and a one-letter prefix", () => {
  const rules = builtin.rules;
  const v = lintText("مرحبا بك في متجرك.\nتَمَّ الحفظ بنجاح للحساب.\nأدخل بيانات الحساب الخاص بك هنا\nوالخاصة بك أيضا", rules);
  assert.deepEqual(v.map((x) => [x.rule, x.line, x.blocking]), [["MSA-3", 2, false], ["MSA-2", 3, true], ["MSA-2", 4, true]]);
  assert.match(v[1].text, /الخاص بك/);
});

test("lint: a phrase is not found inside a longer word, and tashkeel on the page does not hide it", () => {
  const rules = parseGuide("### T-1 x\nx\nAvoid: `خاص`\n", "t").rules;
  assert.deepEqual(lintText("خاصة وخاص بنا", rules).map((x) => x.line), [1], "خاصة is another word; وخاص is و + خاص");
  assert.deepEqual(lintText("خَاصّ", rules).length, 1);
});

test("lint: Latin punctuation after Arabic words breaks MSA-5, but URLs and code are left alone", () => {
  const rules = builtin.rules;
  const bad = lintText("اختر المنتج, ثم اضغط حفظ; هل انتهيت?", rules);
  assert.deepEqual(bad.map((x) => x.rule), ["MSA-5", "MSA-5", "MSA-5"]);
  assert.deepEqual(lintText("اختر المنتج، ثم اضغط حفظ؛ هل انتهيت؟", rules), []);
  assert.deepEqual(lintText("افتح https://shop.test/ar/متجر?id=1 ثم `a, b` وأكمل.\n```\nمتجر, ok\n```", rules), []);
  assert.deepEqual(lintText("Use a comma, then a semicolon; done?", rules), [], "English text is not Arabic punctuation");
});

test("lint: plain-symbol phrases from a site file (quotation marks) match anywhere", () => {
  const rules = parseGuide("### SITE-2 [blocking] Quotes\nPlain double quotes only.\nAvoid: `«`, `»`, `<<`\n", "s").rules;
  assert.deepEqual(lintText("اضغط «حفظ» الآن", rules).map((x) => x.text), ["«", "»"]);
});

// ---- the job ----
function project(styleGuide, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "seo-style-"));
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), body); }
  const site = { id: "s", url: "https://s.test/", searchConsoleProperty: "https://s.test/", sitemap: "https://s.test/sitemap.xml", market: { location_code: 2682, languages: ["ar", "en"] }, styleGuide, paths: { root, state: join(root, "state") } };
  mkdirSync(site.paths.state, { recursive: true });
  return { root, site };
}
const quiet = async (f) => { const log = console.log; const out = []; console.log = (...a) => out.push(a.join(" ")); const code = process.exitCode; process.exitCode = 0; try { await f(); return { out: out.join("\n"), exit: process.exitCode || 0 }; } finally { console.log = log; process.exitCode = code; } };

test("resolveGuide: the built-in guide for Arabic, plus the site's file; builtin: false drops it; other languages get only the site's file", () => {
  const { site } = project({ files: { ar: "style/ar.md" } }, { "style/ar.md": "### SITE-1 Brand\nWrite the brand one way.\nAvoid: `Wrong`\n" });
  const ar = resolveGuide(site, "ar");
  assert.deepEqual(ar.rules.map((r) => r.id).slice(-1), ["SITE-1"]); assert.ok(ar.rules.some((r) => r.id === "MSA-1"));
  assert.equal(resolveGuide({ ...site, styleGuide: { files: { ar: "style/ar.md" }, builtin: false } }, "ar").rules.length, 1);
  assert.equal(resolveGuide(site, "en").rules.length, 0, "no English guide declared");
  assert.equal(resolveGuide({ ...site, styleGuide: undefined }, "ar").rules.length, builtin.rules.length, "Arabic sites get the built-in guide without any config");
});

test("resolveGuide: a file the config names but that is missing fails loud, and an unknown language fails loud", () => {
  const { site } = project({ files: { ar: "style/missing.md" } });
  assert.throws(() => resolveGuide(site, "ar"), /styleGuide\.files\.ar.*style\/missing\.md.*not found/s);
  assert.throws(() => resolveGuide(site, "fr"), /not one of this site's languages/);
});

test("config: styleGuide is validated and an unknown language code fails loud", () => {
  const cfg = (styleGuide) => validate({ sites: [{ id: "s", url: "https://s.test/", searchConsoleProperty: "https://s.test/", sitemap: "https://s.test/sitemap.xml", market: { location_code: 2682, languages: ["ar", "en"] }, styleGuide }] });
  assert.deepEqual(cfg({ files: { ar: "style/ar.md" }, builtin: true }), []);
  assert.ok(cfg({ files: { fr: "x.md" } }).some((e) => e.includes("styleGuide.files.fr") && e.includes("not one of this site's languages")));
  assert.ok(cfg({ files: { xx: "x.md" } }).some((e) => e.includes("styleGuide.files.xx")));
  assert.ok(cfg({ files: { ar: "" } }).some((e) => e.includes("styleGuide.files.ar")));
  assert.ok(cfg({ builtin: "no" }).some((e) => e.includes("styleGuide.builtin")));
  assert.ok(cfg({ other: 1 }).some((e) => e.includes("unknown key")));
});

test("job: prints the rules in force and writes them for the agents", async () => {
  const { site } = project({ files: { ar: "style/ar.md" } }, { "style/ar.md": "### SITE-1 Brand\nWrite the brand one way.\nAvoid: `Wrong`\n" });
  const r = await quiet(() => run({ site, flags: { language: "ar" } }));
  assert.equal(r.exit, 0); assert.match(r.out, /MSA-1/); assert.match(r.out, /SITE-1/);
  assert.match(readFileSync(join(site.paths.state, "style-ar.md"), "utf8"), /SITE-1/);
});

test("job --files: reports each violation with its rule, writes a report, exits 0 unless --strict and a blocking rule is broken", async () => {
  const { root, site } = project({ files: { ar: "style/ar.md" } }, { "style/ar.md": "### SITE-1 [blocking] Brand\nOne spelling.\nAvoid: `Wrong`\n", "page.md": "سجل حسابك الخاص بك.\nتم الحفظ بنجاح\n", "ok.md": "سجّل حسابك، ثم احفظ التغييرات.\n" });
  const warn = await quiet(() => run({ site, flags: { language: "ar", files: join(root, "page.md") } }));
  assert.equal(warn.exit, 0); assert.match(warn.out, /MSA-2/); assert.match(warn.out, /MSA-3/);
  const j = JSON.parse(readFileSync(join(site.paths.state, "style-lint.json"), "utf8"));
  assert.deepEqual(j.violations.map((v) => v.rule), ["MSA-2", "MSA-3"]);
  assert.equal((await quiet(() => run({ site, flags: { language: "ar", files: join(root, "page.md"), strict: true } }))).exit, 1);
  assert.equal((await quiet(() => run({ site, flags: { language: "ar", files: join(root, "ok.md"), strict: true } }))).exit, 0);
});

test("job: JSON pages are checked on their string values", async () => {
  const { root, site } = project(undefined, { "p.json": JSON.stringify([{ title: "مرحبا", body: "هذا الحساب الخاص بك" }]) });
  const r = await quiet(() => run({ site, flags: { language: "ar", files: join(root, "p.json") } }));
  assert.match(r.out, /MSA-2/);
});

test("the job is registered", async () => { const m = await JOBS.style(); assert.equal(typeof m.run, "function"); assert.ok(m.description.length > 10); });

// ---- every drafting and review prompt ----
const wf = (f) => readFileSync(new URL(`../templates/workflows/${f}`, import.meta.url), "utf8");
test("the drafting and the review prompts tell the agent to read the style guide and to cite rule IDs", () => {
  const implement = wf("seo-implement.yml"), review = wf("seo-review.yml");
  for (const [name, t] of [["seo-implement", implement], ["seo-review", review]]) {
    assert.match(t, /styleGuide/, `${name} names the config key`);
    assert.match(t, /arabic-msa-style-guide\.md/, `${name} names the built-in guide`);
  }
  assert.match(review, /rule ID/i, "the reviewer cites the rule broken");
});

test("a shared skill carries the procedure, and the writers and the editor use it", () => {
  const skill = listSkills().find((s) => s.name === "language-style-guide");
  assert.ok(skill, "departments/skills/language-style-guide/SKILL.md");
  for (const a of ["seo-drafter", "seo-refresher", "seo-snippet-optimizer", "seo-local-content-writer", "seo-editor"]) assert.ok(skill.usedBy.includes(a), `${a} is in used-by`);
  for (const a of listAgents().filter((x) => skill.usedBy.includes(x.name))) {
    const text = readFileSync(a.file, "utf8");
    assert.match(text, /skills\/language-style-guide\/SKILL\.md/, `${a.name} names the skill in Read first`);
  }
  assert.match(readFileSync(listAgents().find((a) => a.name === "seo-editor").file, "utf8"), /rule ID/i);
});

test("the built-in guide is listed in the playbook index and named by the docs", () => {
  assert.ok(readFileSync(new URL("../knowledge/README.md", import.meta.url), "utf8").includes("(arabic-msa-style-guide.md)"));
  assert.ok(existsSync(new URL("../docs/arabic.md", import.meta.url)));
});
