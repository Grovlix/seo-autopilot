// Style guide for one language of the site: the rules in force, and a check of files against them.
//   npx seo-autopilot run style [--language ar] [--out file]            print the rules and write <state>/style-<lang>.md
//   npx seo-autopilot run style --files a.md,b.json [--language ar|all] [--strict]   check files; --strict exits 1 on a [blocking] rule
// The rules are the built-in Modern Standard Arabic guide (knowledge/arabic-msa-style-guide.md, for sites that publish in
// Arabic; "styleGuide": { "builtin": false } turns it off) plus the site's own file for that language ("styleGuide": { "files":
// { "ar": "style/ar.md" } }, a path relative to the config file). The drafting and review prompts (agents, seo-implement,
// seo-review) read the same two files; this job shows them together and finds the phrase- and punctuation-level violations a
// program can find. The rest (calques, register, terms) is the editor's judgement, reported with the rule ID.
import { existsSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson, writeText, today } from "../core/util.mjs";
import { MarketError } from "../lib/market.mjs";
import { siteLanguages } from "../lib/languages.mjs";
import { parseGuide, mergeGuides, renderGuide, lintText, lintMarkdown } from "../analysis/style-guide.mjs";

export const description = "Style guide: show the rules in force for a language (built-in Arabic MSA guide plus the site's own file) and check files against them";

const BUILTIN = { ar: fileURLToPath(new URL("../../knowledge/arabic-msa-style-guide.md", import.meta.url)) };

/** { language, rules, sources } for one language of a site. Throws when the language is not the site's or a named file is missing. */
export function resolveGuide(site, language, root = site.paths?.root) {
  let known = null, primary = null;
  try { ({ languages: known, primary } = siteLanguages(site)); } catch (e) { if (!(e instanceof MarketError)) throw e; }
  const lang = String(language ?? primary ?? "").toLowerCase();
  if (!lang) throw new MarketError('style: no language. Pass --language <code> (for example --language ar), or give the site a "market" with "languages".');
  if (known && !known.includes(lang)) throw new MarketError(`language: "${lang}" is not one of this site's languages [${known.map((x) => `"${x}"`).join(", ")}]. Add it to market.languages, or choose one of those.`);
  const guides = [], sources = [];
  if (BUILTIN[lang] && site.styleGuide?.builtin !== false) { guides.push(parseGuide(readFileSync(BUILTIN[lang], "utf8"), "built-in")); sources.push("built-in"); }
  const file = site.styleGuide?.files?.[lang];
  if (file) {
    const abs = resolve(root || ".", file);
    if (!existsSync(abs)) throw new Error(`styleGuide.files.${lang}: ${file} not found (looked for ${abs}). Create the file or remove the entry from seo-autopilot.config.json.`);
    guides.push(parseGuide(readFileSync(abs, "utf8"), file)); sources.push(file);
  }
  return { language: lang, rules: mergeGuides(...guides).rules, sources };
}

/** Every string in a JSON value with its path: "[0].body". */
function* strings(v, path = "") {
  if (typeof v === "string") yield [path || "(value)", v];
  else if (Array.isArray(v)) for (const [i, x] of v.entries()) yield* strings(x, `${path}[${i}]`);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) yield* strings(x, path ? `${path}.${k}` : k);
}

export async function run({ site, flags = {} }) {
  // --language all: every language of the site (a language with no guide says so and is skipped).
  const wanted = flags.language && flags.language !== true ? String(flags.language) : undefined;
  let languages = [wanted];
  if (wanted === "all") {
    try { languages = siteLanguages(site).languages; } catch (e) { if (!(e instanceof MarketError)) throw e; console.log(`style: ${site.id}: the site has no "market" with languages, so there is nothing to check for "all". Pass --language <code>.`); return; }
  }
  for (const language of languages) await runOne(site, flags, language);
}

async function runOne(site, flags, language) {
  const guide = resolveGuide(site, language);
  if (!guide.rules.length) { console.log(`style: ${site.id}: no style guide for "${guide.language}" (the built-in guide is Arabic; add "styleGuide": { "files": { "${guide.language}": "<file>" } } to the site config).`); return; }
  const text = renderGuide(guide.rules, { language: guide.language });
  const dir = site.paths.state;
  writeText(`${dir}/style-${guide.language}.md`, text);
  if (flags.out && flags.out !== true) writeText(resolve(String(flags.out)), text);
  const files = typeof flags.files === "string" ? flags.files.split(",").map((f) => f.trim()).filter(Boolean) : [];
  if (!files.length) { console.log(`style: ${site.id}: ${guide.rules.length} rule(s) for "${guide.language}" from ${guide.sources.join(" + ")}.\n\n${text}`); return; }

  const results = [];
  for (const f of files) {
    const abs = resolve(site.paths.root || ".", f);
    if (!existsSync(abs)) { results.push({ file: f, violations: [], error: "file not found" }); continue; }
    const raw = readFileSync(abs, "utf8");
    if (extname(abs).toLowerCase() === ".json") {
      let json = null; try { json = JSON.parse(raw); } catch { /* checked as text below */ }
      if (json !== null) { results.push({ file: f, violations: [...strings(json)].flatMap(([where, s]) => lintText(s, guide.rules).map((v) => ({ ...v, where: `${where}${v.line > 1 ? ` (line ${v.line})` : ""}` }))) }); continue; }
    }
    results.push({ file: f, violations: lintText(raw, guide.rules) });
  }
  const violations = results.flatMap((r) => r.violations.map((v) => ({ file: r.file, ...v })));
  const blocking = violations.filter((v) => v.blocking);
  const md = lintMarkdown({ date: today(), language: guide.language, results });
  writeJson(`${dir}/style-lint.json`, { generatedAt: new Date().toISOString(), language: guide.language, sources: guide.sources, files, violations, missing: results.filter((r) => r.error).map((r) => r.file) });
  writeText(`${dir}/style-lint.md`, md);
  console.log(md);
  if (flags.strict && (blocking.length || results.some((r) => r.error))) process.exitCode = 1;
}
