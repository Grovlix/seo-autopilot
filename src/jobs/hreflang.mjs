// hreflang pair check for the site's declared translation groups (config "translations"), run by seo-check after the build.
//   npx seo-autopilot run hreflang [--dir dist] [--live] [--base origin/main] [--repo <checkout>]
// For every group, each page must link to the other languages' pages (and to itself), and the other pages must link back;
// with hreflang.xDefault each page also needs hreflang="x-default". Pages are read from the build folder (hreflang.buildDir or
// --dir) or, with --live, from the site. Warns and exits 0 by default; "hreflang": { "block": true } makes a problem exit 1.
// With --base, block, xDefault and buildDir are read from the base branch's config (a pull request cannot loosen its own
// check) and the groups are the base branch's plus the loaded config's (a pull request cannot drop a pair to dodge it).
// Writes <state>/hreflang.json and .md and adds the table to the GitHub job summary. Edits nothing else.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { writeJson, writeText, today } from "../core/util.mjs";
import { CONFIG_NAME } from "../core/config.mjs";
import { gitShow } from "../lib/git-history.mjs";
import { translationGroups, siteLanguages } from "../lib/languages.mjs";
import { extractPage } from "../audit/extract.mjs";
import { fetchPage } from "../audit/crawl.mjs";
import { checkHreflang, pagePathCandidates, hreflangMarkdown } from "../analysis/hreflang.mjs";

export const description = "hreflang pairs: for each declared translation group, reciprocal hreflang links (and x-default if asked); warns, or blocks with hreflang.block";

/** Settings and groups. With a base ref, the settings come from that revision's config; groups are the union. */
function settings(site, flags) {
  const own = { block: site.hreflang?.block === true, xDefault: site.hreflang?.xDefault ?? false, buildDir: site.hreflang?.buildDir ?? null };
  const groups = translationGroups(site);
  if (!flags.base || flags.base === true) return { ...own, groups, fromBase: false };
  const root = flags.repo && flags.repo !== true ? resolve(String(flags.repo)) : site.paths.root;
  let raw = null;
  try { raw = JSON.parse(gitShow(root, String(flags.base), CONFIG_NAME) || "null"); } catch { /* unreadable: treated as missing */ }
  const b = raw && (raw.sites || []).find((x) => x?.id === site.id);
  if (!b) return { ...own, groups, fromBase: false, note: `The base branch (${flags.base}) has no config for this site, so the loaded config's settings were used.` };
  let baseGroups = [];
  try { baseGroups = translationGroups(b); } catch { /* an invalid base block adds no groups */ }
  const seen = new Set(groups.map((g) => JSON.stringify(g)));
  return { block: b.hreflang?.block === true, xDefault: b.hreflang?.xDefault ?? false, buildDir: b.hreflang?.buildDir ?? own.buildDir, groups: [...groups, ...baseGroups.filter((g) => !seen.has(JSON.stringify(g)))], fromBase: true };
}

function readBuilt(dir, url) {
  for (const rel of pagePathCandidates(url)) {
    const file = resolve(dir, `.${rel}`), back = relative(dir, file);
    if (back.startsWith("..") || isAbsolute(back)) continue;
    if (existsSync(file)) return { found: true, html: readFileSync(file, "utf8") };
  }
  return { found: false, error: `no file for ${new URL(url).pathname} in ${dir}` };
}

/** `deps`: fetch (for --live). For tests. */
export async function run({ site, flags = {} }, deps = {}) {
  const s = settings(site, flags);
  if (!s.groups.length) { console.log(`hreflang: ${site.id}: no translation groups declared ("translations" in the site config), nothing to check.`); return; }
  const xDefault = s.xDefault === true ? siteLanguages(site).primary : s.xDefault || false;
  const dirFlag = flags.dir && flags.dir !== true ? String(flags.dir) : null;
  const dir = dirFlag ? resolve(dirFlag) : s.buildDir ? resolve(site.paths.root, s.buildDir) : null;
  const live = flags.live === true;
  const stop = (msg) => { console.log(`hreflang: ${site.id}: ${msg}`); if (s.block) process.exitCode = 1; };
  if (!dir && !live) return stop(`no page source. Set "hreflang": { "buildDir": "dist" } (the folder your build writes), or pass --dir <folder>, or --live to read the published pages. ${s.block ? "hreflang.block is true, so this fails." : "Skipped."}`);
  if (dir && !live && !existsSync(dir)) return stop(`the build folder ${dir} does not exist. Run the build first. ${s.block ? "hreflang.block is true, so this fails." : "Skipped."}`);

  const pages = {};
  for (const url of new Set(s.groups.flatMap((g) => Object.values(g)))) {
    if (live) {
      const r = await fetchPage(url, { fetchImpl: deps.fetch || fetch });
      pages[url] = r.status === 200 && r.isHtml ? { found: true, alternates: extractPage(r.html, url).alternates } : { found: false, error: `${url} answered ${r.status || r.error || "with no page"}` };
    } else {
      const r = readBuilt(dir, url);
      pages[url] = r.found ? { found: true, alternates: extractPage(r.html, url).alternates } : r;
    }
  }
  const result = checkHreflang({ groups: s.groups, pages, xDefault });
  const blocking = s.block && result.findings.length > 0;
  const source = live ? "the live site" : dir;
  const notes = [s.fromBase ? "Settings come from the base branch's config." : s.note || ""].filter(Boolean);
  const md = hreflangMarkdown({ date: today(), groups: s.groups, result, blocking, source, notes });
  writeJson(`${site.paths.state}/hreflang.json`, { generatedAt: new Date().toISOString(), source, groups: s.groups.length, checked: result.checked, xDefault, blocking, fromBase: s.fromBase, findings: result.findings });
  writeText(`${site.paths.state}/hreflang.md`, md);
  if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* no summary file */ } }
  console.log(md);
  if (process.env.GITHUB_ACTIONS === "true") for (const f of result.findings) console.log(`::${blocking ? "error" : "warning"}::hreflang ${f.id}: ${f.detail}`);
  if (blocking) process.exitCode = 1;
}
