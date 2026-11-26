// Languages of a site, translation groups (the same page in each language) and the Search Console filter that keeps one
// country and one language apart from the rest. Pure: no network, no writes. Generic: nothing here knows a site or a script.
//
// Config (per site). The languages themselves are the market's (src/lib/market.mjs): "market": { ..., "languages": ["ar", "en"] },
// the first one is the default. On top of them:
//   "translations": [ { "ar": "/ar/store/", "en": "/en/store/" } ]       each group is one page in each of its languages
//   "searchConsole": { "country": true, "languagePaths": { "ar": "/ar/", "en": "/en/" } }
//     country: true (default: the market's country), false (no country filter) or a two-letter code that overrides it
//     languagePaths: where each language lives on the site; a language at the root ("/") means "everything outside the others"
// An unknown language code, or one the site does not list, is an error that names the key. Nothing is guessed.
import { resolveMarket, parseLanguage, MarketError } from "./market.mjs";

// ISO 3166-1 alpha-2 -> the lower-case alpha-3 code Search Console's `country` filter takes, for every country of the market table.
export const COUNTRY3 = {
  US: "usa", GB: "gbr", CA: "can", AU: "aus", NZ: "nzl", IE: "irl", ZA: "zaf", SA: "sau", AE: "are", EG: "egy", KW: "kwt", QA: "qat",
  BH: "bhr", OM: "omn", JO: "jor", LB: "lbn", IQ: "irq", MA: "mar", DZ: "dza", TN: "tun", DE: "deu", FR: "fra", ES: "esp", IT: "ita",
  NL: "nld", BE: "bel", CH: "che", AT: "aut", PT: "prt", PL: "pol", SE: "swe", NO: "nor", DK: "dnk", FI: "fin", GR: "grc", CZ: "cze",
  RO: "rou", HU: "hun", TR: "tur", RU: "rus", UA: "ukr", IL: "isr", IN: "ind", PK: "pak", JP: "jpn", KR: "kor", SG: "sgp", MY: "mys",
  ID: "idn", PH: "phl", TH: "tha", VN: "vnm", HK: "hkg", TW: "twn", BR: "bra", MX: "mex", AR: "arg", CO: "col", CL: "chl", NG: "nga", KE: "ken",
};
/** Search Console country code for a two-letter country code, or null. */
export const gscCountry = (alpha2) => COUNTRY3[String(alpha2 || "").toUpperCase()] ?? null;

/** { languages, primary } of a site: the market's languages, the first one is the default. Throws MarketError when there is no market. */
export function siteLanguages(site) {
  const m = resolveMarket(site?.market, `site "${site?.id ?? "?"}"`);
  return { languages: m.languages, primary: m.languageCode };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const origin = (site) => new URL(site.url).origin;
const absolute = (site, p) => new URL(p, site.url).href;
const local = (site, v) => typeof v === "string" && (v.startsWith("/") || v.startsWith(site.url));
const marketLanguages = (market) => { try { return resolveMarket(market, "market").languages; } catch { return null; } };

/** A language code that must be one of the site's: MarketError text for `key`, or null when fine. */
function languageError(code, languages, key) {
  try { parseLanguage(code, key); } catch (e) { if (e instanceof MarketError) return e.message; throw e; }
  const c = code.toLowerCase();
  return languages.includes(c) ? null : `${key}: "${c}" is not one of this site's languages [${languages.map((x) => `"${x}"`).join(", ")}]. Add it to market.languages, or remove it here.`;
}

/** Config errors for a site's `translations`. `market` is the site's raw market block, `site` the raw site. */
export function validateTranslations(raw, owner, site) {
  const key = `${owner}.translations`, out = [];
  if (!Array.isArray(raw)) return [`${key} must be a list of groups, for example [{ "ar": "/ar/store/", "en": "/en/store/" }]`];
  const languages = marketLanguages(site.market);
  if (!languages) return [`${key} needs the site's languages: add a "market" with "languages" (for example ["ar", "en"]) first`];
  const seen = new Map();
  raw.forEach((g, i) => {
    const w = `${key}[${i}]`;
    if (!g || typeof g !== "object" || Array.isArray(g)) { out.push(`${w} must be an object of language code to page, for example { "ar": "/ar/store/", "en": "/en/store/" }`); return; }
    const entries = Object.entries(g);
    if (entries.length < 2) out.push(`${w} must name at least two languages (a page and its translation)`);
    for (const [lang, page] of entries) {
      const bad = languageError(lang, languages, `${w}.${lang}`);
      if (bad) { out.push(bad); continue; }
      if (!local(site, page)) { out.push(`${w}.${lang} must be a page of this site: a path that starts with / or a URL that starts with ${site.url || "the site's address"} (got ${JSON.stringify(page)})`); continue; }
      const url = site.url ? absolute(site, page) : page;
      if (seen.has(url)) out.push(`${w}.${lang}: ${page} is already in two groups (translations[${seen.get(url)}] and translations[${i}]). A page has one set of translations`);
      else seen.set(url, i);
    }
  });
  return out;
}

/** Config errors for a site's `searchConsole` block. */
export function validateSearchConsole(raw, owner, site) {
  const key = `${owner}.searchConsole`, out = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${key} must be an object, for example { "country": true, "languagePaths": { "ar": "/ar/", "en": "/en/" } }`];
  const extra = Object.keys(raw).filter((k) => !["country", "languagePaths"].includes(k));
  if (extra.length) out.push(`${key}: unknown key ${extra.map((k) => `"${k}"`).join(", ")}. Allowed: country, languagePaths`);
  const c = raw.country;
  if (c != null && c !== true && c !== false && !(typeof c === "string" && gscCountry(c))) out.push(`${key}.country must be true, false or a two-letter country code such as "SA"`);
  if (raw.languagePaths != null) {
    const lp = raw.languagePaths;
    if (typeof lp !== "object" || Array.isArray(lp)) { out.push(`${key}.languagePaths must be an object of language code to path, for example { "ar": "/ar/", "en": "/en/" }`); return out; }
    const languages = marketLanguages(site.market);
    if (!languages) return [...out, `${key}.languagePaths needs the site's languages: add a "market" with "languages" first`];
    const roots = [];
    for (const [lang, path] of Object.entries(lp)) {
      const bad = languageError(lang, languages, `${key}.languagePaths.${lang}`);
      if (bad) { out.push(bad); continue; }
      if (typeof path !== "string" || !path.startsWith("/")) { out.push(`${key}.languagePaths.${lang} must be a path that starts with /, for example "/${lang}/"`); continue; }
      if (path === "/") roots.push(lang);
    }
    if (roots.length > 1) out.push(`${key}.languagePaths: ${roots.join(" and ")} have the same path "/". Only one language can live at the root`);
  }
  return out;
}

/** Config errors for a site's `hreflang` block (the check itself is src/jobs/hreflang.mjs). */
export function validateHreflang(raw, owner, site) {
  const key = `${owner}.hreflang`, out = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${key} must be an object, for example { "buildDir": "dist", "xDefault": true, "block": false }`];
  const extra = Object.keys(raw).filter((k) => !["buildDir", "xDefault", "block"].includes(k));
  if (extra.length) out.push(`${key}: unknown key ${extra.map((k) => `"${k}"`).join(", ")}. Allowed: buildDir, xDefault, block`);
  if (raw.buildDir != null && (typeof raw.buildDir !== "string" || !raw.buildDir.trim())) out.push(`${key}.buildDir must be the folder the build writes the pages to, for example "dist"`);
  if (raw.block != null && typeof raw.block !== "boolean") out.push(`${key}.block must be true or false`);
  const x = raw.xDefault;
  if (x != null && typeof x !== "boolean") {
    const languages = marketLanguages(site.market);
    if (!languages) out.push(`${key}.xDefault names a language, so the site needs a "market" with "languages" first`);
    else { const bad = languageError(x, languages, `${key}.xDefault`); if (bad) out.push(bad); }
  }
  return out;
}

/** Translation groups as absolute URLs: [{ ar: "https://site/ar/x/", en: "https://site/en/x/" }]. Throws on a bad group. */
export function translationGroups(site) {
  if (site?.translations == null) return [];
  const errors = validateTranslations(site.translations, `site "${site.id}"`, site);
  if (errors.length) throw new MarketError(errors.join("\n"));
  return site.translations.map((g) => Object.fromEntries(Object.entries(g).map(([l, p]) => [l.toLowerCase(), absolute(site, p)])));
}

/** The page filter for one language of the site, or null when the site declares no paths. Throws MarketError on an unknown language. */
function languageFilter(site, language) {
  const paths = site.searchConsole?.languagePaths;
  if (!paths) return null;
  const { languages, primary } = siteLanguages(site);
  const want = language == null ? primary : String(language).toLowerCase();
  if (want === "all") return null;
  const bad = languageError(want, languages, "language");
  if (bad) throw new MarketError(bad);
  const own = paths[want];
  if (own == null) throw new MarketError(`language: "${want}" has no page path in searchConsole.languagePaths ([${Object.keys(paths).map((x) => `"${x}"`).join(", ")}]). Add it, or the numbers for "${want}" cannot be told apart.`);
  const o = origin(site);
  if (own !== "/") return { dimension: "page", operator: "includingRegex", expression: `^${esc(o)}${esc(own)}` };
  const others = Object.entries(paths).filter(([l, p]) => l !== want && p !== "/").map(([, p]) => `${esc(o)}${esc(p)}`);
  if (!others.length) return null;
  return { dimension: "page", operator: "excludingRegex", expression: others.length === 1 ? `^${others[0]}` : `^(${others.join("|")})` };
}

/**
 * `dimensionFilterGroups` for a site's Search Console queries: its country (the market's, unless switched off) and, when the
 * site declares language paths, one language (the primary one unless `language` says otherwise; "all" for every language).
 * undefined when nothing applies. Throws MarketError for an unknown language.
 */
export function siteFilterGroups(site, { language, country = true } = {}) {
  const filters = [];
  const sc = site?.searchConsole || {};
  if (site?.market != null && country && sc.country !== false) {
    const code = typeof sc.country === "string" ? gscCountry(sc.country) : gscCountry(resolveMarket(site.market, `site "${site.id}"`).country);
    if (code) filters.push({ dimension: "country", operator: "equals", expression: code });
  }
  if (site?.market != null) { const f = languageFilter(site, language); if (f) filters.push(f); }
  return filters.length ? [{ groupType: "and", filters }] : undefined;
}

/**
 * A Search Console request body with the site's filters added to whatever filters the caller set. A query broken down by
 * country is never filtered to one country.
 */
export function withSiteFilter(site, body, { language } = {}) {
  const groups = siteFilterGroups(site, { language, country: !(body.dimensions || []).includes("country") });
  if (!groups) return body;
  const own = body.dimensionFilterGroups?.length ? body.dimensionFilterGroups : [{ groupType: "and", filters: [] }];
  const [first, ...rest] = own;
  return { ...body, dimensionFilterGroups: [{ ...first, groupType: "and", filters: [...(first.filters || []), ...groups[0].filters] }, ...rest] };
}
