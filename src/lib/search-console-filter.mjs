// Search Console queries kept to one country and one language of a site. Pure: no network, no writes.
//
// Config (per site, both parts optional and off by default, so existing projects see the same numbers as before):
//   "searchConsole": { "country": true, "languagePaths": { "ar": "/ar/", "en": "/en/" } }
//     country: true (the market's country), a two-letter code (that country) or false / absent (no country filter)
//     languagePaths: where each language lives on the site; a language at the root ("/") means "everything outside the others".
//       Needs the site's market, which lists the languages (src/lib/market.mjs); the first one is the default.
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
const marketLanguages = (market) => { try { return resolveMarket(market, "market").languages; } catch { return null; } };

/** A language code that must be one of the site's: MarketError text for `key`, or null when fine. */
function languageError(code, languages, key) {
  try { parseLanguage(code, key); } catch (e) { if (e instanceof MarketError) return e.message; throw e; }
  const c = code.toLowerCase();
  return languages.includes(c) ? null : `${key}: "${c}" is not one of this site's languages [${languages.map((x) => `"${x}"`).join(", ")}]. Add it to market.languages, or remove it here.`;
}

/** Config errors for a site's `searchConsole` block. */
export function validateSearchConsole(raw, owner, site) {
  const key = `${owner}.searchConsole`, out = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${key} must be an object, for example { "country": true, "languagePaths": { "ar": "/ar/", "en": "/en/" } }`];
  const extra = Object.keys(raw).filter((k) => !["country", "languagePaths"].includes(k));
  if (extra.length) out.push(`${key}: unknown key ${extra.map((k) => `"${k}"`).join(", ")}. Allowed: country, languagePaths`);
  const c = raw.country;
  if (c != null && c !== true && c !== false && !(typeof c === "string" && gscCountry(c))) out.push(`${key}.country must be true, false or a two-letter country code such as "SA"`);
  if (c === true && site.market == null) out.push(`${key}.country: true uses the market's country, so the site needs a "market" (or give a country code such as "SA")`);
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
 * `dimensionFilterGroups` for a site's Search Console queries: its country when `searchConsole.country` asks for it (true: the
 * market's, or a country code) and, when the site declares language paths, one language (the primary one unless `language` says
 * otherwise; "all" for every language). undefined when nothing applies. Throws MarketError for an unknown language.
 */
export function siteFilterGroups(site, { language, country = true } = {}) {
  const filters = [];
  const sc = site?.searchConsole || {};
  if (country && sc.country) {
    const code = typeof sc.country === "string" ? gscCountry(sc.country) : site?.market != null ? gscCountry(resolveMarket(site.market, `site "${site.id}"`).country) : null;
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
