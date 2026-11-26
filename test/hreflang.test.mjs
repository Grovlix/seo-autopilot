// The hreflang pair check of seo-check (D74, milestone 2): analysis, config, and the job end to end on a built folder.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "../src/core/config.mjs";
import { checkHreflang, pagePathCandidates } from "../src/analysis/hreflang.mjs";
import { run } from "../src/jobs/hreflang.mjs";
import { JOBS } from "../src/jobs/index.mjs";

const S = "https://shop.test";
const AR = `${S}/ar/store/`, EN = `${S}/en/store/`;
const alt = (...pairs) => pairs.map(([hreflang, href]) => ({ hreflang, href }));
const pages = (o) => Object.fromEntries(Object.entries(o).map(([u, alternates]) => [u, { found: true, alternates }]));
const ids = (r) => r.findings.map((f) => `${f.id}@${f.page.replace(S, "")}`);
const group = [{ ar: AR, en: EN }];

test("a complete pair has no findings", () => {
  const r = checkHreflang({ groups: group, pages: pages({ [AR]: alt(["ar", AR], ["en", EN]), [EN]: alt(["ar", AR], ["en", EN]) }) });
  assert.deepEqual(r.findings, []); assert.equal(r.checked, 2);
});

test("a one-way link is named as one-way, on the page that lacks the return link", () => {
  const r = checkHreflang({ groups: group, pages: pages({ [AR]: alt(["ar", AR], ["en", EN]), [EN]: alt(["en", EN]) }) });
  assert.deepEqual(ids(r), ["link-one-way@/en/store/"]);
  assert.match(r.findings[0].detail, /\/ar\/store\/ links to .*\/en\/store\/ but .*does not link back/);
});

test("no links at all: both pages miss the other, and the self reference", () => {
  const r = checkHreflang({ groups: group, pages: pages({ [AR]: [], [EN]: [] }) });
  assert.deepEqual(ids(r).sort(), ["link-missing@/ar/store/", "link-missing@/en/store/", "no-self@/ar/store/", "no-self@/en/store/"]);
});

test("a link to the wrong page, a region code, and trailing slash differences", () => {
  const r = checkHreflang({ groups: group, pages: pages({ [AR]: alt(["ar-SA", AR.slice(0, -1)], ["en", `${S}/en/other/`]), [EN]: alt(["en-GB", EN], ["ar", AR]) }) });
  assert.deepEqual(ids(r), ["link-wrong-target@/ar/store/"], "ar-SA is Arabic; a missing trailing slash is the same page; /en/other/ is not");
  assert.match(r.findings[0].detail, /\/en\/other\//);
});

test("a page that is not there is reported once and does not also report missing links", () => {
  const r = checkHreflang({ groups: group, pages: { [AR]: { found: true, alternates: alt(["ar", AR], ["en", EN]) }, [EN]: { found: false, error: "no file for /en/store/" } } });
  assert.deepEqual(ids(r), ["page-missing@/en/store/"]);
});

test("x-default: required only when asked, and it must point at the chosen language's page", () => {
  const ok = alt(["ar", AR], ["en", EN]);
  const set = pages({ [AR]: ok, [EN]: ok });
  assert.deepEqual(checkHreflang({ groups: group, pages: set, xDefault: false }).findings, []);
  assert.deepEqual(ids(checkHreflang({ groups: group, pages: set, xDefault: "ar" })).sort(), ["x-default-missing@/ar/store/", "x-default-missing@/en/store/"]);
  const withX = alt(["ar", AR], ["en", EN], ["x-default", AR]);
  assert.deepEqual(checkHreflang({ groups: group, pages: pages({ [AR]: withX, [EN]: withX }), xDefault: "ar" }).findings, []);
  assert.deepEqual(ids(checkHreflang({ groups: group, pages: pages({ [AR]: withX, [EN]: withX }), xDefault: "en" })), ["x-default-wrong@/ar/store/", "x-default-wrong@/en/store/"]);
});

test("three languages: every ordered pair is checked", () => {
  const FR = `${S}/fr/store/`, g = [{ ar: AR, en: EN, fr: FR }];
  const full = alt(["ar", AR], ["en", EN], ["fr", FR]);
  const r = checkHreflang({ groups: g, pages: pages({ [AR]: full, [EN]: full, [FR]: alt(["fr", FR], ["en", EN]) }) });
  assert.deepEqual(ids(r), ["link-one-way@/fr/store/"]);
});

test("page paths: folders, .html files and Arabic (percent-encoded) paths", () => {
  assert.deepEqual(pagePathCandidates("https://s.test/ar/store/"), ["/ar/store/index.html"]);
  assert.deepEqual(pagePathCandidates("https://s.test/en/store"), ["/en/store", "/en/store.html", "/en/store/index.html"]);
  assert.deepEqual(pagePathCandidates("https://s.test/ar/%D9%85%D8%AA%D8%AC%D8%B1/"), ["/ar/متجر/index.html"]);
  assert.deepEqual(pagePathCandidates("https://s.test/a/../../etc/"), ["/etc/index.html"], "no way out of the folder");
});

test("config: hreflang settings are checked, an unknown language fails loud", () => {
  const cfg = (hreflang) => validate({ sites: [{ id: "s", url: "https://s.test/", searchConsoleProperty: "https://s.test/", sitemap: "https://s.test/sitemap.xml", market: { location_code: 2682, languages: ["ar", "en"] }, hreflang }] });
  assert.deepEqual(cfg({ buildDir: "dist", xDefault: true, block: true }), []);
  assert.deepEqual(cfg({ xDefault: "en" }), []);
  assert.ok(cfg({ xDefault: "fr" }).some((e) => e.includes("hreflang.xDefault") && e.includes("not one of this site's languages")));
  assert.ok(cfg({ block: "yes" }).some((e) => e.includes("hreflang.block")));
  assert.ok(cfg({ buildDir: 3 }).some((e) => e.includes("hreflang.buildDir")));
  assert.ok(cfg({ nope: 1 }).some((e) => e.includes("unknown key")));
});

// ---- the job, on a built folder ----
const html = (links) => `<!doctype html><html><head><title>t</title>${links.map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="${h}">`).join("")}</head><body>x</body></html>`;
function project({ hreflang, files, translations = [{ ar: "/ar/store/", en: "/en/store/" }] }) {
  const root = mkdtempSync(join(tmpdir(), "seo-hreflang-")), dist = join(root, "dist");
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(dist, p, ".."), { recursive: true }); writeFileSync(join(dist, p), body); }
  const site = { id: "s", url: `${S}/`, searchConsoleProperty: `${S}/`, sitemap: `${S}/sitemap.xml`, market: { location_code: 2682, languages: ["ar", "en"] }, translations, hreflang, paths: { root, state: join(root, "state") } };
  mkdirSync(site.paths.state, { recursive: true });
  return { root, site };
}
const quiet = async (f) => { const log = console.log; const out = []; console.log = (...a) => out.push(a.join(" ")); const code = process.exitCode; process.exitCode = 0; try { await f(); return { out: out.join("\n"), exit: process.exitCode || 0 }; } finally { console.log = log; process.exitCode = code; } };
const oneWay = { "ar/store/index.html": html([["ar", AR], ["en", EN]]), "en/store/index.html": html([["en", EN]]) };

test("job: a one-way link warns and exits 0 by default, with the report written", async () => {
  const { site } = project({ hreflang: { buildDir: "dist" }, files: oneWay });
  const r = await quiet(() => run({ site, flags: {} }));
  assert.equal(r.exit, 0); assert.match(r.out, /link-one-way/);
  const j = JSON.parse(readFileSync(join(site.paths.state, "hreflang.json"), "utf8"));
  assert.equal(j.blocking, false); assert.equal(j.findings.length, 1);
  assert.ok(existsSync(join(site.paths.state, "hreflang.md")));
});

test("job: block: true makes the same finding exit 1", async () => {
  const { site } = project({ hreflang: { buildDir: "dist", block: true }, files: oneWay });
  assert.equal((await quiet(() => run({ site, flags: {} }))).exit, 1);
});

test("job: a complete pair passes even in block mode, with x-default when asked", async () => {
  const full = html([["ar", AR], ["en", EN], ["x-default", AR]]);
  const { site } = project({ hreflang: { buildDir: "dist", block: true, xDefault: true }, files: { "ar/store/index.html": full, "en/store/index.html": full } });
  const r = await quiet(() => run({ site, flags: {} }));
  assert.equal(r.exit, 0, r.out); assert.match(r.out, /0 problem/);
});

test("job: no groups is a no-op; no page source warns, and fails only in block mode", async () => {
  const none = project({ hreflang: { buildDir: "dist" }, files: {}, translations: undefined });
  assert.equal((await quiet(() => run({ site: none.site, flags: {} }))).exit, 0);
  const noSrc = project({ hreflang: {}, files: oneWay });
  const w = await quiet(() => run({ site: noSrc.site, flags: {} }));
  assert.equal(w.exit, 0); assert.match(w.out, /buildDir|--dir|--live/);
  const b = project({ hreflang: { block: true }, files: oneWay });
  assert.equal((await quiet(() => run({ site: b.site, flags: {} }))).exit, 1);
});

test("job: --live reads the pages from the site", async () => {
  const { site } = project({ hreflang: {}, files: {} });
  const bodies = { [AR]: html([["ar", AR], ["en", EN]]), [EN]: html([["ar", AR], ["en", EN]]) };
  const fetch = async (u) => new Response(bodies[u] || "no", { status: bodies[u] ? 200 : 404, headers: { "content-type": "text/html" } });
  const r = await quiet(() => run({ site, flags: { live: true } }, { fetch }));
  assert.equal(r.exit, 0, r.out);
});

test("job: block and x-default come from the base branch's config, so a pull request cannot loosen the check", async () => {
  const { root, site } = project({ hreflang: { buildDir: "dist", block: false }, files: oneWay });
  const raw = (hreflang) => JSON.stringify({ sites: [{ id: "s", url: `${S}/`, searchConsoleProperty: `${S}/`, sitemap: `${S}/sitemap.xml`, market: { location_code: 2682, languages: ["ar", "en"] }, translations: [{ ar: "/ar/store/", en: "/en/store/" }], hreflang }] });
  const g = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t.test"); g("config", "user.name", "t");
  writeFileSync(join(root, "seo-autopilot.config.json"), raw({ buildDir: "dist", block: true }));
  g("add", "seo-autopilot.config.json"); g("commit", "-q", "-m", "base");
  writeFileSync(join(root, "seo-autopilot.config.json"), raw({ buildDir: "dist", block: false })); // the pull request relaxes it
  const r = await quiet(() => run({ site, flags: { base: "main" } }));
  assert.equal(r.exit, 1, r.out); assert.match(r.out, /base branch/);
});

test("the job is registered", async () => { const m = await JOBS.hreflang(); assert.equal(typeof m.run, "function"); assert.ok(m.description.length > 10); });
