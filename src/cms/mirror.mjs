// CMS mirror: each CMS post kept as one Markdown file with flat front matter, so changes go through a pull request
// (the approval record), the content-loss guard and git revert, while the CMS stays the place the site reads from.
// Pure: no network, no files. The client is src/cms/emdash.mjs; the commands are src/cms/commands.mjs.
//
//   ---
//   id: "01J..."                 CMS id; empty for a post that does not exist yet
//   slug: "my-post"              never changed for an existing post (a URL change needs a person)
//   title: "..."                 editable
//   excerpt: "..."               editable
//   seoTitle / seoDescription / seoImage / canonical / noIndex     editable, sent to the CMS only at publish
//   status, publishedAt, categories, tags, image, imageAlt, byline, locale     read-only copies of the CMS
//   baseRev: "..."               the CMS revision token when the file was last exported or published
//   ---
//   Markdown body (src/cms/portable-text.mjs)
//
// Values are JSON (strings in double quotes, null, true/false, ["a", "b"] lists), one key per line, so the project's
// tiny front-matter reader (src/adapters/index.mjs) and the content-loss guard can read the same files.

import { fromMarkdown, toMarkdown, normalizeBlocks, blockFacts, markdownProblems, strikeMarkOf } from "./portable-text.mjs";

export const DEFAULT_FIELDS = { title: "title", excerpt: "excerpt", body: "content", image: "featured_image" };
export const SEO_KEYS = { seoTitle: "title", seoDescription: "description", seoImage: "image", canonical: "canonical", noIndex: "noIndex" };
const KEY_ORDER = ["id", "slug", "title", "excerpt", "status", "publishedAt", "seoTitle", "seoDescription", "seoImage", "canonical", "noIndex", "categories", "tags", "image", "imageAlt", "byline", "locale", "baseRev"];
export const EDITABLE = ["title", "excerpt", "seoTitle", "seoDescription", "seoImage", "canonical", "noIndex"];
export const READ_ONLY = ["id", "slug", "status", "publishedAt", "categories", "tags", "image", "imageAlt", "byline", "locale"];
const LIMITS = { title: 200, seoTitle: 200, seoDescription: 500 };
export const LATIN_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// --------------------------------------------------------------------------------------------- file format

export function stringifyMirror(meta, body) {
  const lines = ["---"];
  const keys = [...KEY_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !KEY_ORDER.includes(k)).sort()];
  for (const k of keys) {
    const v = meta[k];
    // JSON.stringify leaves U+2028 and U+2029 raw; they end a line for many readers (and for "." in a RegExp), so escape them.
    lines.push(`${k}: ${v === undefined ? "null" : JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}`);
  }
  lines.push("---", "");
  return lines.join("\n") + String(body ?? "");
}

/**
 * Parse a mirror file. Returns { meta, body, errors }. Values must be JSON: a value that is not (a YAML habit such as
 * 'single quotes' or a bare word) is an error, because it would be published with the quotes or read differently.
 */
export function parseMirror(src) {
  const s = String(src ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = s.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { meta: {}, body: s, errors: ["no front matter (the file must start with ---)"] };
  const meta = {};
  const errors = [];
  m[1].split("\n").forEach((line, n) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const kv = line.match(/^([A-Za-z0-9_-]+):[ \t]*([^\n]*)$/);
    if (!kv) { errors.push(`front matter line ${n + 2} is not "key: value"`); return; }
    if (kv[1] in meta) errors.push(`front matter key "${kv[1]}" appears twice`);
    const raw = kv[2].trim();
    try { meta[kv[1]] = raw === "" ? null : JSON.parse(raw); }
    catch { errors.push(`front matter "${kv[1]}" is not valid JSON (write text in "double quotes"): ${raw.slice(0, 60)}`); meta[kv[1]] = raw; }
  });
  return { meta, body: s.slice(m[0].length).replace(/^\n/, ""), errors };
}

// --------------------------------------------------------------------------------------------- CMS item <-> file

const blank = (v) => v === undefined || v === null || v === "";
const orNull = (v) => (blank(v) ? null : v);

function imageOf(img) {
  if (!img || typeof img !== "object") return { src: null, alt: null };
  const src = img.src || img.url || img.$media?.url || img.meta?.storageKey || img.id || null;
  return { src: src ? String(src) : null, alt: orNull(img.alt ?? img.$media?.alt) };
}

/**
 * A CMS item (EmDash content API shape) to a mirror file. extra: { categories, tags, rev }.
 * Returns { text, slug, roundTrip: { ok, opaque, problems, differences } }.
 */
export function itemToMirror(item, { fields = DEFAULT_FIELDS, categories = [], tags = [], rev = null } = {}) {
  const data = item.data || {};
  const seo = item.seo || {};
  const blocks = Array.isArray(data[fields.body]) ? data[fields.body] : [];
  const { markdown, opaque, problems } = toMarkdown(blocks);
  const back = fromMarkdown(markdown);
  const a = normalizeBlocks(blocks), b = normalizeBlocks(back);
  const differences = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) differences.push(i);
  const ro = readOnlyOf(item, { fields, categories, tags });
  const meta = {
    id: ro.id, slug: ro.slug, title: data[fields.title] ?? "", excerpt: orNull(data[fields.excerpt]),
    status: ro.status, publishedAt: ro.publishedAt,
    seoTitle: orNull(seo.title), seoDescription: orNull(seo.description), seoImage: orNull(seo.image), canonical: orNull(seo.canonical), noIndex: seo.noIndex === true,
    categories: ro.categories, tags: ro.tags, image: ro.image, imageAlt: ro.imageAlt, byline: ro.byline, locale: ro.locale, baseRev: rev,
  };
  if (!item.seo) for (const k of Object.keys(SEO_KEYS)) delete meta[k];
  return { text: stringifyMirror(meta, markdown), slug: item.slug, roundTrip: { ok: differences.length === 0, opaque, problems, differences } };
}

/** The read-only keys of a mirror file (READ_ONLY) as export writes them for this CMS item. extra: { categories, tags }. */
export function readOnlyOf(item, { fields = DEFAULT_FIELDS, categories = [], tags = [] } = {}) {
  const img = imageOf((item.data || {})[fields.image]);
  return { id: item.id, slug: item.slug, status: item.status, publishedAt: orNull(item.publishedAt), categories, tags, image: img.src, imageAlt: img.alt, byline: orNull(item.byline?.displayName), locale: orNull(item.locale) };
}

/** The comparable state of a post: what a publish changes. From a CMS item or from a mirror file. */
export function stateOfItem(item, fields = DEFAULT_FIELDS, data = item.data || {}) {
  const seo = item.seo;
  return {
    slug: item.slug ?? null,
    title: data[fields.title] ?? "",
    excerpt: orNull(data[fields.excerpt]),
    body: normalizeBlocks(Array.isArray(data[fields.body]) ? data[fields.body] : []),
    seo: seo ? { title: orNull(seo.title), description: orNull(seo.description), image: orNull(seo.image), canonical: orNull(seo.canonical), noIndex: seo.noIndex === true } : null,
  };
}

export function stateOfFile(parsed) {
  const { meta, body } = parsed;
  const hasSeo = Object.keys(SEO_KEYS).some((k) => k in meta);
  return {
    slug: meta.slug ?? null,
    title: meta.title ?? "",
    excerpt: orNull(meta.excerpt),
    body: normalizeBlocks(fromMarkdown(body)),
    seo: hasSeo ? { title: orNull(meta.seoTitle), description: orNull(meta.seoDescription), image: orNull(meta.seoImage), canonical: orNull(meta.canonical), noIndex: meta.noIndex === true } : null,
  };
}

/** Which parts differ between two states: ["title", "body", "seo", ...]. */
export function diffState(a, b, parts = ["slug", "title", "excerpt", "body", "seo"]) {
  return parts.filter((p) => JSON.stringify(a?.[p] ?? null) !== JSON.stringify(b?.[p] ?? null));
}

/**
 * The parts to compare between two states. The SEO fields count only when both sides have them: a file without SEO keys
 * never writes them (publish skips setSeo), so the CMS's SEO row is neither a change nor drift for it. Before, a new post
 * written without SEO keys looked drifted ("seo") against its own live post on every later edit.
 */
export function partsFor(a, b) {
  return ["slug", "title", "excerpt", "body", ...(a?.seo && b?.seo ? ["seo"] : [])];
}

/** Has any SEO field a value (a state's seo object)? */
export const seoIsSet = (seo) => !!seo && Object.values(seo).some((v) => v !== null && v !== false);

/** The parts a post's words and address live in (everything but SEO). */
export const CONTENT_PARTS = ["slug", "title", "excerpt", "body"];

/** Does the live state equal this file state, on the parts the file manages? */
export const sameState = (live, file) => diffState(live, file, partsFor(live, file)).length === 0;

// --------------------------------------------------------------------------------------------- validation

/** Body facts plus the SEO keys present, for reports and the content-loss guard. */
export function fileFacts(parsed) {
  const f = blockFacts(fromMarkdown(parsed.body));
  const m = parsed.meta;
  return { ...f, title: m.title ?? "", seo: Object.fromEntries(Object.keys(SEO_KEYS).filter((k) => !blank(m[k]) && m[k] !== false).map((k) => [k, m[k]])), image: m.image ?? null };
}

/**
 * Check one mirror file, alone or against its previous version (base). Returns { errors, warnings, highRisk, facts }.
 * opts: { file, base (parsed or null), slugPattern (RegExp for new posts), siteUrl }.
 */
export function validateFile(parsed, { file = "", base = null, slugPattern = LATIN_SLUG } = {}) {
  const errors = [...(parsed.errors || [])];
  const warnings = [];
  const highRisk = [];
  const m = parsed.meta;
  if (blank(m.slug) || typeof m.slug !== "string") errors.push("slug is missing");
  else {
    if (/[\s/?#]/.test(m.slug)) errors.push(`slug "${m.slug}" has a space, / ? or #`);
    if (blank(m.id) && !slugPattern.test(m.slug)) errors.push(`new post slug "${m.slug}" must match ${slugPattern} (the CMS keeps explicit slugs as given)`);
    const name = file.split(/[\\/]/).pop();
    if (name && name !== `${m.slug}.md`) errors.push(`file name ${name} does not match the slug (expected ${m.slug}.md)`);
  }
  if (blank(m.title) || typeof m.title !== "string") errors.push("title is missing");
  for (const [k, max] of Object.entries(LIMITS)) if (typeof m[k] === "string" && m[k].length > max) errors.push(`${k} is ${m[k].length} characters (the CMS allows ${max})`);
  for (const k of ["title", "excerpt", "seoTitle", "seoDescription", "seoImage", "canonical"]) if (!blank(m[k]) && typeof m[k] !== "string") errors.push(`${k} must be a quoted string or null`);
  if (!blank(m.canonical) && !/^https?:\/\/[^\s]+$/.test(String(m.canonical))) errors.push(`canonical must be an http(s) URL`);
  if ("noIndex" in m && typeof m.noIndex !== "boolean") errors.push("noIndex must be true or false");
  if (m.noIndex === true) highRisk.push("noIndex is true: the page will ask search engines to drop it");
  // Lines that would publish differently from what the author sees: JSON shown as words, the rest of a post as code.
  for (const p of markdownProblems(parsed.body)) errors.push(`body line ${p.line}: ${p.problem}`);
  const facts = fileFacts(parsed);
  if (facts.opaque) warnings.push(`${facts.opaque} block(s) kept as <!--ec:block --> JSON (not editable as Markdown)`);
  if (!facts.words) errors.push("the body has no words");
  const addedReadOnly = [];
  if (base) {
    const b = base.meta;
    for (const k of READ_ONLY) {
      if (JSON.stringify(b[k] ?? null) === JSON.stringify(m[k] ?? null)) continue;
      // A read-only key the previous version did not have (a new post's file getting its id, status... from an export
      // or a write-back) is allowed here; draft, publish and discard check it equals the CMS post before any write.
      if (k !== "slug" && blank(b[k]) && !blank(m[k])) { addedReadOnly.push(k); continue; }
      if (k === "slug" && !blank(b.id)) errors.push(`slug changed from "${b.slug}" to "${m.slug}": changing a live URL needs a person and a redirect, not a mirror edit`);
      else if (k === "id") errors.push(`id changed: a file must stay tied to one CMS post`);
      else if (k !== "slug") errors.push(`${k} is a read-only copy of the CMS and cannot be changed here`);
    }
    if (JSON.stringify(b.canonical ?? null) !== JSON.stringify(m.canonical ?? null)) highRisk.push(`canonical changes from ${JSON.stringify(b.canonical ?? null)} to ${JSON.stringify(m.canonical ?? null)}`);
    if (b.noIndex !== true && m.noIndex === true) highRisk.push("noIndex turned on");
    // A file without SEO keys leaves the CMS's SEO alone (publish never writes it), so removing every key would not clear
    // anything: the run would be green while the old SEO stays live (review R10 F9). Clearing is done with null / false.
    const seoKeys = (x) => Object.keys(SEO_KEYS).filter((k) => k in x);
    if (seoKeys(b).length && !seoKeys(m).length) errors.push(`SEO keys removed (${seoKeys(b).join(", ")}): a file without SEO keys leaves the CMS's SEO as it is; to clear them keep the keys and set them to null (noIndex: false)`);
    if (addedReadOnly.length) warnings.push(`read-only ${addedReadOnly.join(", ")} added (absent in the previous version): draft and publish refuse unless ${addedReadOnly.length > 1 ? "they equal" : "it equals"} the CMS post`);
  }
  return { errors: [...new Set(errors)], warnings, highRisk, facts, addedReadOnly };
}

/** Check a set of mirror files together: each file, plus slugs and ids unique across the set. */
export function validateSet(entries, opts = {}) {
  const results = entries.map((e) => ({ file: e.file, ...validateFile(e.parsed, { ...opts, file: e.file, base: e.base || null }) }));
  // Every file of a clash gets the error, so a changed file clashing with an unchanged one is reported on the change.
  const groups = new Map();
  for (const [i, e] of entries.entries()) {
    for (const k of ["slug", "id"]) {
      const v = e.parsed.meta[k];
      if (blank(v)) continue;
      const key = `${k}:${v}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
  }
  for (const [key, idx] of groups) {
    if (idx.length < 2) continue;
    const [k, ...rest] = key.split(":");
    for (const i of idx) results[i].errors.push(`${k} "${rest.join(":")}" is also used by ${idx.filter((j) => j !== i).map((j) => entries[j].file).join(", ")}`);
  }
  return { ok: results.every((r) => !r.errors.length), results };
}

// --------------------------------------------------------------------------------------------- write plans

/**
 * The data object to save as a draft: only the fields the file edits. previous: the post's current body; blocks the
 * file did not change keep their original objects (keys, markDefs), and edited blocks keep its strike mark name.
 */
export function draftData(parsed, fields = DEFAULT_FIELDS, { previous = null } = {}) {
  const blocks = fromMarkdown(parsed.body, { strike: strikeMarkOf(previous) });
  return { [fields.title]: parsed.meta.title, [fields.excerpt]: orNull(parsed.meta.excerpt), [fields.body]: preserveBlocks(blocks, previous) };
}

/** New blocks, with each one that equals an unused previous block (same normalised form) replaced by that block. */
export function preserveBlocks(blocks, previous) {
  if (!Array.isArray(previous) || !previous.length) return blocks;
  const pool = previous.map((b) => ({ b, n: JSON.stringify(normalizeBlocks([b])[0]), used: false }));
  return blocks.map((b) => {
    const n = JSON.stringify(normalizeBlocks([b])[0]);
    const hit = pool.find((p) => !p.used && p.n === n);
    if (!hit) return b;
    hit.used = true;
    return structuredClone(hit.b);
  });
}

const canon = (v) => (v === undefined || v === null || v === "" ? "null" : JSON.stringify(sortDeep(v)));
const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);

/**
 * Is a pending CMS draft exactly what the mirror would have saved? draft: the draft's whole data (EmDash keeps a pending
 * slug change in it as _slug and applies it on publish). base: the data the mirror's save was merged onto (the live
 * post's data, or {} for a new post). version: a parsed mirror file, or null for "no edit at all". slug: the post's slug.
 * Any other difference (another field, another slug, other words) means someone else made the draft.
 */
export function draftMatches(draft, { base = {}, version = null, fields = DEFAULT_FIELDS, slug } = {}) {
  if (!draft || typeof draft !== "object") return false;
  const expected = { ...base, ...(version ? draftData(version, fields) : {}) };
  for (const k of new Set([...Object.keys(draft), ...Object.keys(expected)])) {
    if (k === "_slug") { if (draft._slug != null && draft._slug !== slug) return false; continue; }
    if (k === fields.body) { if (JSON.stringify(normalizeBlocks(draft[k] || [])) !== JSON.stringify(normalizeBlocks(expected[k] || []))) return false; continue; }
    if (canon(draft[k]) !== canon(expected[k])) return false;
  }
  return true;
}

/** The SEO object to send at publish (all five keys, so the CMS ends up exactly as the file says). */
export function seoPayload(parsed) {
  const m = parsed.meta;
  return { title: orNull(m.seoTitle), description: orNull(m.seoDescription), image: orNull(m.seoImage), canonical: orNull(m.canonical), noIndex: m.noIndex === true };
}

/**
 * Is it safe to write this file to the CMS? Compares the live item with the file's previous version (base) and looks at
 * any pending CMS draft. Returns { ok, reason, changes } where changes lists what the write will change.
 * live: state of the live item (or null for a new post); base: state of the previous file (or null);
 * pendingDraft: state of an unpublished CMS draft (or null); head: state of this file.
 * between: [{ sha, state }] the file's versions after base on the published branch (first-parent commits in
 * base..head), for a file that already owns its post. When live is not base but equals one of them, that version is the
 * previous version: a run that went red on another file still published this one, and the caller's base stayed behind
 * (review R8 round 2, item 1). The result then has `matched: sha`.
 */
export function writePlan({ live, base, foreignDraft = false, head, between = [] }) {
  if (!live) return { ok: true, reason: "new post", changes: diffState(null, head) };
  // A re-run after a publish that already landed (a retried job): the CMS matches the new file, nothing to do.
  if (sameState(live, head)) return { ok: true, reason: "the CMS already matches the file", changes: [] };
  // Publishing would publish that draft too (its words, and a pending slug change with no redirect).
  if (foreignDraft) return { ok: false, reason: "the CMS has an unpublished draft that this mirror did not make; publish or discard it in the CMS first", changes: [] };
  let matched = null;
  if (base && diffState(live, base, partsFor(live, base)).length) {
    const v = between.find((x) => !diffState(live, x.state, partsFor(live, x.state)).length);
    if (v) { matched = v.sha; base = v.state; }
  }
  const plan = planAgainst({ live, base, head });
  return matched && plan.ok ? { ...plan, reason: `live matches the file at ${matched.slice(0, 12)} (published after the given previous version)`, matched } : plan;
}

function planAgainst({ live, base, head }) {
  // SEO keys appear in the file for the first time: the previous version never managed SEO, so whatever the CMS has was
  // set there (an editor in the admin). Overwriting it is drift, unless the CMS has none yet (review R10 F8).
  if (head.seo && !base?.seo && live.seo && seoIsSet(live.seo) && JSON.stringify(live.seo) !== JSON.stringify(head.seo))
    return { ok: false, reason: `the CMS has SEO fields the previous file did not manage (${Object.keys(live.seo).filter((k) => live.seo[k] !== null && live.seo[k] !== false).join(", ")}), and this file sets SEO for the first time: it would overwrite them; export again to get them into the file, then edit`, changes: [] };
  if (base) {
    const drift = diffState(live, base, partsFor(live, base));
    // An SEO write that failed after the content was published: the content already equals this file and the SEO
    // fields are still the previous file's. Finishing the job is safe.
    if (drift.length && !diffState(live, head, ["slug", "title", "excerpt", "body"]).length && !diffState(live, base, ["seo"]).length)
      return { ok: true, reason: "resuming: the content is already published, the SEO fields are not yet", changes: diffState(live, head, partsFor(live, head)) };
    if (drift.length) return { ok: false, reason: `the CMS changed outside the mirror (${drift.join(", ")} differ from the previous file); export again before editing`, changes: [] };
  }
  return { ok: true, reason: base ? "live matches the previous file" : "no previous file given", changes: diffState(live, head, partsFor(live, head)) };
}
