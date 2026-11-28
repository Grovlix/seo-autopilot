// Local images in a mirror file, uploaded to the CMS media library before the post is written.
//
// A mirror file may reference image files kept in the repository, under a media folder set by the site's settings
// ("mediaDir", with the URL prefix "mediaUrlPrefix", default "/media/"): `![alt](/media/my-post/01-step.jpg)` is the file
// <mediaDir>/my-post/01-step.jpg. Before draft or publish writes anything, every such image is checked, uploaded (or
// found already uploaded by its content hash), read back from the CMS, and its URL in the body is replaced by the CMS
// media URL. Only then is the post saved, so a post never goes live with a local path or a missing image.
//
// Rules (fail closed: any problem stops the post before any post write):
// - Only whole-line images `![alt](url)` are images in the CMS body (src/cms/portable-text.mjs). Any other reference under
//   the prefix (an inline image, a link, a reference definition, an opaque block) is refused: it would publish a dead path.
// - The path after the prefix: plain segments of letters, digits, ".", "_", "-" (no "..", no dot first, no query, no
//   percent escapes); a regular file inside the media folder (no symbolic link on the way); an image extension whose
//   magic bytes agree; at most maxBytes; at most maxImages different files per post.
// - Idempotent: the key is the content hash EmDash 0.1.0 stores ("sha1:" + hex SHA-1 of the bytes, src/utils/hash.ts).
//   An item with that hash in the library is reused and nothing is uploaded; EmDash itself also answers an upload of
//   known bytes with the existing item (deduplicated). A retry after a partial failure re-uses what the first try uploaded.
// - Every image the body will point at is read back from the CMS and must hash to the local bytes.
// Uploaded items are never deleted: an item uploaded for a post that is then refused stays in the library, unreferenced,
// and is reused by the next try.
// Pure helpers plus prepareMedia (network through the client) and rewriteVersion (no network: older file versions).
//
// The cover (the post's featured image): with the settings "coverDir" (and "coverUrlPrefix", default "/covers/") a file whose front matter says
// `image: "/covers/<name>.jpg"` has a LOCAL cover, the file <coverDir>/<name>.jpg. It goes through the same checks, upload (or hash match) and
// read-back as a body image, and the post's featured image field is set to that media item, with `imageAlt` as its alt text. A file whose `image`
// is anything else keeps it as a read-only copy of the CMS, as before. The cover is one file per post and not counted in mediaMaxImages.

import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fromMarkdown, normalizeBlocks } from "./portable-text.mjs";

export const MEDIA_TYPES = { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/gif": ["gif"], "image/webp": ["webp"], "image/avif": ["avif"] };
export const DEFAULT_PREFIX = "/media/";
export const DEFAULT_COVER_PREFIX = "/covers/";
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_IMAGES = 50;

/** A problem with a post's media. exit 3 (refused) for the file's own problems, 1 for a failed CMS request. */
export class MediaError extends Error {
  constructor(msg, refusal, exit = 3) { super(msg); this.refusal = refusal; this.exit = exit; }
}

/** EmDash 0.1.0's content hash of some bytes (src/utils/hash.ts computeContentHash). */
export const contentHash = (buf) => `sha1:${createHash("sha1").update(buf).digest("hex")}`;

/** The image type from the first bytes, or null. */
export function sniffType(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a") return "image/gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("latin1", 8, 12))) return "image/avif";
  return null;
}

/**
 * The media settings from the settings file and flags, or null when no media folder is set (then local images are left
 * alone, as before). dir is resolved against the git repository that holds the settings file (or the working folder);
 * --media-dir against the working folder.
 */
export function mediaOptions(flags, st, settingsFile) {
  const raw = flags["media-dir"] ?? st.mediaDir ?? null;
  if (raw == null || raw === "") return null;
  let root = process.cwd();
  if (flags["media-dir"] == null && settingsFile) {
    try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(String(settingsFile), ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || root; } catch { /* not in git */ }
  }
  const prefix = String(flags["media-url-prefix"] ?? st.mediaUrlPrefix ?? DEFAULT_PREFIX);
  if (!/^\/[^\s()<>]*\/$/.test(prefix)) throw new Error(`mediaUrlPrefix "${prefix}" must start and end with "/" and hold no spaces or brackets`);
  const num = (v, d) => { const n = Number(v ?? d); if (!Number.isInteger(n) || n < 1) throw new Error(`media limit ${v} is not a positive whole number`); return n; };
  const media = { dir: isAbsolute(String(raw)) ? String(raw) : resolve(root, String(raw)), prefix, maxBytes: num(st.mediaMaxBytes, DEFAULT_MAX_BYTES), maxImages: num(st.mediaMaxImages, DEFAULT_MAX_IMAGES) };
  // The cover folder is set by the settings file only (like the other media keys it is resolved against the repository that holds the file).
  const coverRaw = flags["media-dir"] == null ? st.coverDir ?? null : null;
  if (coverRaw != null && coverRaw !== "") {
    const cprefix = String(st.coverUrlPrefix ?? DEFAULT_COVER_PREFIX);
    if (!/^\/[^\s()<>]*\/$/.test(cprefix)) throw new Error(`coverUrlPrefix "${cprefix}" must start and end with "/" and hold no spaces or brackets`);
    if (cprefix === prefix || cprefix.startsWith(prefix) || prefix.startsWith(cprefix)) throw new Error(`coverUrlPrefix "${cprefix}" and mediaUrlPrefix "${prefix}" must not contain one another`);
    media.cover = { dir: isAbsolute(String(coverRaw)) ? String(coverRaw) : resolve(root, String(coverRaw)), prefix: cprefix, maxBytes: media.maxBytes, maxImages: 1 };
  }
  return media;
}

/** The local cover reference of a parsed file under the cover prefix, or null (a CMS copy, nothing, or no cover folder in the settings). */
export function coverRefOf(parsed, media) {
  const v = parsed?.meta?.image;
  return media?.cover && typeof v === "string" && v.startsWith(media.cover.prefix) ? v : null;
}

/** Width and height of a JPEG or PNG from its headers, or null (the CMS media value carries them so a page can reserve the space). */
export function imageSize(b, type) {
  try {
    if (type === "image/png") return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* none */ }
  return null;
}

/** The featured image value stored on the post (EmDash MediaValue, src/media/types.ts): the media item, its URL, the alt text and the size. */
export function coverValue({ item, cmsUrl, bytes, type, alt }) {
  const size = imageSize(bytes, type);
  const v = { provider: "local", id: item.id, src: cmsUrl, alt: String(alt ?? ""), filename: item.filename || undefined, mimeType: item.mimeType || type, meta: { storageKey: item.storageKey || cmsUrl.split("/").pop() } };
  const w = item.width || size?.width, h = item.height || size?.height;
  if (w) v.width = w;
  if (h) v.height = h;
  return JSON.parse(JSON.stringify(v));
}

const IMAGE_LINE = /^!\[((?:\\.|[^\]\\])*)\]\(([^\s()<>]+)\)$/;
const CODE_OPEN = /^(`{3,})([^`\s]*)\s*$/;
const decode = (s) => { try { return decodeURIComponent(s); } catch { return String(s); } };

/** Whole-line image lines outside code fences: [{ index, alt, url }] (the converter's image rule). */
export function imageLines(body) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].match(CODE_OPEN);
    if (code) { i++; while (i < lines.length && lines[i] !== code[1]) i++; continue; }
    const m = lines[i].match(IMAGE_LINE);
    if (m) out.push({ index: i, alt: m[1], url: m[2] });
  }
  return out;
}

/**
 * What a body points at under the prefix. images: the image blocks' URLs under it (in order); stray: any other place a
 * converted block names the prefix (a link, an inline image left as text, a reference definition, an opaque block), and
 * image URLs that hold the prefix only after percent-decoding or in another case.
 */
export function mediaRefsOf(body, prefix) {
  const images = [], stray = [];
  const low = prefix.toLowerCase();
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const starts = (s) => [String(s ?? ""), decode(String(s ?? ""))].some((t) => t.trim().replace(/^</, "").toLowerCase().startsWith(low));
  // Markdown left as text: "](/media/..." (an inline image or link the converter did not take) or "]: /media/..." (a reference definition).
  const asText = new RegExp(`\\]\\(\\s*<?\\s*${esc}|\\]:\\s*<?\\s*${esc}`, "i");
  const inText = (s) => [String(s ?? ""), decode(String(s ?? ""))].some((t) => asText.test(t));
  for (const b of fromMarkdown(body)) {
    if (b?._type === "code") continue;
    if (b?._type === "image" && b.asset && typeof b.asset.url === "string" && Object.keys(b.asset).length === 1) {
      if (b.asset.url.startsWith(prefix)) images.push(b.asset.url);
      else if (starts(b.asset.url)) stray.push(b.asset.url);
      continue;
    }
    if (b?._type === "block") {
      for (const d of b.markDefs || []) if (starts(d?.href)) stray.push(String(d.href));
      for (const s of b.children || []) if (inText(s?.text)) stray.push(String(s.text).slice(0, 120));
      continue;
    }
    if (JSON.stringify(b).toLowerCase().includes(`"${low}`)) stray.push(`a ${b?._type || "raw"} block`);
  }
  return { images, stray };
}

/** Why the path after the prefix is not a safe relative file path with an image extension, or null. */
export function unsafeRel(rel) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(rel)) return "the path may only hold folders and a file name made of letters, digits, \".\", \"_\" and \"-\" (no \"..\", no leading dot, no query, no percent escapes)";
  const ext = rel.split(".").pop().toLowerCase();
  if (!rel.includes(".") || !Object.values(MEDIA_TYPES).flat().includes(ext)) return `"${ext}" is not an image extension (${Object.values(MEDIA_TYPES).flat().join(", ")})`;
  return null;
}

/** Reads one local image and checks it. Returns { url, rel, path, bytes, type, hash }. Throws MediaError. */
export function readLocal(url, media) {
  const rel = url.slice(media.prefix.length);
  const bad = unsafeRel(rel);
  if (bad) throw new MediaError(`image ${url}: ${bad}`, "media-path");
  const path = join(media.dir, ...rel.split("/"));
  // No symbolic link from the media folder down to the file, and the real path stays inside the folder.
  let at = media.dir;
  for (const part of rel.split("/")) {
    at = join(at, part);
    let st;
    try { st = lstatSync(at); } catch { throw new MediaError(`image ${url}: ${relative(process.cwd(), path) || path} does not exist`, "media-missing"); }
    if (st.isSymbolicLink()) throw new MediaError(`image ${url}: ${part} is a symbolic link; media files must be plain files inside the media folder`, "media-path");
  }
  if (!lstatSync(path).isFile()) throw new MediaError(`image ${url} is not a plain file`, "media-path");
  const inside = relative(realpathSync(media.dir), realpathSync(path));
  if (inside.startsWith("..") || isAbsolute(inside) || inside.split(sep)[0] === "..") throw new MediaError(`image ${url} is outside the media folder`, "media-path");
  const bytes = readFileSync(path);
  return checkBytes(url, rel, path, bytes, media);
}

function checkBytes(url, rel, path, bytes, media) {
  if (bytes.length > media.maxBytes) throw new MediaError(`image ${url} is ${bytes.length} bytes (the limit is ${media.maxBytes})`, "media-too-large");
  const type = sniffType(bytes);
  const ext = rel.split(".").pop().toLowerCase();
  if (!type) throw new MediaError(`image ${url} is not a JPEG, PNG, GIF, WebP or AVIF file (its first bytes say otherwise)`, "media-type");
  if (!MEDIA_TYPES[type].includes(ext)) throw new MediaError(`image ${url} is named .${ext} but its bytes are ${type}`, "media-type");
  return { url, rel, path, bytes, type, hash: contentHash(bytes) };
}

/** body with each whole-line image URL found in map replaced by map's value. */
export function rewriteBody(body, map) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  for (const l of imageLines(body)) if (map.has(l.url)) lines[l.index] = `![${l.alt}](${map.get(l.url)})`;
  return lines.join("\n");
}

/** Proof the rewrite changed nothing but those image URLs: the converted blocks are equal once the old URLs are mapped. */
function sameButUrls(before, after, map) {
  const a = normalizeBlocks(fromMarkdown(before)).map((b) => (b?._type === "image" && map.has(b.asset?.url) ? { ...b, asset: { ...b.asset, url: map.get(b.asset.url) } } : b));
  return JSON.stringify(a) === JSON.stringify(normalizeBlocks(fromMarkdown(after)));
}

/** A CMS media URL as the body will hold it: the item's url (relative /_emdash/api/media/file/<key> in 0.1.0). */
function itemUrl(item) {
  const url = item?.url || (item?.storageKey ? `/_emdash/api/media/file/${item.storageKey}` : null);
  if (!url || /[\s()<>]/.test(url)) return null;
  return url;
}

/**
 * Map(contentHash -> item) of the library's ready items. Several ready items can share a hash (an upload path that does
 * not deduplicate, an admin upload): the pick must be stable, so a later run builds the same body. prefer: CMS URLs the
 * live post already points at; an item with one of those URLs wins. Otherwise the OLDEST item (createdAt; EmDash lists
 * newest first, so the last one listed when there are no dates).
 */
export async function mediaIndex(api, { prefer = null } = {}) {
  let items;
  try { items = await api.listMedia(); }
  catch (e) { throw new MediaError(`the media library could not be read (${e.message}); the token needs the media:read and media:write scopes. Nothing was written.`, "media-list-failed", 1); }
  const groups = new Map();
  items.forEach((it, i) => {
    if (!it?.contentHash || it.status === "failed") return;
    if (!groups.has(it.contentHash)) groups.set(it.contentHash, []);
    groups.get(it.contentHash).push({ it, i });
  });
  const index = new Map();
  const time = (x) => { const t = Date.parse(x.it.createdAt || ""); return Number.isFinite(t) ? t : null; };
  for (const [hash, list] of groups) {
    const liked = prefer ? list.find((x) => prefer.has(itemUrl(x.it))) : null;
    const oldest = [...list].sort((a, b) => { const ta = time(a), tb = time(b); if (ta != null && tb != null && ta !== tb) return ta - tb; return b.i - a.i; })[0];
    index.set(hash, (liked || oldest).it);
  }
  return index;
}

/** The CMS media URLs a stored post (its data, any shape) points at: the URLs a stable pick prefers. */
export function mediaUrlsIn(data) {
  const out = new Set();
  for (const m of JSON.stringify(data ?? null).matchAll(/\/_emdash\/api\/media\/file\/[^"\s()<>\\]+/g)) out.add(m[0]);
  return out;
}

/**
 * Upload (or find) every local image of one file and rewrite its body. parsed: a parsed mirror file. Returns
 * { parsed (body rewritten; the same object when there is nothing to do), images: [report rows], index }.
 * dry: nothing is uploaded; images not in the library are reported as "would upload" and keep their local URL.
 */
export async function prepareMedia({ api, parsed, media, dry = false, prefer = null }) {
  if (!media) return { parsed, images: [], index: null };
  const refs = mediaRefsOf(parsed.body, media.prefix);
  if (refs.stray.length) throw new MediaError(`the body points into the media folder (${media.prefix}) outside a whole-line image: ${refs.stray.slice(0, 3).map((s) => JSON.stringify(s)).join(", ")}. Only a line of its own "![alt](${media.prefix}...)" is uploaded; anything else would publish a dead path. Nothing was written.`, "media-ref-form");
  const urls = [...new Set(refs.images)];
  const coverRef = coverRefOf(parsed, media);
  if (!urls.length && !coverRef) return { parsed, images: [], index: null };
  if (urls.length > media.maxImages) throw new MediaError(`${urls.length} different local images; the limit is ${media.maxImages}. Nothing was written.`, "media-too-many");
  if (coverRef && !(typeof parsed.meta.imageAlt === "string" && parsed.meta.imageAlt.trim())) throw new MediaError(`the cover ${coverRef} needs an "imageAlt" (its alt text) in the front matter. Nothing was written.`, "media-cover-alt");
  // Every file is read and checked before the first request: a bad file stops the post before anything is uploaded.
  const locals = urls.map((u) => readLocal(u, media));
  if (coverRef) locals.push({ ...readLocal(coverRef, media.cover), cover: true });
  // prefer: an async function giving the CMS URLs the live post uses; called only after every local file passed.
  const index = await mediaIndex(api, { prefer: typeof prefer === "function" ? await prefer() : prefer });
  const rows = [];
  for (const l of locals) {
    let item = index.get(l.hash);
    const row = { url: l.url, file: l.rel, bytes: l.bytes.length, type: l.type, hash: l.hash, reused: !!item, uploaded: false };
    if (!item && dry) { row.wouldUpload = true; rows.push(row); continue; }
    if (!item) {
      let res;
      try { res = await api.uploadMedia({ filename: l.rel.split("/").pop(), type: l.type, bytes: l.bytes }); }
      catch (e) { throw new MediaError(`uploading ${l.url} failed (${e.message}). The post was not written; images uploaded before it stay in the library and are reused by the next run.`, "media-upload-failed", 1); }
      item = res?.item;
      if (!item) throw new MediaError(`uploading ${l.url} returned no media item. The post was not written.`, "media-upload-failed", 1);
      if (item.contentHash && item.contentHash !== l.hash) throw new MediaError(`the CMS stored ${l.url} with content hash ${item.contentHash}, not ${l.hash}. The post was not written.`, "media-upload-mismatch", 1);
      row.uploaded = !res.deduplicated;
      row.deduplicated = !!res.deduplicated;
      index.set(l.hash, item);
    }
    row.mediaId = item.id ?? null;
    row.cmsUrl = itemUrl(item);
    if (!row.cmsUrl) throw new MediaError(`the media item for ${l.url} has no usable URL. The post was not written.`, "media-upload-mismatch", 1);
    rows.push(row);
  }
  // Read back every image the body will point at (reused ones too): the post must never point at a missing or other file.
  if (!dry) for (const row of rows) {
    let got;
    try { got = await api.mediaFile(row.cmsUrl); }
    catch (e) { throw new MediaError(`reading back ${row.cmsUrl} (${row.url}) failed (${e.message}). The post was not written.`, "media-readback-failed", 1); }
    if (got.status !== 200 || contentHash(got.bytes) !== row.hash) throw new MediaError(`reading back ${row.cmsUrl} (${row.url}) gave HTTP ${got.status}${got.status === 200 ? " with other bytes" : ""}. The post was not written.`, "media-readback-failed", 1);
    row.verified = true;
  }
  const map = new Map(rows.filter((r, i) => !locals[i].cover && r.cmsUrl).map((r) => [r.url, r.cmsUrl]));
  const body = rewriteBody(parsed.body, map);
  if (!sameButUrls(parsed.body, body, map)) throw new MediaError("rewriting the image URLs would change more than the URLs (a line the converter reads differently); nothing was written", "media-rewrite");
  const out = { ...parsed, body };
  const ci = locals.findIndex((l) => l.cover);
  // The cover: the featured image value of the media item that was read back (or, in a dry run, found); kept beside the file's own front matter.
  if (ci >= 0) {
    const row = rows[ci];
    if (!row?.cmsUrl) { row.cover = true; return { parsed: out, images: rows, index }; } // dry run, not uploaded yet: the post keeps no cover value
    row.cover = true;
    out.cover = coverValue({ item: index.get(locals[ci].hash), cmsUrl: row.cmsUrl, bytes: locals[ci].bytes, type: locals[ci].type, alt: parsed.meta.imageAlt });
  }
  return { parsed: out, images: rows, index };
}

/**
 * The same rewrite for an older version of the file (its previous version, or a version in git), with no network and no
 * upload: each local image is read at that version (ref: a git commit, or null for the files on disk now), hashed, and
 * mapped when the library has that hash. Anything that cannot be mapped keeps its local URL, so that version simply does
 * not equal the live post (the safe direction: a write that needs it is refused, never one that guesses).
 */
export function rewriteVersion(parsed, { media, index, ref = null }) {
  if (!parsed || !media || !index) return parsed;
  const withCover = (p) => {
    const cr = coverRefOf(p, media);
    if (!cr || p.cover) return p;
    const rel = cr.slice(media.cover.prefix.length);
    if (unsafeRel(rel)) return p;
    let bytes = null;
    try {
      bytes = ref == null ? readLocal(cr, media.cover).bytes
        : execFileSync("git", ["show", "--end-of-options", `${ref}:./${rel}`], { cwd: media.cover.dir, stdio: ["ignore", "pipe", "ignore"], maxBuffer: media.maxBytes + 1024 });
    } catch { return p; }
    const item = index.get(contentHash(bytes));
    const cms = item && itemUrl(item);
    return cms ? { ...p, cover: coverValue({ item, cmsUrl: cms, bytes, type: sniffType(bytes) || "image/jpeg", alt: p.meta?.imageAlt }) } : p;
  };
  const map = new Map();
  for (const url of new Set(mediaRefsOf(parsed.body, media.prefix).images)) {
    const rel = url.slice(media.prefix.length);
    if (unsafeRel(rel)) continue;
    let bytes = null;
    try {
      bytes = ref == null ? readLocal(url, media).bytes
        : execFileSync("git", ["show", "--end-of-options", `${ref}:./${rel}`], { cwd: media.dir, stdio: ["ignore", "pipe", "ignore"], maxBuffer: media.maxBytes + 1024 });
    } catch { continue; }
    const item = index.get(contentHash(bytes));
    const cms = item && itemUrl(item);
    if (cms) map.set(url, cms);
  }
  if (!map.size) return withCover(parsed);
  const body = rewriteBody(parsed.body, map);
  return withCover(sameButUrls(parsed.body, body, map) ? { ...parsed, body } : parsed);
}
