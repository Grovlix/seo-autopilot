// The Search Console country / language filter (opt-in).
import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/core/config.mjs";
import { LOCATIONS, MarketError } from "../src/lib/market.mjs";
import { COUNTRY3, gscCountry, siteLanguages, siteFilterGroups, withSiteFilter } from "../src/lib/search-console-filter.mjs";
import { searchAnalytics } from "../src/lib/google-auth.mjs";

// The fixture turns the country filter on (it is off by default); a test's own searchConsole block is merged over it.
const base = (over = {}) => ({
  id: "shop", url: "https://shop.test/", searchConsoleProperty: "https://shop.test/", sitemap: "https://shop.test/sitemap.xml",
  market: { location_code: 2682, language_code: "ar", languages: ["ar", "en"] }, ...over,
  searchConsole: { country: true, ...over.searchConsole },
});
const plain = (over = {}) => { const s = base(over); if (!over.searchConsole) delete s.searchConsole; return s; };
const cfg = (over) => ({ sites: [base(over)] });
const errs = (over) => validate(cfg(over));

test("every country of the market table has a Search Console country code", () => {
  for (const { country } of LOCATIONS) assert.match(COUNTRY3[country] || "", /^[a-z]{3}$/, `no alpha-3 code for ${country}`);
  assert.equal(gscCountry("SA"), "sau");
  assert.equal(gscCountry("GB"), "gbr");
  assert.equal(gscCountry("XX"), null);
});

test("siteLanguages: the market's languages, the first one is the default", () => {
  assert.deepEqual(siteLanguages(base()), { languages: ["ar", "en"], primary: "ar" });
  assert.throws(() => siteLanguages({ id: "x" }), MarketError);
});

test("searchConsole: validates country, language paths and the root path", () => {
  assert.deepEqual(errs({ searchConsole: { country: "SA", languagePaths: { ar: "/ar/", en: "/" } } }), []);
  assert.deepEqual(errs({ searchConsole: { country: false } }), []);
  assert.ok(errs({ searchConsole: { country: "ZZ" } }).some((e) => e.includes("searchConsole.country")));
  assert.ok(errs({ searchConsole: { languagePaths: { fr: "/fr/" } } }).some((e) => e.includes("languagePaths.fr") && e.includes("not one of this site's languages")));
  assert.ok(errs({ searchConsole: { languagePaths: { ar: "ar/" } } }).some((e) => e.includes("languagePaths.ar") && e.includes("starts with /")));
  assert.ok(errs({ searchConsole: { languagePaths: { ar: "/", en: "/" } } }).some((e) => e.includes("same path")));
  assert.ok(errs({ searchConsole: { extra: 1 } }).some((e) => e.includes("unknown key")));
  assert.ok(errs({ market: undefined, searchConsole: { country: true } }).some((e) => e.includes("country: true uses the market's country")));
  assert.deepEqual(errs({ market: undefined, searchConsole: { country: "SA" } }), []);
  assert.deepEqual(errs({}), [], "no searchConsole block is fine");
});

test("siteFilterGroups: off by default; country: true uses the market's country", () => {
  assert.equal(siteFilterGroups(plain(), {}), undefined, "no searchConsole setting, no filter: existing numbers do not change");
  assert.equal(siteFilterGroups({ ...plain(), searchConsole: {} }, {}), undefined);
  assert.deepEqual(siteFilterGroups(base(), {}), [{ groupType: "and", filters: [{ dimension: "country", operator: "equals", expression: "sau" }] }]);
});

test("siteFilterGroups: no country filter without a market, and a country code overrides the market's", () => {
  assert.equal(siteFilterGroups({ id: "x", url: "https://x.test/" }, {}), undefined);
  assert.equal(siteFilterGroups(base({ searchConsole: { country: false } }), {}), undefined);
  assert.equal(siteFilterGroups(base({ searchConsole: { country: "AE" } }), {})[0].filters[0].expression, "are");
});

test("siteFilterGroups: language paths filter the page, the primary language by default", () => {
  const site = base({ searchConsole: { languagePaths: { ar: "/ar/", en: "/en/" } } });
  const ar = siteFilterGroups(site, {})[0].filters;
  assert.deepEqual(ar[1], { dimension: "page", operator: "includingRegex", expression: "^https://shop\\.test/ar/" });
  assert.deepEqual(siteFilterGroups(site, { language: "en" })[0].filters[1], { dimension: "page", operator: "includingRegex", expression: "^https://shop\\.test/en/" });
  assert.equal(siteFilterGroups(site, { language: "all" })[0].filters.length, 1, "all: country only");
});

test("siteFilterGroups: the root language excludes the other languages' folders", () => {
  const site = base({ market: { location_code: 2682, languages: ["en", "ar"] }, searchConsole: { languagePaths: { ar: "/ar/", en: "/" } } });
  assert.deepEqual(siteFilterGroups(site, { language: "en" })[0].filters[1], { dimension: "page", operator: "excludingRegex", expression: "^https://shop\\.test/ar/" });
});

test("siteFilterGroups: an unknown language fails loud", () => {
  const site = base({ searchConsole: { languagePaths: { ar: "/ar/", en: "/en/" } } });
  assert.throws(() => siteFilterGroups(site, { language: "fr" }), (e) => e instanceof MarketError && /not one of this site's languages/.test(e.message));
  assert.throws(() => siteFilterGroups(site, { language: "xx" }), MarketError);
  // A declared language without a path: say so instead of silently not filtering.
  const half = base({ searchConsole: { languagePaths: { ar: "/ar/" } } });
  assert.throws(() => siteFilterGroups(half, { language: "en" }), /no page path/);
});

test("withSiteFilter: merges with a filter the caller already set and leaves the country dimension alone", () => {
  const site = base();
  const own = { dimension: "query", operator: "contains", expression: "x" };
  const body = withSiteFilter(site, { startDate: "a", dimensions: ["query"], dimensionFilterGroups: [{ groupType: "and", filters: [own] }] }, {});
  assert.deepEqual(body.dimensionFilterGroups[0].filters, [own, { dimension: "country", operator: "equals", expression: "sau" }]);
  const byCountry = withSiteFilter(site, { dimensions: ["country"] }, {});
  assert.equal(byCountry.dimensionFilterGroups, undefined, "a country breakdown must not be filtered to one country");
});

test("searchAnalytics sends the filter to Search Console (the daily, rank, research and digest jobs all go through it)", async () => {
  const sent = [];
  const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ rows: [{ keys: ["q"], clicks: 1 }] }), { headers: { "content-type": "application/json" } }); };
  const site = base({ searchConsole: { languagePaths: { ar: "/ar/", en: "/en/" } } });
  const q = searchAnalytics(site, "tok", { fetch, language: "en" });
  const rows = await q("2026-01-01", "2026-01-28", ["query"], 10);
  assert.equal(rows.length, 1);
  assert.deepEqual(sent[0].dimensionFilterGroups[0].filters.map((f) => `${f.dimension}:${f.operator}:${f.expression}`), ["country:equals:sau", "page:includingRegex:^https://shop\\.test/en/"]);
  assert.deepEqual(sent[0].dimensions, ["query"]);
});

test("gsc job: web queries are filtered to the country and language, the country breakdown is not, and the filter is in the report", async () => {
  const { mkdtempSync, mkdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { run } = await import("../src/jobs/gsc.mjs");
  const state = join(mkdtempSync(join(tmpdir(), "seo-lang-gsc-")), "state"); mkdirSync(state, { recursive: true });
  const bodies = [];
  const api = { sitemaps: async () => [], query: async (b) => { bodies.push(b); return []; } };
  const site = { ...base({ searchConsole: { languagePaths: { ar: "/ar/", en: "/en/" } } }), name: "S", paths: { state } };
  const log = console.log; console.log = () => {};
  try { await run({ site, flags: { language: "en" } }, { api, today: "2026-10-23" }); } finally { console.log = log; }
  const web = bodies.find((b) => b.type === "web" && !b.dimensions.length);
  assert.deepEqual(web.dimensionFilterGroups[0].filters.map((f) => f.dimension + ":" + f.expression), ["country:sau", "page:^https://shop\\.test/en/"]);
  const byCountry = bodies.find((b) => b.dimensions[0] === "country");
  assert.equal(byCountry.dimensionFilterGroups?.[0].filters.some((f) => f.dimension === "country"), false);
  assert.equal(byCountry.dimensionFilterGroups[0].filters.some((f) => f.dimension === "page"), true, "language still applies to the country breakdown");
  assert.equal(JSON.parse(readFileSync(join(state, "gsc.json"), "utf8")).filter.length, 2);
  // an unknown language stops the job before any request
  const before = bodies.length;
  await assert.rejects(run({ site, flags: { language: "fr" } }, { api, today: "2026-10-23" }), MarketError);
  assert.equal(bodies.length, before);
});
