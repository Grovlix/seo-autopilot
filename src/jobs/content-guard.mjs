// Content-loss guard for a pull request (run by seo-check before the build, so the pull request's own code has not run yet).
//   npx seo-autopilot run content-guard --base origin/main [--branch seo/issue-12] [--files a.md,b.json]
//                                       [--labels a,b] [--events events.jsonl] [--author login]
// Compares every changed content page (Markdown/MDX, HTML, JSON page lists) between the merge base and HEAD and fails
// (exit 1) when a page lost more than contentGuard.maxWordDropPercent of its words (default 15), or any heading, internal
// link, image or structured data, or when a page or its file was removed. New pages get warnings only (empty, no H1, no
// internal link). Writes <state>/<site>/content-guard.json and .md and adds the table to the GitHub job summary.
//
// The settings are read from the BASE version of seo-autopilot.config.json, so a pull request cannot loosen its own check.
// Human-only override: the label "allow-content-shrink", added by a person who is not the pull request's author (checked
// from the pull request's events; a Bot never counts). The autopilot and the agents never add it.
// A seo/revert-<n> branch that restores exactly the version of a file before its most recent change passes for that file
// (it puts back what was there), but only when the pull request is an undo opened by seo-watch: authored by the watch's
// account and labelled seo-revert by that same account (revertTrusted). A branch name alone proves nothing.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { writeJson, writeText, today } from "../core/util.mjs";
import { CONFIG_NAME } from "../core/config.mjs";
import { guardFiles, guardTable, overrideApplied, revertTrusted, GUARD_DEFAULTS, OVERRIDE_LABEL } from "../analysis/content-loss.mjs";

export const description = "Content-loss guard: fail a pull request whose changed pages lose words (>15%), headings, internal links, images or structured data";

const CONTENT_EXT = /\.(md|mdx|markdown|mdoc|html?|json)$/i;
const NEVER = /(^|\/)(node_modules|\.github|\.git|\.claude|dist|build|\.next|vendor)\//i;
const NOT_CONTENT = /(^|\/)(package(-lock)?\.json|composer\.(json|lock)|tsconfig[^/]*\.json|jsconfig\.json|\.?eslintrc[^/]*|renovate\.json|vercel\.json|netlify\.toml|seo-autopilot\.config\.json|CHANGELOG\.md|LICENSE\.md|CODE_OF_CONDUCT\.md|CONTRIBUTING\.md|SECURITY\.md)$/i;

const git = (root, args) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const show = (root, rev, path) => { const r = git(root, ["show", `${rev}:./${path}`]); return r.status === 0 ? r.stdout : null; };
const list = (v) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

/** JSON array or one JSON object per line (gh api --jq '.[]' output). */
function readEvents(file) {
  if (!file || !existsSync(String(file))) return [];
  const raw = readFileSync(String(file), "utf8").trim();
  if (!raw) return [];
  try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [j]; } catch { /* JSON lines */ }
  return raw.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Settings from the base branch's config (never from the pull request), falling back to the defaults. */
function baseSettings(root, mb, siteId) {
  let raw = null;
  try { raw = JSON.parse(show(root, mb, CONFIG_NAME) || "null"); } catch { /* unreadable: defaults */ }
  const s = (raw?.sites || []).find((x) => x?.id === siteId) || {};
  const n = Number(s.contentGuard?.maxWordDropPercent);
  return { maxWordDropPercent: Number.isFinite(n) && n >= 0 && n <= 100 ? n : GUARD_DEFAULTS.maxWordDropPercent, fromBase: Boolean(raw) };
}

export async function run({ site, cfg, flags = {} }) {
  const root = site.paths.root;
  const base = String(flags.base || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main"));
  const mbr = git(root, ["merge-base", base, "HEAD"]);
  if (mbr.status !== 0) { console.log(`content-guard: cannot find the merge base of ${base} and HEAD (${(mbr.stderr || "").trim()}). Fetch the base branch (actions/checkout with fetch-depth: 0).`); process.exitCode = 1; return; }
  const mb = mbr.stdout.trim();
  const settings = baseSettings(root, mb, site.id);
  const branch = String(flags.branch || process.env.GITHUB_HEAD_REF || "");

  let files = list(flags.files);
  if (!files.length) {
    const d = git(root, ["diff", "--name-only", "--no-renames", mb, "HEAD"]);
    files = d.status === 0 ? d.stdout.split("\n").filter(Boolean) : [];
  }
  const skip = (f) => {
    const rel = f.split("\\").join("/");
    if (!CONTENT_EXT.test(rel) || NEVER.test(rel) || NOT_CONTENT.test(rel)) return true;
    for (const dir of [cfg?.stateDir, cfg?.dataDir, site.paths.data]) if (dir) { const r = relative(root, dir).split("\\").join("/"); if (r && !r.startsWith("..") && (rel === r || rel.startsWith(r + "/"))) return true; }
    return false;
  };
  files = files.filter((f) => !skip(f));
  const labels = list(flags.labels), events = readEvents(flags.events), author = String(flags.author || "");
  const revert = /^seo\/revert-/.test(branch) ? revertTrusted({ branch, author, labels, events }) : null;

  const input = files.map((path) => {
    const before = show(root, mb, path), after = show(root, "HEAD", path);
    let restores = false;
    // An undo: on a seo/revert-* branch, the file is exactly what it was before the latest change to it on the base branch.
    if (revert?.trusted) {
      const last = git(root, ["log", "-1", "--format=%H", mb, "--", path]).stdout?.trim();
      if (last && git(root, ["rev-parse", "--verify", "-q", `${last}^`]).status === 0 && show(root, `${last}^`, path) === after) restores = last.slice(0, 7);
    }
    return { path, before, after, restores };
  });

  const result = guardFiles(input, { siteUrl: site.url, maxWordDropPercent: settings.maxWordDropPercent });
  const override = result.failed ? overrideApplied({ labels, events, author }) : null;
  const table = guardTable(result, { override, maxWordDropPercent: settings.maxWordDropPercent });
  const md = `# Content-loss guard (${today()})\n\nCompared with ${base} (merge base ${mb.slice(0, 7)}); settings from ${settings.fromBase ? "the base branch's config" : "the defaults"}.\n\n${revert ? `${revert.trusted ? "Undo opened by seo-watch" : "Revert branch NOT trusted, so restored content is checked like any change"}: ${revert.reason}.\n\n` : ""}${table}${override && !override.applied && labels.includes(OVERRIDE_LABEL) ? `\nOverride not applied: ${override.reason}.\n` : ""}`;
  const strip = (p) => ({ ...p, before: p.before && { words: p.before.words, headings: p.before.headings.length, links: p.before.links.length, images: p.before.images.length, schema: p.before.schema }, after: p.after && { words: p.after.words, headings: p.after.headings.length, links: p.after.links.length, images: p.after.images.length, schema: p.after.schema } });
  writeJson(`${site.paths.state}/content-guard.json`, { generatedAt: new Date().toISOString(), base, mergeBase: mb, branch, revert, settings, failed: result.failed, checked: result.checked, override, pages: result.pages.map(strip) });
  writeText(`${site.paths.state}/content-guard.md`, md);
  if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* no summary file */ } }
  console.log(md);
  if (result.failed && !override?.applied) process.exitCode = 1;
}
