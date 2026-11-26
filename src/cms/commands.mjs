// seo-autopilot cms <export|validate|draft|publish|discard|preview-check|schema>: keep CMS posts as Markdown files in git.
//
//   export          read every published post, write <dir>/<slug>.md (only posts that convert back unchanged)
//   validate        check mirror files (and, with --base-ref, what a pull request changed); no network
//   draft           save one file as a CMS draft (live page unchanged) and ask for a preview link
//   publish         save one file as a draft, publish it, then set its SEO fields; also used to revert (publish the old file)
//   discard         remove the pending draft that draft made from one file (a closed pull request's preview); live unchanged
//   preview-check   create one throwaway draft and prove it is invisible to the public and has a preview link
//   schema          can the token read the collection settings; are revisions and SEO on
//
// Connection: EMDASH_URL (or --url) and EMDASH_TOKEN (environment only, never a flag). Writes refuse to run on a live
// post unless the collection is known to keep drafts apart from the live post (see writeGuard below).
// Output: a JSON report on stdout. Exit codes: 0 ok, 1 error or invalid files, 2 published but the CMS does not match
// the file afterwards (or a discard moved the live post), 3 refused for safety (conflict, unknown revisions setting, slug
// taken; "refusal" in the report names the reason), 4 discard found no pending draft (nothing was done).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname, basename, resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createClient, revisionsSupported, EmDashError } from "./emdash.mjs";
import { parseMirror, stringifyMirror, itemToMirror, stateOfItem, stateOfFile, diffState, partsFor, sameState, readOnlyOf, validateFile, validateSet, draftData, draftMatches, seoPayload, writePlan, DEFAULT_FIELDS, LATIN_SLUG } from "./mirror.mjs";
import { fromMarkdown, countWords } from "./portable-text.mjs";
import { mainScope, visibleText } from "../audit/extract.mjs";

/** A refusal for safety (exit 3). code: a short machine-readable reason ("foreign-draft", "live-changed", ...). */
class Refused extends Error { constructor(msg, code = null) { super(msg); this.exit = 3; this.refusal = code; } }

/**
 * Why a post file may not be read or written, or null. A post file is a regular file directly inside the posts folder:
 * never a symbolic link (x.md -> ../../.git/config) and never a path that resolves somewhere else. A missing file is
 * null (the caller decides).
 */
export function unsafePostFile(file, dir = dirname(file)) {
  let st;
  try { st = lstatSync(file); } catch { return null; }
  if (st.isSymbolicLink()) return `${file} is a symbolic link; post files must be plain files`;
  if (!st.isFile()) return `${file} is not a plain file`;
  try { if (dirname(realpathSync(file)) !== realpathSync(dir)) return `${file} is not inside the posts folder ${dir}`; }
  catch (e) { return `${file}: ${e.code || e.message}`; }
  return null;
}

/**
 * Why a mirror folder may not be used, or null. It must sit inside the git repository that holds it (or, outside any
 * repository, inside the working folder), and no part of its path below that point may be a symbolic link: a linked
 * folder (posts -> ../../elsewhere) would let validate read and export write outside the repository. Links above the
 * repository (macOS /var -> /private/var) do not count. The folder need not exist yet (export creates it).
 */
export function mirrorFolderProblem(dir) {
  const abs = resolve(dir);
  // The repository is found along the path as written (git itself would follow a linked folder out of it).
  let anchor = null;
  for (let p = abs; ; p = dirname(p)) { if (existsSync(join(p, ".git"))) { anchor = p; break; } if (dirname(p) === p) break; }
  const kind = anchor ? "the git repository" : "the working folder";
  anchor ??= process.cwd();
  const under = relative(anchor, abs);
  if (under.startsWith("..") || isAbsolute(under)) return `mirror folder ${dir} is not inside ${kind} ${anchor}`;
  for (let p = abs; p !== anchor && dirname(p) !== p; p = dirname(p)) {
    let st = null;
    try { st = lstatSync(p); } catch { /* not created yet */ }
    if (st?.isSymbolicLink()) return `mirror folder ${dir}: ${p} is a symbolic link; the mirror folder must be a plain folder inside ${kind} ${anchor}`;
  }
  let start = abs;
  while (!existsSync(start)) start = dirname(start);
  const real = relative(realpathSync(anchor), realpathSync(start));
  if (real.startsWith("..") || isAbsolute(real)) return `mirror folder ${dir} is not inside ${kind} ${anchor}`;
  return null;
}
function checkFolder(dir) { const bad = mirrorFolderProblem(dir); if (bad) throw new Refused(bad); }

// A CMS slug becomes a file name: it must not hold path characters or start with a dot (EmDash 0.1.0 stores an
// explicit slug as given, so "../../x" is possible).
const unsafeSlug = (slug) => /[\/\\\0]/.test(slug) || slug.startsWith(".");

// --settings <file.json>: the site's settings (collection, urlPattern, fields, taxonomies, slugPattern, sitemap, rss,
// revisionsProven). Flags override them, except revisionsProven: when the settings file has it, only the file decides,
// so a person turns writes on by committing "revisionsProven": true after preview-check, not a job by passing a flag.
function options(flags) {
  const st = flags.settings ? JSON.parse(readFileSync(String(flags.settings), "utf8")) : {};
  const pick = (flag, key, dflt) => flags[flag] ?? st[key] ?? dflt;
  const collection = String(pick("collection", "collection", "posts"));
  const fields = { ...DEFAULT_FIELDS };
  for (const src of [st.fields, flags.fields]) for (const pair of String(src || "").split(",").filter(Boolean)) { const [k, v] = pair.split("="); if (k && v) fields[k.trim()] = v.trim(); }
  const fromSettings = typeof st.revisionsProven === "boolean";
  const slugPattern = pick("slug-pattern", "slugPattern", null);
  return {
    collection, fields,
    urlPattern: String(pick("url-pattern", "urlPattern", `/${collection}/{slug}`)),
    taxonomies: String(pick("taxonomies", "taxonomies", "category,tag")).split(",").map((s) => s.trim()).filter(Boolean),
    slugPattern: slugPattern ? new RegExp(String(slugPattern)) : LATIN_SLUG,
    sitemap: pick("sitemap", "sitemap", null),
    rss: pick("rss", "rss", null),
    revisionsProven: fromSettings ? st.revisionsProven === true : flags["revisions-proven"] === true || flags["revisions-proven"] === "true" || process.env.EMDASH_REVISIONS_PROVEN === "true",
    revisionsProvenFrom: fromSettings ? `settings file ${flags.settings}` : "flag or environment",
    // "revisionsProven": false in the settings file turns every write off, whatever the schema says (see writesOff).
    writesOff: fromSettings && st.revisionsProven !== true,
  };
}

function client(flags, fetchImpl) {
  return createClient({ url: flags.url || process.env.EMDASH_URL, token: process.env.EMDASH_TOKEN, fetch: fetchImpl });
}

const out = (report) => { console.log(JSON.stringify(report, null, 2)); return report; };
const pageUrl = (base, pattern, slug) => base + pattern.replace("{slug}", encodeURIComponent(slug));

/** The previous version of a file from git (a ref such as origin/main or a merge commit's first parent), or null. */
export function gitVersion(file, ref) {
  try { return execFileSync("git", ["show", `${ref}:./${basename(file)}`], { cwd: dirname(resolve(file)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}

function baseOf(file, flags) {
  if (flags.base) return existsSync(String(flags.base)) ? parseMirror(readFileSync(String(flags.base), "utf8")) : null;
  if (flags["base-ref"]) { const t = gitVersion(file, String(flags["base-ref"])); return t == null ? null : parseMirror(t); }
  return null;
}

// ------------------------------------------------------------------------------------------------ export

export async function exportCmd(flags, { fetch: f = globalThis.fetch } = {}) {
  const o = options(flags);
  const dir = String(flags.dir || "");
  if (!dir) throw new Error("--dir is required (the mirror folder)");
  checkFolder(dir);
  const api = client(flags, f);
  const status = flags.status === "all" ? undefined : String(flags.status || "published");
  const listed = await api.list(o.collection, { status });
  const report = { collection: o.collection, status: status || "all", listed: listed.length, written: [], skipped: [], opaque: [], pendingDrafts: [], noPublishedAt: [], noSlug: [], seoEnabled: null, liveRevision: 0, taxonomies: {} };
  if (!flags.dry) mkdirSync(dir, { recursive: true });
  // One file per slug: the same slug in two locales (allowed by EmDash) would overwrite one file, so both are skipped.
  const bySlug = new Map();
  for (const row of listed) if (row.slug) bySlug.set(row.slug, [...(bySlug.get(row.slug) || []), row]);
  for (const row of listed) {
    if (!row.slug) { report.noSlug.push(row.id); continue; }
    if (unsafeSlug(row.slug)) { report.skipped.push({ slug: row.slug, id: row.id, reason: "the slug has path characters or starts with a dot; it cannot be a file name" }); continue; }
    const same = bySlug.get(row.slug);
    if (same.length > 1) { report.skipped.push({ slug: row.slug, id: row.id, locale: row.locale ?? null, reason: `the same slug is used by ${same.length} posts (locales: ${same.map((r) => r.locale ?? "none").join(", ")}); one file per slug cannot hold them` }); continue; }
    const target = resolve(dir, `${row.slug}.md`);
    if (dirname(target) !== resolve(dir)) { report.skipped.push({ slug: row.slug, id: row.id, reason: "the file would be outside the mirror folder" }); continue; }
    if (unsafePostFile(target, dir)) { report.skipped.push({ slug: row.slug, id: row.id, reason: unsafePostFile(target, dir) }); continue; }
    const got = await api.get(o.collection, row.id);
    const item = got?.item || row;
    const terms = {};
    for (const t of o.taxonomies) {
      try { terms[t] = (await api.terms(o.collection, item.id, t)).map((x) => x.slug); report.taxonomies[t] = "ok"; }
      catch (e) { report.taxonomies[t] = e.code || "error"; terms[t] = []; }
    }
    const m = itemToMirror(item, { fields: o.fields, categories: terms.category || [], tags: terms.tag || [], rev: got?._rev ?? null });
    if (report.seoEnabled == null) report.seoEnabled = "seo" in item;
    if (item.liveRevisionId) report.liveRevision++;
    if (!item.publishedAt) report.noPublishedAt.push(item.slug);
    if (item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId) report.pendingDrafts.push(item.slug);
    if (!m.roundTrip.ok) { report.skipped.push({ slug: item.slug, reason: "does not convert back unchanged", blocks: m.roundTrip.differences }); continue; }
    if (m.roundTrip.opaque) report.opaque.push({ slug: item.slug, blocks: m.roundTrip.opaque, why: [...new Set(m.roundTrip.problems.map((p) => p.reason))] });
    if (!flags.dry) writeFileSync(target, m.text);
    report.written.push(item.slug);
  }
  // Files for posts the CMS no longer lists are reported, never deleted.
  if (existsSync(dir)) {
    const have = new Set(listed.map((x) => x.slug));
    report.notInCms = readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).filter((s) => !have.has(s));
  }
  if (o.sitemap) {
    const xml = await (await f(new URL(String(o.sitemap), api.base).toString())).text();
    // Compare paths, not whole URLs: sitemaps may name another host form (www) or repeat slashes ("//posts/x").
    const prefix = o.urlPattern.split("{slug}")[0];
    const pathOf = (u) => { try { return new URL(u.trim()).pathname.replace(/\/{2,}/g, "/"); } catch { return ""; } };
    const inMap = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => pathOf(x[1].replace(/&amp;/g, "&"))).filter((p) => p.startsWith(prefix) && p.length > prefix.length).map((p) => decodeURIComponent(p.slice(prefix.length).replace(/\/$/, "")));
    const listedSlugs = new Set(listed.map((x) => x.slug));
    report.sitemap = { posts: inMap.length, notListedByCms: inMap.filter((s) => !listedSlugs.has(s)), listedNotInSitemap: [...listedSlugs].filter((s) => !inMap.includes(s)) };
  }
  report.calls = api.calls.length;
  out(report);
  return report.skipped.length ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------ validate

export function validateCmd(flags) {
  const dir = flags.dir ? String(flags.dir) : null;
  let files = flags.files ? String(flags.files).split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (!files.length && dir) files = readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => join(dir, n));
  if (!files.length) throw new Error("give --dir <mirror folder> or --files a.md,b.md");
  const o = options(flags);
  const withBase = !!(flags.base || flags["base-ref"]);
  const folderOf = (file) => dir || dirname(file);
  for (const d of new Set([...(dir ? [dir] : []), ...files.map(folderOf)])) checkFolder(d);
  const entries = [];
  const blocked = [];
  for (const file of files.filter((f) => existsSync(f) || unsafePostFile(f, folderOf(f)))) {
    const bad = unsafePostFile(file, folderOf(file));
    if (bad) { blocked.push({ file, errors: [bad], warnings: [], highRisk: [], facts: null, before: null }); continue; }
    entries.push({ file, parsed: parseMirror(readFileSync(file, "utf8")), base: baseOf(file, flags) });
  }
  // Slugs and ids must be unique across the whole folder (--dir, or else the changed files' own folder), not only the
  // changed files. Unsafe files in the folder are never read and make the result fail.
  const unsafe = [];
  const others = [];
  for (const d of new Set(files.map(folderOf))) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d).filter((x) => x.endsWith(".md"))) {
      const p = join(d, n);
      if (files.some((x) => resolve(x) === resolve(p))) continue;
      const bad = unsafePostFile(p, d);
      if (bad) { unsafe.push(bad); continue; }
      others.push({ file: p, parsed: parseMirror(readFileSync(p, "utf8")), skip: true });
    }
  }
  const all = [...entries, ...others];
  const v = validateSet(all, { slugPattern: o.slugPattern });
  const results = v.results.filter((_, i) => !all[i].skip).map((r, i) => {
    const e = entries[i];
    const errors = [...r.errors];
    const id = e.parsed.meta.id;
    if (withBase && !e.base && id != null && id !== "") errors.push(`id "${id}" on a new file (it has no previous version): a new post gets its id from the CMS, and this one would point at another post`);
    return { ...r, errors, before: e.base ? { words: validateFile(e.base).facts.words } : null };
  });
  results.push(...blocked);
  const report = { ok: results.every((r) => !r.errors.length) && !unsafe.length, files: results.length, results };
  if (unsafe.length) report.unsafe = unsafe;
  out(report);
  return report.ok ? 0 : 1;
}

// ------------------------------------------------------------------------------------------------ draft and publish

// A PUT with data on a collection without revisions overwrites the live post, so a write needs proof first: the
// schema says so (schema:read scope), or the operator ran preview-check and set --revisions-proven.
async function writeGuard(api, o, liveItem) {
  if (o.writesOff) throw new Refused(writesOffMessage(o), "writes-off");
  if (!liveItem || liveItem.status !== "published") return "not live";
  const r = await revisionsSupported(api, o.collection);
  if (r === true) return "schema";
  if (r === false) throw new Refused(`collection "${o.collection}" does not keep revisions: a draft save would change the live post`, "no-revisions");
  if (o.revisionsProven) return `proven by preview-check (${o.revisionsProvenFrom})`;
  throw new Refused(`revisions are not proven for this collection (${o.revisionsProvenFrom}); run "cms preview-check", and once it shows revisions: true set "revisionsProven": true in the settings file (or pass --revisions-proven when no settings file is used)`, "revisions-unproven");
}

// The settings file is what a person commits after preview-check; until it says true, no draft, publish or discard
// reaches the CMS, not even an SEO-only edit (which needs no draft) or a collection whose schema shows revisions.
const writesOffMessage = (o) => `writes are off: "revisionsProven" is false in the ${o.revisionsProvenFrom}; run "cms preview-check", and once it shows revisions: true commit "revisionsProven": true`;
function refuseIfWritesOff(o, flags, report) {
  if (!o.writesOff) return;
  if (flags.dry) { report.writesOff = true; return; }
  throw new Refused(writesOffMessage(o), "writes-off");
}

/**
 * Every version of the file committed in git at this path, newest first (at most 50): [{ sha, parsed }]. Only this
 * path counts (no --follow): a version under another name had another slug, and so belonged to another post.
 */
export function gitVersionsOf(file) {
  const out = [];
  try {
    const shas = execFileSync("git", ["log", "--format=%H", "-n", "50", "--", basename(file)], { cwd: dirname(resolve(file)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    for (const sha of shas) { const t = gitVersion(file, sha); if (t != null) out.push({ sha, parsed: parseMirror(t) }); }
  } catch { /* not a git checkout */ }
  return out;
}

/** The file's own versions: this file, its previous version, and every version committed in git (newest first). */
export function versionsOf(file, parsed, base) {
  return [parsed, ...(base ? [base] : []), ...gitVersionsOf(file).map((v) => v.parsed)];
}

/**
 * Why a file without an id may not write to the published post that has its slug, or null (decision D77, review R8 F5).
 * A new post published from a file leaves the file without an id (no write-back to the repository). Such a file may
 * later update that post only when the live post equals one of this file's own committed git versions: that shows the
 * mirror made the post from this file and nobody changed it since. No other mirror file may claim the slug or the post.
 */
function claimProblem(o, file, dir, parsed, item) {
  const m = parsed.meta;
  for (const n of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".md")) : []) {
    const p = join(dir, n);
    if (resolve(p) === resolve(file) || unsafePostFile(p, dir)) continue;
    const other = parseMirror(readFileSync(p, "utf8")).meta;
    if (other.slug === m.slug || (other.id != null && other.id !== "" && String(other.id) === String(item.id))) return `another mirror file (${n}) already stands for post "${m.slug}"`;
  }
  const live = stateOfItem(item, o.fields);
  const hit = gitVersionsOf(file).find(({ parsed: v }) => v.meta.slug === m.slug && (v.meta.id == null || v.meta.id === "" || String(v.meta.id) === String(item.id)) && sameState(live, stateOfFile(v)));
  if (!hit) return `slug "${m.slug}" is already used by a published post, and this file has no id: the live post equals none of this file's committed versions, so the mirror cannot show it made that post (it was edited in the CMS, or it belongs to someone else); export it to get its file`;
  return { sha: hit.sha };
}

// Which CMS post a file may write to. A file with an id: only that published post, with the same slug, and only with
// its previous version at hand (to see edits made in the CMS). A new file: only a slug nobody uses, or an unpublished
// draft this mirror made from this file (a re-run), or the published post this file made (see claimProblem).
// Scheduled, unpublished and trashed posts are never touched.
async function loadTarget(api, o, parsed, report, versions, file, dir) {
  const m = parsed.meta;
  if (m.id != null && m.id !== "") {
    if (!report.base) throw new Refused(`${m.slug}: a file with an id needs its previous version (--base or --base-ref), so edits made in the CMS are not overwritten`, "no-base");
    const got = await api.get(o.collection, String(m.id));
    if (!got) throw new Refused(`post ${m.id} (${m.slug}) is not in the CMS: deleted or in the trash`, "no-post");
    if (got.item.slug !== m.slug) throw new Refused(`post ${m.id} is "${got.item.slug}" in the CMS but the file says "${m.slug}": the file does not belong to that post`, "other-post");
    if (got.item.deletedAt) throw new Refused(`post ${m.slug} is in the trash`, "not-published");
    if (got.item.status !== "published") throw new Refused(`post ${m.slug} is ${got.item.status} in the CMS; the mirror only updates published posts (it was taken down or scheduled there)`, "not-published");
    return got;
  }
  const got = await api.get(o.collection, String(m.slug));
  if (!got) return null;
  const it = got.item;
  if (it.status === "published" && !it.deletedAt && it.slug === m.slug) {
    const claim = claimProblem(o, file, dir, parsed, it);
    if (typeof claim === "string") throw new Refused(claim, "slug-taken");
    report.claimedBySlug = { id: it.id, matchedVersion: claim.sha };
    return got;
  }
  if (it.status !== "draft" || it.publishedAt || it.liveRevisionId || it.deletedAt) throw new Refused(`slug "${m.slug}" is already used by a ${it.status} post`, "slug-taken");
  const data = it.draftRevisionId ? (await api.compare(o.collection, it.id))?.draft : it.data;
  if (!versions.some((v) => draftMatches(data, { version: v, fields: o.fields, slug: m.slug }))) throw new Refused(`an unpublished draft with slug "${m.slug}" already exists and was not made from this file; pick another slug or remove that draft in the CMS`, "foreign-draft");
  report.reusedDraft = it.id;
  return got;
}

/** true when a pending draft is neither "no change" nor one of this file's versions: someone else's. */
function foreignDraft(o, item, draft, versions) {
  return ![null, ...versions].some((v) => draftMatches(draft, { base: item.data || {}, version: v, fields: o.fields, slug: item.slug }));
}

// Re-read the draft right before publishing: a draft saved by someone else after ours would go live with it. This
// narrows the window to one round trip (EmDash 0.1.0's publish takes no revision token).
async function confirmDraft(api, o, id, parsed) {
  const now = (await api.get(o.collection, id))?.item;
  const pending = now?.draftRevisionId && now.draftRevisionId !== now.liveRevisionId;
  const data = pending ? (await api.compare(o.collection, id))?.draft : now?.data;
  if (!now || !draftMatches(data, { base: now.data || {}, version: parsed, fields: o.fields, slug: parsed.meta.slug })) {
    throw new Refused(`the CMS draft of "${parsed.meta.slug}" is not the file any more (someone saved a draft after ours); nothing was published. Check the CMS, then run the publish again`, "draft-changed");
  }
}

async function saveDraft(api, o, parsed, report, file, { dir, added = [] } = {}) {
  const head = stateOfFile(parsed);
  const versions = versionsOf(file, parsed, report.base);
  let got = await loadTarget(api, o, parsed, report, versions, file, dir);
  await checkAdded(api, o, got?.item, parsed, added);
  if (!got) {
    const created = await api.createDraft(o.collection, { slug: parsed.meta.slug, data: draftData(parsed, o.fields) });
    report.created = created.item.id;
    report.draftSaved = true;
    return { item: created.item, head, changes: diffState(null, head), pendingIsHead: false };
  }
  const item = got.item;
  const live = stateOfItem(item, o.fields);
  const base = report.base ? stateOfFile(report.base) : null;
  const hasPending = !!item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId;
  const pendingData = hasPending ? (await api.compare(o.collection, item.id))?.draft || {} : null;
  const foreign = item.status === "published" && hasPending ? foreignDraft(o, item, pendingData, versions) : false;
  const plan = writePlan({ live, base, foreignDraft: foreign, head });
  report.plan = { ok: plan.ok, reason: plan.reason, changes: plan.changes };
  if (!plan.ok) throw new Refused(plan.reason, foreign ? "foreign-draft" : "live-changed");
  // Only the current file may go live. A pending draft equal to an older version of the file (a publish that failed
  // before a revert, say) may be overwritten, never published: it is replaced by the current file first, also when
  // only the SEO fields changed.
  const pendingIsHead = hasPending && draftMatches(pendingData, { base: item.data || {}, version: parsed, fields: o.fields, slug: item.slug });
  const content = plan.changes.filter((c) => ["title", "excerpt", "body"].includes(c));
  const needDraft = !pendingIsHead && (content.length > 0 || (hasPending && plan.changes.length > 0));
  if (!needDraft) { report.draftSaved = false; report.draftReason = pendingIsHead ? "the CMS draft already matches the file" : "no content change"; return { item, head, changes: plan.changes, pendingIsHead }; }
  if (hasPending && !content.length) report.draftReason = "a pending draft of an older version was replaced by the current file";
  report.guard = await writeGuard(api, o, item);
  if (report.dry) { report.draftSaved = false; return { item, head, changes: plan.changes, pendingIsHead }; }
  await api.saveDraft(o.collection, item.id, { data: draftData(parsed, o.fields, { previous: item.data?.[o.fields.body] }), _rev: got._rev });
  // The live post must not have moved; the draft must exist.
  const after = (await api.get(o.collection, item.id)).item;
  if (item.status === "published") {
    const moved = diffState(live, stateOfItem(after, o.fields), ["slug", "title", "excerpt", "body"]);
    if (moved.length) { const e = new Error(`DANGER: saving a draft changed the live post (${moved.join(", ")}); restore it from the previous mirror file`); e.exit = 2; throw e; }
    if (!after.draftRevisionId) { const e = new Error("the draft save left no draft revision"); e.exit = 2; throw e; }
  }
  report.draftSaved = true;
  return { item: after, head, changes: plan.changes, pendingIsHead: false };
}

function readFile(flags) {
  const file = String(flags.file || "");
  const dir = flags.dir ? String(flags.dir) : dirname(file);
  if (file) checkFolder(dir);
  const bad = file ? unsafePostFile(file, dir) : null;
  if (bad) throw new Refused(bad, "unsafe-file");
  if (!file || !existsSync(file)) throw new Error("--file <mirror file> is required");
  const parsed = parseMirror(readFileSync(file, "utf8"));
  return { file, dir, parsed };
}

/**
 * Read-only keys the file added (absent in its previous version; validateFile lets them through) must equal the CMS
 * post, checked before any write. Categories and tags are read the way export reads them.
 */
async function checkAdded(api, o, item, parsed, added) {
  if (!added?.length) return;
  if (!item) throw new Refused(`${parsed.meta.slug}: read-only ${added.join(", ")} added, but no CMS post has this slug`, "read-only-mismatch");
  const terms = {};
  for (const [key, tax] of [["categories", "category"], ["tags", "tag"]]) {
    if (!added.includes(key)) continue;
    try { terms[key] = o.taxonomies.includes(tax) ? (await api.terms(o.collection, item.id, tax)).map((x) => x.slug) : []; }
    catch { terms[key] = []; }
  }
  const cms = readOnlyOf(item, { fields: o.fields, ...terms });
  const bad = added.filter((k) => JSON.stringify(parsed.meta[k] ?? null) !== JSON.stringify(cms[k] ?? null));
  if (bad.length) throw new Refused(`${parsed.meta.slug}: read-only ${bad.map((k) => `${k} ${JSON.stringify(parsed.meta[k])} (CMS: ${JSON.stringify(cms[k] ?? null)})`).join(", ")} added to the file but not what the CMS has; a read-only key may only be added with the CMS's own value`, "read-only-mismatch");
}

function checkFile(file, parsed, base, o) {
  const v = validateFile(parsed, { file, base, slugPattern: o.slugPattern });
  if (v.errors.length) { const e = new Error(`invalid mirror file: ${v.errors.join("; ")}`); e.report = v; throw e; }
  return v;
}

export async function draftCmd(flags, { fetch: f = globalThis.fetch } = {}) {
  const o = options(flags);
  const { file, dir, parsed } = readFile(flags);
  const base = baseOf(file, flags);
  const v = checkFile(file, parsed, base, o);
  const api = client(flags, f);
  const report = { action: "draft", file, slug: parsed.meta.slug, dry: !!flags.dry, base, highRisk: v.highRisk, warnings: v.warnings };
  refuseIfWritesOff(o, flags, report);
  const { item } = await saveDraft(api, o, parsed, report, file, { dir, added: v.addedReadOnly });
  delete report.base;
  report.id = item.id;
  report.liveUrl = item.status === "published" ? pageUrl(api.base, o.urlPattern, item.slug) : null;
  if (!flags.dry && flags.preview !== "false") {
    try {
      const p = await api.previewUrl(o.collection, item.slug || item.id, { pathPattern: o.urlPattern.replace("{slug}", "{id}"), expiresIn: String(flags["preview-expires"] || "1d") });
      report.previewUrl = new URL(p.url, api.base).toString();
      report.previewExpiresAt = p.expiresAt;
    } catch (e) { report.previewUrl = null; report.previewError = e.code || e.message; }
  }
  report.calls = api.calls;
  out(report);
  return 0;
}

export async function publishCmd(flags, { fetch: f = globalThis.fetch } = {}) {
  const o = options(flags);
  const { file, dir, parsed } = readFile(flags);
  const base = baseOf(file, flags);
  const v = checkFile(file, parsed, base, o);
  const api = client(flags, f);
  const report = { action: "publish", file, slug: parsed.meta.slug, dry: !!flags.dry, base, highRisk: v.highRisk, warnings: v.warnings };
  refuseIfWritesOff(o, flags, report);
  const { item, head, changes, pendingIsHead } = await saveDraft(api, o, parsed, report, file, { dir, added: v.addedReadOnly });
  delete report.base;
  report.id = item.id;
  report.changes = changes;
  if (flags.dry) { report.calls = api.calls; out(report); return 0; }
  if (!changes.length && item.status === "published") { report.published = false; report.reason = "the CMS already matches the file"; }
  else {
    const needsPublish = item.status !== "published" || report.draftSaved || pendingIsHead;
    if (needsPublish) { await confirmDraft(api, o, item.id, parsed); await api.publish(o.collection, item.id); report.published = true; }
    if (head.seo && "seo" in item) {
      const now = await api.get(o.collection, item.id);
      if (JSON.stringify(stateOfItem(now.item, o.fields).seo) !== JSON.stringify(head.seo)) {
        await api.setSeo(o.collection, item.id, { seo: seoPayload(parsed), _rev: now._rev });
        report.seoSet = true;
      }
    }
  }
  const final = await api.get(o.collection, item.id);
  const left = diffState(stateOfItem(final.item, o.fields), head, head.seo && "seo" in final.item ? undefined : ["slug", "title", "excerpt", "body"]);
  report.verified = left.length === 0;
  if (left.length) report.mismatch = left;
  report.status = final.item.status;
  report.liveUrl = pageUrl(api.base, o.urlPattern, final.item.slug);
  if (flags["write-back"] && report.verified) {
    const meta = { ...parsed.meta, id: final.item.id, status: final.item.status, publishedAt: final.item.publishedAt ?? null, baseRev: final._rev ?? null };
    writeFileSync(file, stringifyMirror(meta, parsed.body));
    report.wroteBack = ["id", "status", "publishedAt", "baseRev"];
  }
  report.calls = api.calls;
  out(report);
  return report.verified ? 0 : 2;
}

// ------------------------------------------------------------------------------------------------ discard

// EmDash 0.1.0: POST /_emdash/api/content/{collection}/{id}/discard-draft clears the entry's draft revision pointer and
// nothing else (the row already holds the published version; the revision itself stays in the history). It takes no
// _rev, so the draft is read again just before the call. See src/cms/emdash.mjs.
export async function discardCmd(flags, { fetch: f = globalThis.fetch } = {}) {
  const o = options(flags);
  const { file, dir, parsed } = readFile(flags);
  const base = baseOf(file, flags);
  const v = checkFile(file, parsed, base, o);
  const api = client(flags, f);
  const m = parsed.meta;
  const report = { action: "discard", file, slug: m.slug, dry: !!flags.dry, discarded: false };
  refuseIfWritesOff(o, flags, report);
  const got = await api.get(o.collection, String(m.id != null && m.id !== "" ? m.id : m.slug));
  if (!got || got.item.deletedAt) { report.refusal = "no-draft"; report.reason = "no CMS post for this file: nothing to discard"; report.calls = api.calls; out(report); return 4; }
  const item = got.item;
  if (item.slug !== m.slug) throw new Refused(`post ${m.id} is "${item.slug}" in the CMS but the file says "${m.slug}": the file does not belong to that post`, "other-post");
  report.id = item.id;
  // Only drafts on live posts: an unpublished post made from a new file is the post itself, and removing it would delete it.
  if (item.status !== "published") throw new Refused(`post ${m.slug} is ${item.status} in the CMS: discard only removes a pending draft from a published post; an unpublished post stays (delete it in the CMS admin if it is not wanted)`, "not-published");
  // The live post must still be the version the draft was made against: without it at hand, "changed under it" cannot be seen.
  if (!base) throw new Refused(`${m.slug}: discard needs the file's previous version (--base or --base-ref, the pull request's base), so a live post changed in the meantime is not mistaken for the mirror's`, "no-base");
  if (m.id == null || m.id === "") {
    const claim = claimProblem(o, file, dir, parsed, item);
    if (typeof claim === "string") throw new Refused(claim, "slug-taken");
    report.claimedBySlug = { id: item.id, matchedVersion: claim.sha };
  }
  await checkAdded(api, o, item, parsed, v.addedReadOnly);
  const hasPending = !!item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId;
  if (!hasPending) { report.refusal = "no-draft"; report.reason = "the post has no pending draft: nothing to discard"; report.calls = api.calls; out(report); return 4; }
  const draft = (await api.compare(o.collection, item.id))?.draft || {};
  if (foreignDraft(o, item, draft, versionsOf(file, parsed, base))) throw new Refused(`the pending draft of "${m.slug}" was not made by this mirror from this file (it differs from every version of it): someone else's work, left in place; check it in the CMS admin`, "foreign-draft");
  const live = stateOfItem(item, o.fields);
  const was = stateOfFile(base);
  const drift = diffState(live, was, partsFor(live, was));
  if (drift.length) throw new Refused(`the live post "${m.slug}" changed since the file's previous version (${drift.join(", ")} differ): the draft was left in place; check the CMS and export again`, "live-changed");
  report.guard = await writeGuard(api, o, item);
  report.draftRevision = item.draftRevisionId;
  if (flags.dry) { report.wouldDiscard = true; report.calls = api.calls; out(report); return 0; }
  // Re-read just before the call: a draft saved by someone else since the check would be discarded with ours.
  const now = (await api.get(o.collection, item.id))?.item;
  if (!now || now.draftRevisionId !== item.draftRevisionId || diffState(live, stateOfItem(now, o.fields)).length) throw new Refused(`the post "${m.slug}" changed while checking (another draft or edit); nothing was discarded; run discard again`, "draft-changed");
  await api.discardDraft(o.collection, item.id);
  const after = (await api.get(o.collection, item.id))?.item;
  const moved = after ? diffState(live, stateOfItem(after, o.fields)) : ["post"];
  if (moved.length || after.status !== "published") { const e = new Error(`DANGER: discarding the draft changed the live post (${moved.join(", ") || after.status}); restore it from the previous mirror file`); e.exit = 2; throw e; }
  if (after.draftRevisionId && after.draftRevisionId !== after.liveRevisionId) { const e = new Error("the discard left a pending draft"); e.exit = 2; throw e; }
  report.discarded = true;
  report.liveUrl = pageUrl(api.base, o.urlPattern, after.slug);
  report.calls = api.calls;
  out(report);
  return 0;
}

// ------------------------------------------------------------------------------------------------ preview-check

async function pageFacts(f, url) {
  try {
    const res = await f(url, { headers: { "user-agent": "seo-autopilot-cms-mirror" }, redirect: "manual" });
    const html = await res.text();
    return { status: res.status, words: countWords(visibleText(mainScope(html))) };
  } catch (e) { return { status: 0, error: e.message }; }
}

export async function previewCheckCmd(flags, { fetch: f = globalThis.fetch } = {}) {
  const o = options(flags);
  const title = String(flags.title || "");
  const slug = String(flags.slug || "");
  if (!title || !slug) throw new Error("--title and --slug are required (the throwaway draft)");
  if (!o.slugPattern.test(slug)) throw new Error(`--slug must match ${o.slugPattern}`);
  const api = client(flags, f);
  const report = { action: "preview-check", slug, checks: {} };
  const n = Number(flags.check ?? 3);

  // 1. What the token can see about the collection.
  report.schema = await revisionsSupported(api, o.collection);
  const published = await api.list(o.collection, { status: "published", all: false, limit: Math.max(n, 1) });
  report.seoEnabled = published.length ? "seo" in published[0] : null;

  // 2. Existing pages before.
  const sample = published.filter((p) => p.slug !== slug).slice(0, n).map((p) => pageUrl(api.base, o.urlPattern, p.slug));
  const before = {};
  for (const u of sample) before[u] = await pageFacts(f, u);

  // 3. The throwaway draft: reuse it on a re-run, never touch a live post.
  let got = await api.get(o.collection, slug);
  if (got && got.item.status !== "draft") throw new Refused(`slug "${slug}" belongs to a ${got.item.status} post; pick another throwaway slug`);
  const body = String(flags.body || `${title}. This draft checks that drafts stay private and that preview links work. It must never be published.`);
  const data = { [o.fields.title]: title, [o.fields.body]: fromMarkdown(body) };
  if (!got) { const c = await api.createDraft(o.collection, { slug, data }); got = await api.get(o.collection, c.item.id); report.created = true; }
  else report.created = false;
  const id = got.item.id;
  report.id = id;

  // 4. Revisions probe on the draft only: a data save must create a draft revision and leave the row's data alone.
  const beforeRow = stateOfItem(got.item, o.fields);
  await api.saveDraft(o.collection, id, { data: { ...data, [o.fields.body]: fromMarkdown(body + " (revision probe)") }, _rev: got._rev });
  const probed = (await api.get(o.collection, id)).item;
  report.revisionsProbe = { draftRevisionCreated: !!probed.draftRevisionId, rowDataUnchanged: diffState(beforeRow, stateOfItem(probed, o.fields), ["title", "body"]).length === 0 };
  report.revisions = report.revisionsProbe.draftRevisionCreated && report.revisionsProbe.rowDataUnchanged;
  report.checks.statusStillDraft = probed.status === "draft";

  // 5. Preview link.
  try {
    const p = await api.previewUrl(o.collection, slug, { pathPattern: o.urlPattern.replace("{slug}", "{id}"), expiresIn: "1h" });
    const purl = new URL(p.url, api.base).toString();
    const r = await f(purl, { headers: { "user-agent": "seo-autopilot-cms-mirror" } });
    const html = await r.text();
    report.preview = { ok: r.status === 200 && html.includes(title), status: r.status, showsTitle: html.includes(title), showsProbe: html.includes("revision probe") };
  } catch (e) { report.preview = { ok: false, error: e.code || e.message }; }

  // 6. The public cannot see it.
  const publicUrl = pageUrl(api.base, o.urlPattern, slug);
  const pub = await pageFacts(f, publicUrl);
  report.checks.publicUrlHidden = pub.status === 404 || pub.status === 410;
  report.publicStatus = pub.status;
  for (const [name, path] of [["sitemap", o.sitemap || "/sitemap.xml"], ["rss", o.rss || "/rss.xml"]]) {
    if (path === "false") continue;
    try {
      const r = await f(new URL(String(path), api.base).toString(), { headers: { "user-agent": "seo-autopilot-cms-mirror" } });
      const xml = await r.text();
      report.checks[`notIn_${name}`] = r.ok && !xml.includes(slug) && !xml.includes(encodeURIComponent(slug));
    } catch { report.checks[`notIn_${name}`] = false; }
  }

  // 7. Existing pages after: same status and word count.
  report.existingPages = [];
  for (const u of sample) {
    const a = await pageFacts(f, u);
    report.existingPages.push({ url: u, before: before[u], after: a, unchanged: a.status === before[u].status && a.words === before[u].words });
  }
  report.checks.existingPagesUnchanged = report.existingPages.every((p) => p.unchanged);
  report.ok = Object.values(report.checks).every(Boolean);
  report.calls = api.calls;
  out(report);
  return report.ok ? 0 : 1;
}

export async function schemaCmd(flags, { fetch: f = globalThis.fetch } = {}) {
  const o = options(flags);
  const api = client(flags, f);
  const report = { collection: o.collection };
  try { const s = await api.schema(o.collection); const col = s?.item || s?.collection || s; report.schemaReadable = true; report.supports = col?.supports ?? null; }
  catch (e) { report.schemaReadable = false; report.schemaError = `${e.status || ""} ${e.code || e.message}`.trim(); }
  const one = await api.list(o.collection, { status: "published", all: false, limit: 1 });
  report.seoEnabled = one.length ? "seo" in one[0] : null;
  report.revisions = report.supports ? report.supports.includes("revisions") : null;
  report.calls = api.calls;
  out(report);
  return 0;
}

export async function cms({ flags = {}, positional = [] } = {}, deps = {}) {
  const sub = positional[0];
  const run = { export: exportCmd, validate: validateCmd, draft: draftCmd, publish: publishCmd, discard: discardCmd, "preview-check": previewCheckCmd, schema: schemaCmd }[sub];
  if (!run) throw new Error("usage: cms export|validate|draft|publish|discard|preview-check|schema (see docs/cms-mirror.md)");
  try { return await run(flags, deps); }
  catch (e) {
    if (e instanceof Refused || e.exit) { out({ action: sub, refused: e instanceof Refused, ...(e.refusal ? { refusal: e.refusal } : {}), error: e.message }); return e.exit || 3; }
    if (e.report) { out({ action: sub, error: e.message, ...e.report }); return 1; }
    if (e instanceof EmDashError) { out({ action: sub, error: e.message, status: e.status, code: e.code }); return 1; }
    throw e;
  }
}
