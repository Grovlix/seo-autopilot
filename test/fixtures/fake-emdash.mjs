// An in-memory stand-in for the EmDash 0.1.0 content API, with the behaviour the mirror depends on (read in EmDash's
// source): data saves on a "revisions" collection go to a draft revision (the whole merged data, plus _slug when a slug
// is sent) and leave the live row alone; publish copies the draft into the row and applies _slug; SEO writes go live at
// once; get and list skip trashed rows (deletedAt); _rev = base64(version:updatedAt). Synthetic content only.

// Media (0.1.0 src/astro/routes/api/media.ts, media/file/[key].ts): GET /_emdash/api/media lists ready items (limit,
// cursor), POST takes multipart "file" and answers an upload of known bytes (same sha1 content hash) with the existing item
// and deduplicated: true; GET /_emdash/api/media/file/<key> serves the bytes. mediaFail(filename) -> HTTP status makes an
// upload fail (test helper); mediaScope: false answers every media route 403 INSUFFICIENT_SCOPE (a content-only token).
// Like Astro's security.checkOrigin (on by default, runs before routing and auth): a POST/PUT/PATCH/DELETE with a form
// content type (a FormData body, or a content-type of multipart/form-data, application/x-www-form-urlencoded or
// text/plain) and no Origin header equal to the site's origin gets 403 "Cross-site POST form submissions are forbidden"
// (plain text, no JSON error). JSON bodies are not checked.
import { createHash } from "node:crypto";

export function fakeEmDash({ revisions = true, seo = true, schemaReadable = false, previewSecret = false, posts = [], media: mediaSeed = [], mediaScope = true, mediaPage = 50 } = {}) {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  let n = 0;
  const now = () => new Date((clock += 1000)).toISOString();
  const id = () => `01FAKE${String(++n).padStart(20, "0")}`;
  const rows = new Map();
  const revs = new Map();
  const seoRows = new Map();
  const log = [];
  const media = [];
  const files = new Map();
  const mediaFail = { fn: null };
  const hashOf = (buf) => `sha1:${createHash("sha1").update(buf).digest("hex")}`;
  const addMedia = (filename, type, buf) => {
    const mid = id();
    const ext = (filename.match(/\.[^.]+$/) || [""])[0];
    const item = { id: mid, filename, mimeType: type, size: buf.length, width: null, height: null, alt: null, caption: null, storageKey: `${mid}${ext}`, status: "ready", contentHash: hashOf(buf), blurhash: null, dominantColor: null, createdAt: now(), authorId: "u1" };
    media.push(item); files.set(item.storageKey, { type, buf: Buffer.from(buf) });
    return item;
  };
  for (const m of mediaSeed) addMedia(m.filename, m.type, m.bytes);
  const withUrl = (it) => ({ ...it, url: `/_emdash/api/media/file/${it.storageKey}` });
  for (const p of posts) {
    const rid = id();
    const row = { id: rid, type: "posts", slug: p.slug, status: p.status || "published", data: structuredClone(p.data), authorId: "u1", primaryBylineId: null, createdAt: now(), updatedAt: now(), publishedAt: p.publishedAt === undefined ? now() : p.publishedAt, scheduledAt: p.scheduledAt ?? null, deletedAt: p.deletedAt ?? null, liveRevisionId: null, draftRevisionId: null, version: 1, locale: p.locale || "en", translationGroup: rid, terms: p.terms || {} };
    rows.set(rid, row);
    if (seo) seoRows.set(rid, { title: null, description: null, image: null, canonical: null, noIndex: false, ...(p.seo || {}) });
  }
  const findAny = (k) => rows.get(k) || [...rows.values()].find((r) => r.slug === k);
  const find = (k) => { const r = rows.get(k) || [...rows.values()].find((x) => x.slug === k && !x.deletedAt); return r && !r.deletedAt ? r : undefined; };
  /** Test helper: an admin saves a draft (like the admin UI: whole merged data, _slug when the slug changes). */
  function adminDraft(k, { data = {}, slug } = {}) {
    const r = find(k);
    const baseData = r.draftRevisionId ? revs.get(r.draftRevisionId).data : r.data;
    const merged = { ...baseData, ...structuredClone(data) };
    if (slug !== undefined) merged._slug = slug;
    const rid = id(); revs.set(rid, { id: rid, data: merged }); r.draftRevisionId = rid; r.updatedAt = now(); r.version++;
  }
  /** Test helper: the admin editor's autosave (skipRevision: rewrites the existing draft revision in place, same id). */
  function adminAutosave(k, { data = {} } = {}) {
    const r = find(k);
    if (!r.draftRevisionId) return adminDraft(k, { data });
    const d = revs.get(r.draftRevisionId);
    d.data = { ...d.data, ...structuredClone(data) }; r.updatedAt = now(); r.version++;
  }
  const view = (r) => { const { terms, ...v } = structuredClone(r); if (seo) v.seo = { ...seoRows.get(r.id) }; return v; };
  const rev = (r) => Buffer.from(`${r.version}:${r.updatedAt}`).toString("base64");
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ok = (data, status = 200) => json(status, { data });
  const err = (status, code, message = code) => json(status, { error: { code, message } });

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method || "GET";
    const form = init.body instanceof FormData ? init.body : null;
    const hdr = (k) => Object.entries(init.headers || {}).find(([n]) => n.toLowerCase() === k)?.[1];
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
      const formType = form || /^(multipart\/form-data|application\/x-www-form-urlencoded|text\/plain)/i.test(String(hdr("content-type") || ""));
      if (formType && hdr("origin") !== u.origin) return new Response("Cross-site POST form submissions are forbidden", { status: 403, headers: { "content-type": "text/plain;charset=UTF-8" } });
    }
    const body = init.body && !form ? JSON.parse(init.body) : undefined;
    log.push({ method, path: u.pathname + u.search, auth: !!init.headers?.authorization });
    const p = u.pathname;
    if (p.startsWith("/_emdash/api/media/file/")) {
      const f = files.get(decodeURIComponent(p.slice("/_emdash/api/media/file/".length)));
      if (init.headers?.authorization && !mediaScope) return err(403, "INSUFFICIENT_SCOPE");
      return f ? new Response(f.buf, { status: 200, headers: { "content-type": f.type } }) : err(404, "NOT_FOUND", "File not found");
    }
    if (p.startsWith("/_emdash/api/") && !init.headers?.authorization) return err(401, "NOT_AUTHENTICATED");
    if (p === "/_emdash/api/media" && !mediaScope) return err(403, "INSUFFICIENT_SCOPE", "Token lacks required scope");
    if (p === "/_emdash/api/media" && method === "GET") {
      const limit = Math.min(Number(u.searchParams.get("limit") || mediaPage), mediaPage, 100);
      const start = Number(u.searchParams.get("cursor") || 0);
      const ready = media.filter((x) => x.status === "ready");
      const page = ready.slice(start, start + limit).map(withUrl);
      return ok({ items: page, ...(start + limit < ready.length ? { nextCursor: String(start + limit) } : {}) });
    }
    if (p === "/_emdash/api/media" && method === "POST") {
      const file = form?.get("file");
      if (!file || typeof file === "string") return err(400, "NO_FILE", "No file provided");
      if (!/^(image|video|audio)\//.test(file.type) && file.type !== "application/pdf") return err(400, "INVALID_TYPE", "File type not allowed");
      const fail = mediaFail.fn?.(file.name);
      if (fail) return err(fail, "UPLOAD_ERROR", "Upload failed");
      const buf = Buffer.from(await file.arrayBuffer());
      const existing = media.find((x) => x.status === "ready" && x.contentHash === hashOf(buf));
      if (existing) return ok({ item: withUrl(existing), deduplicated: true });
      return ok({ item: withUrl(addMedia(file.name, file.type, buf)) }, 201);
    }
    if (p === "/_emdash/api/schema/collections/posts") return schemaReadable ? ok({ item: { slug: "posts", supports: revisions ? ["drafts", "revisions", "seo"] : ["drafts"] } }) : err(403, "INSUFFICIENT_SCOPE");
    let m;
    if (p === "/_emdash/api/content/posts" && method === "GET") {
      const status = u.searchParams.get("status");
      const items = [...rows.values()].filter((r) => !r.deletedAt && (!status || r.status === status)).map(view);
      return ok({ items });
    }
    if (p === "/_emdash/api/content/posts" && method === "POST") {
      const rid = id();
      const row = { id: rid, type: "posts", slug: body.slug, status: body.status || "draft", data: structuredClone(body.data), authorId: "u1", primaryBylineId: null, createdAt: now(), updatedAt: now(), publishedAt: null, scheduledAt: null, liveRevisionId: null, draftRevisionId: null, version: 1, locale: "en", translationGroup: rid, terms: {} };
      rows.set(rid, row);
      if (seo) seoRows.set(rid, { title: null, description: null, image: null, canonical: null, noIndex: false, ...(body.seo || {}) });
      return ok({ item: view(row), _rev: rev(row) }, 201);
    }
    if ((m = p.match(/^\/_emdash\/api\/content\/posts\/([^/]+)(?:\/(.+))?$/))) {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return err(404, "NOT_FOUND");
      const sub = m[2];
      if (!sub && method === "GET") return ok({ item: view(r), _rev: rev(r) });
      if (!sub && method === "PUT") {
        if (body._rev && body._rev !== rev(r)) return err(409, "CONFLICT", "Content has been modified since last read (version conflict)");
        if (body.seo && !seo) return err(400, "VALIDATION_ERROR");
        if (body.data) {
          if (revisions) {
            const baseData = r.draftRevisionId ? revs.get(r.draftRevisionId).data : r.data;
            const merged = { ...baseData, ...structuredClone(body.data), ...(body.slug !== undefined ? { _slug: body.slug } : {}) };
            // 0.1.0 emdash-runtime.ts:1484-1486: an autosave (skipRevision) rewrites the existing draft revision in place.
            if (body.skipRevision && r.draftRevisionId) revs.get(r.draftRevisionId).data = merged;
            else { const rid = id(); revs.set(rid, { id: rid, data: merged }); r.draftRevisionId = rid; }
          } else r.data = { ...r.data, ...structuredClone(body.data) };
        }
        if (body.status) r.status = body.status;
        if (body.seo) { const s = seoRows.get(r.id); for (const [k, v] of Object.entries(body.seo)) if (v !== undefined) s[k] = v; }
        r.updatedAt = now();
        r.version++;
        return ok({ item: view(r), _rev: rev(r) });
      }
      if (sub === "publish" && method === "POST") {
        let pick = r.draftRevisionId || r.liveRevisionId;
        if (!pick) { pick = id(); revs.set(pick, { id: pick, data: structuredClone(r.data) }); }
        const { _slug, ...data } = revs.get(pick).data;
        r.data = structuredClone(data);
        if (typeof _slug === "string") r.slug = _slug;
        r.liveRevisionId = pick; r.draftRevisionId = null; r.status = "published";
        r.publishedAt = r.publishedAt || now(); r.updatedAt = now();
        return ok({ item: view(r) });
      }
      // 0.1.0 discardDraft: only draft_revision_id = NULL and updated_at; the revision row stays.
      if (sub === "discard-draft" && method === "POST") {
        if (r.draftRevisionId) { r.draftRevisionId = null; r.updatedAt = now(); }
        return ok({ item: view(r) });
      }
      if (sub === "compare") return ok({ hasChanges: !!r.draftRevisionId && r.draftRevisionId !== r.liveRevisionId, live: r.liveRevisionId ? revs.get(r.liveRevisionId).data : null, draft: r.draftRevisionId ? revs.get(r.draftRevisionId).data : null });
      const t = sub?.match(/^terms\/(.+)$/);
      if (t) return ok({ terms: (r.terms[t[1]] || []).map((s) => ({ id: s, name: t[1], slug: s, label: s, parentId: null })) });
      if (sub === "preview-url") {
        if (!previewSecret) return err(500, "NOT_CONFIGURED", "Preview not configured. Set EMDASH_PREVIEW_SECRET environment variable.");
        const path = (body?.pathPattern || "/{collection}/{id}").replace("{collection}", "posts").replace("{id}", decodeURIComponent(m[1]));
        return ok({ url: `${path}?_preview=signed-${r.id}`, expiresAt: 0 });
      }
    }
    // Public site: published posts only, drafts with a valid preview token.
    if ((m = p.match(/^\/posts\/(.+)$/))) {
      const r = find(decodeURIComponent(m[1]));
      const previewing = r && u.searchParams.get("_preview") === `signed-${r.id}`;
      if (!r || (r.status !== "published" && !previewing)) return new Response("<html><main>Not found</main></html>", { status: 404 });
      const data = previewing && r.draftRevisionId ? revs.get(r.draftRevisionId).data : r.data;
      const text = (data.content || []).map((b) => (b.children || []).map((s) => s.text).join("")).join(" ");
      return new Response(`<html><head><title>x</title></head><body><nav>Home Blog</nav><main><h1>${data.title}</h1><p>${text}</p></main></body></html>`, { status: 200 });
    }
    if (p === "/sitemap.xml") return new Response(`<urlset>${[...rows.values()].filter((r) => r.status === "published" && !r.deletedAt).map((r) => `<url><loc>${u.origin}/posts/${encodeURIComponent(r.slug)}</loc></url>`).join("")}</urlset>`);
    if (p === "/rss.xml") return new Response(`<rss>${[...rows.values()].filter((r) => r.status === "published" && r.publishedAt).map((r) => `<link>${u.origin}/posts/${r.slug}</link>`).join("")}</rss>`);
    return err(404, "NOT_FOUND");
  }
  return { fetch, rows, revs, seoRows, log, find, findAny, adminDraft, adminAutosave, media, files, mediaFail };
}
