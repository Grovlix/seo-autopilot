// cms discard (review R8 F4: a closed pull request's preview draft stays on a live post) and files without an id
// (R8 F5: a new post published from a file leaves the file id-less, which blocked every later edit), against the
// in-memory EmDash 0.1.0 stand-in and real local git repositories. Synthetic content only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { cms } from "../src/cms/commands.mjs";
import { parseMirror, stringifyMirror } from "../src/cms/mirror.mjs";

const URL_ = "https://cms.example.test";
const para = (text, key = "p") => ({ _type: "block", _key: key, style: "normal", markDefs: [], children: [{ _type: "span", _key: key + "s", text, marks: [] }] });
const bodyText = (row) => row.data.content.map((b) => b.children.map((c) => c.text).join("")).join("\n");
const AR = "دليل-البداية";
const AR_PATTERN = "^[a-z0-9ء-ي]+(?:-[a-z0-9ء-ي]+)*$";

const site = (extra = []) => fakeEmDash({ previewSecret: true, posts: [
  { slug: "alpha", data: { title: "Alpha", content: [para("Alpha words here.")] }, seo: { title: "Alpha SEO" } },
  { slug: "beta", data: { title: "Beta", content: [para("Beta words here.")] } },
  { slug: AR, data: { title: "دليل", content: [para("نص عربي قصير.")] } },
  ...extra,
] });

async function run(args, fake, { fetch } = {}) {
  const flags = {}; const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) { const k = a.slice(2); if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) flags[k] = args[++i]; else flags[k] = true; }
    else positional.push(a);
  }
  const saved = { log: console.log, url: process.env.EMDASH_URL, token: process.env.EMDASH_TOKEN, proven: process.env.EMDASH_REVISIONS_PROVEN };
  const lines = [];
  console.log = (s) => lines.push(String(s));
  process.env.EMDASH_URL = URL_; process.env.EMDASH_TOKEN = "test-token-not-real"; delete process.env.EMDASH_REVISIONS_PROVEN;
  try { const code = await cms({ flags, positional }, { fetch: fetch || fake.fetch }); return { code, report: JSON.parse(lines.join("\n")), raw: lines.join("\n") }; }
  finally {
    console.log = saved.log;
    for (const [k, v] of [["EMDASH_URL", saved.url], ["EMDASH_TOKEN", saved.token], ["EMDASH_REVISIONS_PROVEN", saved.proven]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

/** A site repository: posts/ exported from the fake CMS, settings with revisionsProven, one commit per step. */
async function repo(fake, { proven = true, slugPattern } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cms-t16-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.test"); git("config", "user.name", "t");
  const settings = join(dir, "cms.json");
  writeFileSync(settings, JSON.stringify({ collection: "posts", revisionsProven: proven, ...(slugPattern ? { slugPattern } : {}) }));
  const posts = join(dir, "posts");
  await run(["export", "--dir", posts], fake);
  git("add", "-A"); git("commit", "-qm", "seed");
  const file = (slug) => join(posts, `${slug}.md`);
  const commit = (msg) => { git("add", "-A"); git("commit", "-qm", msg); return git("rev-parse", "HEAD"); };
  const edit = (slug, fn) => { const p = parseMirror(readFileSync(file(slug), "utf8")); fn(p); writeFileSync(file(slug), stringifyMirror(p.meta, p.body)); };
  const newPost = (slug, title, body) => writeFileSync(file(slug), `---\ntitle: ${JSON.stringify(title)}\nslug: ${JSON.stringify(slug)}\n---\n\n${body}\n`);
  const cmd = (name, slug, ...extra) => run([name, "--file", file(slug), "--settings", settings, ...extra], fake);
  return { dir, git, posts, settings, file, commit, edit, newPost, cmd, head: () => git("rev-parse", "HEAD") };
}
const writes = (fake) => fake.log.filter((l) => l.method !== "GET");
const discards = (fake) => fake.log.filter((l) => l.method === "POST" && l.path.endsWith("/discard-draft"));
const pending = (row) => !!row.draftRevisionId && row.draftRevisionId !== row.liveRevisionId;

/** A pull request on a branch that edits one post and gets its preview draft; returns the base commit. */
async function previewed(r, slug, from, to) {
  const base = r.head();
  r.git("checkout", "-qb", `pr-${Date.now()}`);
  r.edit(slug, (p) => { p.body = p.body.replace(from, to); });
  r.commit(`edit ${slug}`);
  const d = await r.cmd("draft", slug, "--base-ref", base);
  assert.equal(d.code, 0, d.raw);
  return base;
}

// ------------------------------------------------------------------------------------------------ discard

test("discard removes the preview draft of a closed pull request; the live post and the revision history stay", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "alpha", "Alpha words here.", "Alpha words, closed PR text.");
  const row = fake.find("alpha");
  const draftRev = row.draftRevisionId;
  assert.ok(pending(row));
  const before = structuredClone(row.data);
  const d = await r.cmd("discard", "alpha", "--base-ref", base);
  assert.equal(d.code, 0, d.raw);
  assert.equal(d.report.discarded, true);
  assert.equal(discards(fake).length, 1);
  assert.equal(pending(fake.find("alpha")), false);
  assert.deepEqual(fake.find("alpha").data, before, "live data untouched");
  assert.equal(fake.find("alpha").status, "published");
  assert.ok(fake.revs.has(draftRev), "the discarded revision stays in the history");
  // The next merged edit of the same post is no longer blocked by the closed PR's draft.
  r.git("checkout", "-q", "main");
  const b2 = r.head(); r.edit("alpha", (p) => { p.body = p.body.replace("Alpha words here.", "Alpha words, merged PR."); }); r.commit("merged");
  const p = await r.cmd("publish", "alpha", "--base-ref", b2);
  assert.equal(p.code, 0, p.raw);
  assert.match(bodyText(fake.find("alpha")), /merged PR/);
});

test("discard refuses someone else's draft (exit 3, foreign-draft) and leaves it", async () => {
  const fake = site(); const r = await repo(fake);
  const base = r.head();
  r.git("checkout", "-qb", "pr"); r.edit("alpha", (p) => { p.body += "\nPR words.\n"; }); r.commit("pr");
  fake.adminDraft("alpha", { data: { title: "Alpha (an editor's draft)" } });
  const draftRev = fake.find("alpha").draftRevisionId;
  const n = writes(fake).length;
  const d = await r.cmd("discard", "alpha", "--base-ref", base);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "foreign-draft");
  assert.equal(writes(fake).length, n, "no write");
  assert.equal(fake.find("alpha").draftRevisionId, draftRev);
});

test("discard on top of our preview after an editor saved over it in the admin refuses (the draft is no longer ours)", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "beta", "Beta words here.", "Beta words, PR.");
  fake.adminDraft("beta", { data: { title: "Beta, edited by an editor" } });
  const d = await r.cmd("discard", "beta", "--base-ref", base);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "foreign-draft");
  assert.equal(discards(fake).length, 0);
});

test("discard with no pending draft exits 4 (no-draft) and writes nothing", async () => {
  const fake = site(); const r = await repo(fake);
  const base = r.head();
  r.git("checkout", "-qb", "pr"); r.edit("alpha", (p) => { p.body += "\nPR words.\n"; }); r.commit("pr");
  const d = await r.cmd("discard", "alpha", "--base-ref", base);
  assert.equal(d.code, 4, d.raw);
  assert.equal(d.report.refusal, "no-draft");
  assert.deepEqual(writes(fake), []);
});

test("discard refuses when the live post changed under the draft (an admin edit of the live row), exit 3", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "alpha", "Alpha words here.", "Alpha words, PR.");
  fake.find("alpha").data.title = "Alpha (changed live in the admin)";
  const d = await r.cmd("discard", "alpha", "--base-ref", base);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "live-changed");
  assert.ok(pending(fake.find("alpha")), "draft left in place");
  assert.equal(discards(fake).length, 0);
});

test('discard with "revisionsProven": false sends 0 requests (GET included), exit 3', async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "alpha", "Alpha words here.", "Alpha words, PR.");
  writeFileSync(r.settings, JSON.stringify({ collection: "posts", revisionsProven: false }));
  const n = fake.log.length;
  const d = await r.cmd("discard", "alpha", "--base-ref", base);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "writes-off");
  assert.equal(fake.log.length, n, "0 requests");
  assert.ok(pending(fake.find("alpha")));
});

test("discard of a published post without the file's previous version refuses (no-base), nothing written", async () => {
  const fake = site(); const r = await repo(fake);
  await previewed(r, "alpha", "Alpha words here.", "Alpha words, PR.");
  const n = writes(fake).length;
  const d = await r.cmd("discard", "alpha");
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "no-base");
  assert.equal(writes(fake).length, n);
  assert.ok(pending(fake.find("alpha")));
});

test("discard never deletes a post: an unpublished post made from a new file is refused (not-published)", async () => {
  const fake = site(); const r = await repo(fake);
  const base = r.head();
  r.git("checkout", "-qb", "pr"); r.newPost("fresh-post", "Fresh", "A fresh post."); r.commit("new");
  assert.equal((await r.cmd("draft", "fresh-post", "--base-ref", base)).code, 0);
  const d = await r.cmd("discard", "fresh-post", "--base-ref", base);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "not-published");
  assert.ok(fake.find("fresh-post"), "post still there");
  assert.equal(discards(fake).length, 0);
});

test("discard re-reads the draft before the call: a draft saved in between is not discarded (draft-changed)", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "alpha", "Alpha words here.", "Alpha words, PR.");
  let compared = false;
  const racing = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || "GET") === "GET" && compared && /\/content\/posts\/[^/]+$/.test(u.pathname)) { fake.adminDraft("alpha", { data: { title: "Saved in between" } }); compared = false; }
    if (u.pathname.endsWith("/compare")) compared = true;
    return fake.fetch(url, init);
  };
  const d = await run(["discard", "--file", r.file("alpha"), "--settings", r.settings, "--base-ref", base], fake, { fetch: racing });
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "draft-changed");
  assert.equal(discards(fake).length, 0);
  assert.equal(fake.find("alpha").data.title, "Alpha");
});

test("discard --dry reports what it would do and writes nothing", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "alpha", "Alpha words here.", "Alpha words, PR.");
  const d = await r.cmd("discard", "alpha", "--base-ref", base, "--dry");
  assert.equal(d.code, 0, d.raw);
  assert.equal(d.report.wouldDiscard, true);
  assert.equal(discards(fake).length, 0);
  assert.ok(pending(fake.find("alpha")));
});

test("discard works on an Arabic slug", async () => {
  const fake = site(); const r = await repo(fake, { slugPattern: AR_PATTERN });
  const base = await previewed(r, AR, "نص عربي قصير.", "نص عربي قصير، تعديل مغلق.");
  assert.ok(pending(fake.find(AR)));
  const d = await r.cmd("discard", AR, "--base-ref", base);
  assert.equal(d.code, 0, d.raw);
  assert.equal(pending(fake.find(AR)), false);
  assert.equal(bodyText(fake.find(AR)), "نص عربي قصير.");
});

// ------------------------------------------------------------------------------------------------ files without an id

/** A new post published from an id-less file (as the publish-on-merge job does, no write-back). */
async function published(r, fake, slug, body = "First version of the article.") {
  const b = r.head(); r.newPost(slug, `Title ${slug}`, body); r.commit(`new ${slug}`);
  const p = await r.cmd("publish", slug, "--base-ref", b);
  assert.equal(p.code, 0, p.raw);
  assert.equal(fake.find(slug).status, "published");
  assert.doesNotMatch(readFileSync(r.file(slug), "utf8"), /\nid:/);
  return fake.find(slug).id;
}

test("an id-less file updates the post it published: refresh preview, merge publishes, next edit publishes", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "new-article");
  // Refresh PR: preview gets a link.
  const b = r.head(); r.git("checkout", "-qb", "refresh");
  r.edit("new-article", (p) => { p.body = p.body.replace("First version", "Refreshed version"); }); r.commit("refresh");
  const d = await r.cmd("draft", "new-article", "--base-ref", b);
  assert.equal(d.code, 0, d.raw);
  assert.ok(d.report.previewUrl, "preview link");
  assert.ok(d.report.calls.length);
  // Merge: publish.
  r.git("checkout", "-q", "main"); r.git("merge", "-q", "--ff-only", "refresh");
  const p = await r.cmd("publish", "new-article", "--base-ref", b);
  assert.equal(p.code, 0, p.raw);
  assert.match(bodyText(fake.find("new-article")), /Refreshed version/);
  // Next edit.
  const b2 = r.head(); r.edit("new-article", (q) => { q.body = q.body.replace("Refreshed version", "Refreshed again"); }); r.commit("again");
  const p2 = await r.cmd("publish", "new-article", "--base-ref", b2);
  assert.equal(p2.code, 0, p2.raw);
  assert.match(bodyText(fake.find("new-article")), /Refreshed again/);
});

test("a retried publish of a new post that already landed is a no-op, not 'slug already used'", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "retry-me");
  const p = await r.cmd("publish", "retry-me", "--base-ref", "HEAD^1");
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.report.reason, "the CMS already matches the file");
});

test("an id-less file whose live post was edited in the admin is refused (slug-taken), nothing written", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "edited-live");
  fake.find("edited-live").data.title = "Changed in the admin";
  const b = r.head(); r.edit("edited-live", (p) => { p.body += "\nMore.\n"; }); r.commit("edit");
  const n = writes(fake).length;
  for (const cmd of ["draft", "publish"]) {
    const x = await r.cmd(cmd, "edited-live", "--base-ref", b);
    assert.equal(x.code, 3, x.raw);
    assert.equal(x.report.refusal, "slug-taken");
  }
  assert.equal(writes(fake).length, n);
  assert.equal(fake.find("edited-live").data.title, "Changed in the admin");
});

test("an id-less new file cannot take over a published post the mirror did not make (slug-taken)", async () => {
  const fake = site(); const r = await repo(fake);
  // Published in the admin after the export: no mirror file has ever stood for it.
  const api = (path, body) => fake.fetch(URL_ + path, { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify(body) });
  const made = await (await api("/_emdash/api/content/posts", { slug: "not-mirrored", status: "draft", data: { title: "Someone's post", content: [para("Their words.")] } })).json();
  await api(`/_emdash/api/content/posts/${made.data.item.id}/publish`, {});
  const b = r.head(); r.newPost("not-mirrored", "Mine now", "Other words."); r.commit("claim");
  const x = await r.cmd("publish", "not-mirrored", "--base-ref", b);
  assert.equal(x.code, 3, x.raw);
  assert.equal(x.report.refusal, "slug-taken");
  assert.equal(fake.find("not-mirrored").data.title, "Someone's post");
});

test("an id-less file is refused when another mirror file already stands for that post", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "twin");
  // A second file in the folder carrying the post's id (an export copy under another name).
  const t = readFileSync(r.file("twin"), "utf8").replace("---\n", `---\nid: ${JSON.stringify(fake.find("twin").id)}\n`).replace('"twin"', '"twin-copy"');
  writeFileSync(join(r.posts, "twin-copy.md"), t); r.commit("copy");
  const b = r.head(); r.edit("twin", (p) => { p.body += "\nMore.\n"; }); r.commit("edit");
  const x = await r.cmd("publish", "twin", "--base-ref", b);
  assert.equal(x.code, 3, x.raw);
  assert.match(x.report.error, /another mirror file/);
});

test("adding the id by hand: allowed when it equals the live post (no-op publish), refused when it does not", async () => {
  const fake = site(); const r = await repo(fake);
  const id = await published(r, fake, "with-id");
  const b = r.head();
  writeFileSync(r.file("with-id"), readFileSync(r.file("with-id"), "utf8").replace("---\n", `---\nid: ${JSON.stringify(id)}\n`)); r.commit("record id");
  const v = await run(["validate", "--dir", r.posts, "--files", r.file("with-id"), "--base-ref", b], fake);
  assert.equal(v.code, 0, v.raw);
  assert.ok(v.report.results[0].warnings.some((w) => /read-only id added/.test(w)));
  const p = await r.cmd("publish", "with-id", "--base-ref", b);
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.report.reason, "the CMS already matches the file");
  // And the next edit, now with the id, publishes.
  const b2 = r.head(); r.edit("with-id", (q) => { q.body += "\nAn edit after the id.\n"; }); r.commit("edit");
  const p2 = await r.cmd("publish", "with-id", "--base-ref", b2);
  assert.equal(p2.code, 0, p2.raw);
  assert.match(bodyText(fake.find("with-id")), /An edit after the id/);
  // Wrong id (another post's) on an id-less file: refused.
  await published(r, fake, "wrong-id");
  const b3 = r.head();
  writeFileSync(r.file("wrong-id"), readFileSync(r.file("wrong-id"), "utf8").replace("---\n", `---\nid: ${JSON.stringify(fake.find("alpha").id)}\n`)); r.commit("bad id");
  const n = writes(fake).length;
  const w = await r.cmd("publish", "wrong-id", "--base-ref", b3);
  assert.equal(w.code, 3, w.raw);
  assert.equal(w.report.refusal, "other-post");
  assert.equal(writes(fake).length, n);
});

test("a read-only key added with a value the CMS does not have is refused (read-only-mismatch)", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "ro-added");
  const b = r.head(); r.edit("ro-added", (p) => { p.meta.locale = "fr"; }); r.commit("bad locale");
  const x = await r.cmd("publish", "ro-added", "--base-ref", b);
  assert.equal(x.code, 3, x.raw);
  assert.equal(x.report.refusal, "read-only-mismatch");
  // A present key that changes (not added) stays an error in validate.
  const b2 = r.head(); r.git("reset", "-q", "--hard", "HEAD^1");
  r.edit("alpha", (p) => { p.meta.locale = "fr"; }); r.commit("change locale");
  const v = await run(["validate", "--dir", r.posts, "--files", r.file("alpha"), "--base-ref", "HEAD^1"], fake);
  assert.equal(v.code, 1, v.raw);
  assert.ok(b2);
});

test("an export after a new post realigns the file without a red run: validate ok, publish a no-op", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "exported-later");
  const b = r.head();
  const e = await run(["export", "--dir", r.posts], fake);
  assert.equal(e.code, 0, e.raw);
  r.commit("export");
  const v = await run(["validate", "--dir", r.posts, "--files", r.file("exported-later"), "--base-ref", b], fake);
  assert.equal(v.code, 0, v.raw);
  const n = writes(fake).length;
  const p = await r.cmd("publish", "exported-later", "--base-ref", b);
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.report.reason, "the CMS already matches the file");
  assert.equal(writes(fake).length, n, "no write");
});

test("file renamed in git history: only versions at this path count", async () => {
  const fake = site(); const r = await repo(fake);
  // Published from blog/moved.md, then the folder moved to posts/ with an edit in the same commit.
  mkdirSync(join(r.dir, "blog"));
  const b0 = r.head();
  writeFileSync(join(r.dir, "blog", "moved.md"), `---\ntitle: "Moved"\nslug: "moved"\n---\n\nOriginal words.\n`); r.commit("new in blog");
  const p = await run(["publish", "--file", join(r.dir, "blog", "moved.md"), "--settings", r.settings, "--base-ref", b0], fake);
  assert.equal(p.code, 0, p.raw);
  r.git("mv", "blog/moved.md", "posts/moved.md");
  r.edit("moved", (q) => { q.body = q.body.replace("Original", "Edited"); }); const mv = r.commit("move and edit");
  const x = await r.cmd("publish", "moved", "--base-ref", `${mv}^1`);
  assert.equal(x.code, 3, x.raw);
  assert.equal(x.report.refusal, "slug-taken", "the published version lives under blog/, not this path");
  assert.match(bodyText(fake.find("moved")), /Original/);
  // A pure rename keeps the content in the rename commit itself, so that version counts.
  r.git("reset", "-q", "--hard", `${mv}^1`);
  r.git("mv", "blog/moved.md", "posts/moved.md"); const mv2 = r.commit("pure move");
  const y = await r.cmd("publish", "moved", "--base-ref", `${mv2}^1`);
  assert.equal(y.code, 0, y.raw);
  assert.equal(y.report.reason, "the CMS already matches the file");
});

test("id-less Arabic new post: published, then refreshed by a later edit", async () => {
  const fake = site(); const r = await repo(fake, { slugPattern: AR_PATTERN });
  const slug = "مقال-جديد";
  await published(r, fake, slug, "النسخة الأولى من المقال.");
  const b = r.head(); r.edit(slug, (p) => { p.body = p.body.replace("الأولى", "المحدثة"); }); r.commit("refresh");
  const p = await r.cmd("publish", slug, "--base-ref", b);
  assert.equal(p.code, 0, p.raw);
  assert.match(bodyText(fake.find(slug)), /المحدثة/);
  assert.equal(p.report.claimedBySlug.id, fake.find(slug).id);
});

test('id-less refresh with "revisionsProven": false sends 0 requests', async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "gated");
  writeFileSync(r.settings, JSON.stringify({ collection: "posts", revisionsProven: false }));
  const b = r.head(); r.edit("gated", (p) => { p.body += "\nMore.\n"; }); r.commit("edit");
  const n = fake.log.length;
  for (const cmd of ["draft", "publish", "discard"]) {
    const x = await r.cmd(cmd, "gated", "--base-ref", b);
    assert.equal(x.code, 3, x.raw);
    assert.equal(x.report.refusal, "writes-off");
  }
  assert.equal(fake.log.length, n);
});

test("discard of an id-less file's closed refresh preview", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "idless-preview");
  const base = await previewed(r, "idless-preview", "First version", "Closed PR version");
  const d = await r.cmd("discard", "idless-preview", "--base-ref", base);
  assert.equal(d.code, 0, d.raw);
  assert.equal(pending(fake.find("idless-preview")), false);
  assert.match(bodyText(fake.find("idless-preview")), /First version/);
});

// ------------------------------------------------------------------------------------------------ review R10 fixes

const discardWith = (r, fake, slug, fetch, ...extra) => run(["discard", "--file", r.file(slug), "--settings", r.settings, ...extra], fake, { fetch });
/** A published post made in the admin (no mirror file has ever stood for it). */
async function adminPost(fake, slug, title, words) {
  const api = (path, body) => fake.fetch(URL_ + path, { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify(body) });
  const made = await (await api("/_emdash/api/content/posts", { slug, status: "draft", data: { title, content: [para(words)] } })).json();
  await api(`/_emdash/api/content/posts/${made.data.item.id}/publish`, {});
  return made.data.item.id;
}
/** What export would write for one post, as a "new article" file (slug, title and body only, no id). */
async function idlessCopyOf(r, fake, slug) {
  const d = join(r.dir, "export-scratch");
  await run(["export", "--dir", d], fake);
  const p = parseMirror(readFileSync(join(d, `${slug}.md`), "utf8"));
  execFileSync("rm", ["-rf", d]);
  return { meta: { slug: p.meta.slug, title: p.meta.title }, body: p.body };
}

test("R10 F1: an admin autosave (same draft revision id) between the check and the call is not discarded (draft-changed)", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "alpha", "Alpha words here.", "Alpha words, PR.");
  const rid = fake.find("alpha").draftRevisionId;
  let compared = false;
  const racing = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || "GET") === "GET" && compared && /\/content\/posts\/[^/]+$/.test(u.pathname)) { fake.adminAutosave("alpha", { data: { content: [para("Alpha words, PR. An editor is typing here.")] } }); compared = false; }
    if (u.pathname.endsWith("/compare")) compared = true;
    return fake.fetch(url, init);
  };
  const d = await discardWith(r, fake, "alpha", racing, "--base-ref", base);
  assert.equal(fake.find("alpha").draftRevisionId, rid, "the autosave kept the draft revision id");
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "draft-changed");
  assert.equal(discards(fake).length, 0);
  assert.ok(pending(fake.find("alpha")), "the editor's draft stays");
});

test("R10 F1: the stand-in's autosave keeps the draft revision id and changes _rev (as EmDash 0.1.0 does)", async () => {
  const fake = site(); const r = await repo(fake);
  await previewed(r, "alpha", "Alpha words here.", "Alpha words, PR.");
  const row = fake.find("alpha"); const rid = row.draftRevisionId;
  const get = async () => (await (await fake.fetch(`${URL_}/_emdash/api/content/posts/${row.id}`, { headers: { authorization: "Bearer x" } })).json()).data;
  const before = await get();
  await fake.fetch(`${URL_}/_emdash/api/content/posts/${row.id}`, { method: "PUT", headers: { authorization: "Bearer x" }, body: JSON.stringify({ data: { title: "Typing" }, skipRevision: true }) });
  const after = await get();
  assert.equal(after.item.draftRevisionId, rid);
  assert.notEqual(after._rev, before._rev);
  assert.equal(fake.revs.get(rid).data.title, "Typing");
});

test("R10 F2: discard refuses a post with a scheduled update (exit 3, scheduled); the draft and the schedule stay", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "alpha", "Alpha words here.", "Alpha words, scheduled.");
  fake.find("alpha").scheduledAt = "2027-01-01T09:00:00.000Z"; // a person scheduled the draft in the admin
  const d = await r.cmd("discard", "alpha", "--base-ref", base);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "scheduled");
  assert.equal(discards(fake).length, 0);
  assert.ok(pending(fake.find("alpha")));
  assert.equal(fake.find("alpha").scheduledAt, "2027-01-01T09:00:00.000Z");
});

test("R10 F4: a closed stale pull request on an id-less post with no draft exits 4 (no-draft), not 3", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "stale-pr");
  const prBase = r.head();
  r.git("checkout", "-qb", "pr-stale"); r.edit("stale-pr", (p) => { p.body = p.body.replace("First version", "Stale PR version"); });
  const prHead = r.commit("stale edit");
  r.git("checkout", "-q", "main"); const mb = r.head();
  r.edit("stale-pr", (p) => { p.body = p.body.replace("First version", "Second version"); }); r.commit("main edit");
  assert.equal((await r.cmd("publish", "stale-pr", "--base-ref", mb)).code, 0);
  r.git("checkout", "-q", prHead);
  const n = writes(fake).length;
  const d = await r.cmd("discard", "stale-pr", "--base-ref", prBase);
  r.git("checkout", "-q", "main");
  assert.equal(d.code, 4, d.raw);
  assert.equal(d.report.refusal, "no-draft");
  assert.equal(writes(fake).length, n);
});

test("R10 F5: discard removes only a draft equal to the closed pull request's head, not an older push of it", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "alpha", "Alpha words here.", "Alpha words, first push.");
  r.edit("alpha", (p) => { p.body = p.body.replace("first push", "second push"); }); r.commit("second push, no preview");
  const d = await r.cmd("discard", "alpha", "--base-ref", base);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "foreign-draft");
  assert.equal(discards(fake).length, 0);
  assert.ok(pending(fake.find("alpha")));
});

test("R10 F5: --keep-refs: closing a stacked pull request leaves the open parent's preview draft (exit 3, kept-ref)", async () => {
  const fake = site(); const r = await repo(fake);
  const base = await previewed(r, "beta", "Beta words here.", "Beta words, PR A.");
  const aHead = r.head();
  r.git("checkout", "-qb", "pr-b-stacked"); r.edit("alpha", (p) => { p.body = p.body.replace("Alpha words here.", "Alpha, PR B."); }); r.commit("B");
  const d = await r.cmd("discard", "beta", "--base-ref", base, "--keep-refs", aHead);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "kept-ref");
  assert.equal(discards(fake).length, 0);
  assert.ok(pending(fake.find("beta")), "A's preview stays");
  // A ref whose file differs from the draft does not block (B's own preview of a post A never touched).
  const e = await r.cmd("discard", "beta", "--base-ref", base, "--keep-refs", base);
  assert.equal(e.code, 0, e.raw);
});

test("R10 F6: a pull request whose first commit copies a live post the mirror never had cannot preview or publish its rewrite", async () => {
  const fake = site(); const r = await repo(fake);
  await adminPost(fake, "gamma", "Gamma (owner's post)", "Gamma owner words.");
  const main = r.head(); r.git("checkout", "-qb", "pr-gamma");
  const copy = await idlessCopyOf(r, fake, "gamma");
  writeFileSync(r.file("gamma"), stringifyMirror(copy.meta, copy.body)); r.commit("copy of the public page");
  writeFileSync(r.file("gamma"), stringifyMirror({ ...copy.meta, title: "Gamma (taken over)" }, "Replaced words.\n")); r.commit("rewrite");
  const n = writes(fake).length;
  const d = await r.cmd("draft", "gamma", "--base-ref", main);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "slug-taken");
  r.git("checkout", "-q", "main"); r.git("merge", "-q", "--no-ff", "-m", "Merge PR gamma", "pr-gamma");
  const p = await r.cmd("publish", "gamma", "--base-ref", main);
  assert.equal(p.code, 3, p.raw);
  assert.equal(p.report.refusal, "slug-taken");
  assert.equal(writes(fake).length, n, "nothing written");
  assert.equal(fake.find("gamma").data.title, "Gamma (owner's post)");
});

test("R10 F7: an exported file removed, then a different article added at the same name, cannot replace the old post", async () => {
  const fake = site(); const r = await repo(fake);
  r.git("rm", "-q", r.file("beta")); r.commit("drop beta from the mirror");
  const before = r.head();
  r.newPost("beta", "A brand new beta article", "Completely different article."); r.commit("new article beta");
  const n = writes(fake).length;
  const p = await r.cmd("publish", "beta", "--base-ref", before);
  assert.equal(p.code, 3, p.raw);
  assert.equal(p.report.refusal, "slug-taken");
  assert.equal(writes(fake).length, n);
  assert.equal(fake.find("beta").data.title, "Beta");
});

test("R10 F6/F7: an id-less update is high-risk and names the version that proved it (the previous version)", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "claimed");
  const b = r.head(); r.edit("claimed", (p) => { p.body += "\nMore.\n"; }); r.commit("edit");
  const p = await r.cmd("publish", "claimed", "--base-ref", b);
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.report.claimedBySlug.matched, "previous version");
  assert.ok(p.report.highRisk.some((h) => /found by its slug/.test(h)), JSON.stringify(p.report.highRisk));
});

test("R10 F8: a file that adds SEO keys for the first time is refused (live-changed) when the CMS has other SEO set; allowed when it has none", async () => {
  const fake = site(); const r = await repo(fake);
  const id = await published(r, fake, "seo-first");
  fake.seoRows.get(id).title = "Editor's SEO title"; fake.seoRows.get(id).description = "Editor's description";
  const addSeo = (p) => { Object.assign(p.meta, { seoTitle: "PR SEO title", seoDescription: null, seoImage: null, canonical: null, noIndex: false }); };
  const b = r.head(); r.edit("seo-first", addSeo); r.commit("add SEO");
  const n = writes(fake).length;
  const p = await r.cmd("publish", "seo-first", "--base-ref", b);
  assert.equal(p.code, 3, p.raw);
  assert.equal(p.report.refusal, "live-changed");
  assert.match(p.report.error, /SEO/);
  assert.equal(writes(fake).length, n);
  assert.equal(fake.seoRows.get(id).title, "Editor's SEO title");
  // The same edit on a post whose CMS SEO is empty sets it.
  const id2 = await published(r, fake, "seo-empty");
  const b2 = r.head(); r.edit("seo-empty", addSeo); r.commit("add SEO 2");
  const q = await r.cmd("publish", "seo-empty", "--base-ref", b2);
  assert.equal(q.code, 0, q.raw);
  assert.equal(fake.seoRows.get(id2).title, "PR SEO title");
});

test("R10 F9: removing every SEO key from a file that had them is invalid (it would not clear them in the CMS)", async () => {
  const fake = site(); const r = await repo(fake);
  const b = r.head();
  r.edit("alpha", (p) => { for (const k of ["seoTitle", "seoDescription", "seoImage", "canonical", "noIndex"]) delete p.meta[k]; }); r.commit("drop SEO keys");
  const v = await run(["validate", "--dir", r.posts, "--files", r.file("alpha"), "--base-ref", b], fake);
  assert.equal(v.code, 1, v.raw);
  assert.ok(v.report.results[0].errors.some((e) => /SEO keys removed/.test(e)), v.raw);
  const n = writes(fake).length;
  const p = await r.cmd("publish", "alpha", "--base-ref", b);
  assert.equal(p.code, 1, p.raw);
  assert.equal(writes(fake).length, n);
  assert.equal(fake.seoRows.get(fake.find("alpha").id).title, "Alpha SEO");
});

// ------------------------------------------------------------------------------------------------ review R8 round 2, item 1

// A publish run turns red on one file while another file's change (X1) still goes out, so the caller's published point
// (its --base-ref) stays behind. The next edit (X2) must not be refused as "changed outside the mirror".
test("R8r2 stuck point: a file with an id whose live post is a later version on the branch (published by a red run) is not drift", async () => {
  const fake = site(); const r = await repo(fake);
  const point = r.head();
  r.edit("alpha", (p) => { p.body = p.body.replace("Alpha words here.", "Alpha words (X1)."); }); const x1 = r.commit("X1");
  assert.equal((await r.cmd("publish", "alpha", "--base-ref", point)).code, 0, "X1 goes out; the caller's point stays");
  r.edit("alpha", (p) => { p.body = p.body.replace("(X1)", "(X1) (X2)"); }); r.commit("X2");
  const p = await r.cmd("publish", "alpha", "--base-ref", point);
  assert.equal(p.code, 0, p.raw);
  assert.match(bodyText(fake.find("alpha")), /\(X2\)/);
  assert.equal(p.report.liveMatchedVersion, x1);
});

test("R8r2 stuck point: an admin edit is still drift with the window (live equals no version on the branch)", async () => {
  const fake = site(); const r = await repo(fake);
  const point = r.head();
  r.edit("alpha", (p) => { p.body = p.body.replace("Alpha words here.", "Alpha words (X1)."); }); r.commit("X1");
  assert.equal((await r.cmd("publish", "alpha", "--base-ref", point)).code, 0);
  fake.find("alpha").data.title = "Alpha (edited in the CMS)";
  r.edit("alpha", (p) => { p.body = p.body.replace("(X1)", "(X1) (X2)"); }); r.commit("X2");
  const n = writes(fake).length;
  const p = await r.cmd("publish", "alpha", "--base-ref", point);
  assert.equal(p.code, 3, p.raw);
  assert.equal(p.report.refusal, "live-changed");
  assert.equal(writes(fake).length, n);
});

test("R8r2 stuck point: the window is first-parent only (a side branch's intermediate commit does not count) and starts at --base-ref", async () => {
  const fake = site(); const r = await repo(fake);
  const point = r.head();
  // A side branch: S1 then S2, merged with a merge commit; only S2's text is on main's first-parent history.
  r.git("checkout", "-qb", "side");
  r.edit("alpha", (p) => { p.body = p.body.replace("Alpha words here.", "Alpha side one."); }); r.commit("S1");
  r.edit("alpha", (p) => { p.body = p.body.replace("side one", "side two"); }); r.commit("S2");
  r.git("checkout", "-q", "main"); r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  fake.adminDraft("alpha", { data: { content: [para("Alpha side one.")] } }); // live becomes S1's text (not via the mirror)
  await fake.fetch(`${URL_}/_emdash/api/content/posts/${fake.find("alpha").id}/publish`, { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" });
  r.edit("alpha", (p) => { p.body = p.body.replace("side two", "side three"); }); r.commit("main edit");
  const p = await r.cmd("publish", "alpha", "--base-ref", point);
  assert.equal(p.code, 3, p.raw);
  assert.equal(p.report.refusal, "live-changed");
  // A version from before --base-ref does not count either: live back at the seed text, base after a later commit.
  const fake2 = site(); const r2 = await repo(fake2);
  r2.edit("alpha", (p2) => { p2.body = p2.body.replace("Alpha words here.", "Alpha words (Y1)."); }); const y1 = r2.commit("Y1 (never published)");
  r2.edit("alpha", (p2) => { p2.body = p2.body.replace("(Y1)", "(Y2)"); }); r2.commit("Y2");
  const q = await r2.cmd("publish", "alpha", "--base-ref", y1);
  assert.equal(q.code, 3, q.raw);
  assert.equal(q.report.refusal, "live-changed");
});

test("R8r2 stuck point: an id-less claim cannot use the wider window (only --base-ref's version or this version)", async () => {
  const fake = site(); const r = await repo(fake);
  await published(r, fake, "claim-window", "Version one of the article.");
  const point = r.head();
  r.edit("claim-window", (p) => { p.body = p.body.replace("Version one", "Version two"); }); r.commit("v2");
  const p1 = await r.cmd("publish", "claim-window", "--base-ref", point);
  assert.equal(p1.code, 0, p1.raw); // claimed by its previous version; the caller's point stays behind
  r.edit("claim-window", (p) => { p.body = p.body.replace("Version two", "Version three"); }); r.commit("v3");
  const n = writes(fake).length;
  const p2 = await r.cmd("publish", "claim-window", "--base-ref", point);
  assert.equal(p2.code, 3, p2.raw);
  assert.equal(p2.report.refusal, "slug-taken");
  assert.equal(writes(fake).length, n);
  assert.match(bodyText(fake.find("claim-window")), /Version two/);
});

// ------------------------------------------------------------------------------------------------ review R10 round 2 (the drift window)

const setBody = (r, slug, text) => r.edit(slug, (p) => { p.body = `${text}\n`; });
const liveText = (fake, slug) => bodyText(fake.find(slug));
async function adminPublish(fake, slug, text) {
  fake.adminDraft(slug, { data: { content: [para(text)] } });
  await fake.fetch(`${URL_}/_emdash/api/content/posts/${fake.find(slug).id}/publish`, { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" });
}
/** A stuck point P: v2 and v3 of beta are published with --base-ref P (the runs went red on other files). */
async function stuckPoint(r) {
  const P = r.head();
  setBody(r, "beta", "Beta v2."); const c2 = r.commit("beta v2");
  assert.equal((await r.cmd("publish", "beta", "--base-ref", P)).code, 0);
  setBody(r, "beta", "Beta v3."); const c3 = r.commit("beta v3");
  const p3 = await r.cmd("publish", "beta", "--base-ref", P);
  assert.equal(p3.code, 0, p3.raw);
  return { P, c2, c3, p3 };
}

test("R10r2 R1: the window accepts only the newest version before this one, and says so in highRisk", async () => {
  const fake = site(); const r = await repo(fake);
  const { c2, p3 } = await stuckPoint(r);
  assert.equal(p3.report.liveMatchedVersion, c2);
  assert.ok((p3.report.highRisk || []).some((h) => h.includes(c2.slice(0, 12)) && /--base-ref/.test(h)), JSON.stringify(p3.report.highRisk));
  assert.equal(liveText(fake, "beta"), "Beta v3.");
});

test("R10r2 R1: an admin rollback to an older version in the window is refused (live-older-version), not overwritten", async () => {
  const fake = site(); const r = await repo(fake);
  const { P, c2, c3 } = await stuckPoint(r);
  await adminPublish(fake, "beta", "Beta v2."); // a person rolls v3 back to v2 in the admin
  setBody(r, "beta", "Beta v3, plus v4."); r.commit("beta v4 on v3");
  const n = writes(fake).length;
  const p4 = await r.cmd("publish", "beta", "--base-ref", P);
  assert.equal(p4.code, 3, p4.raw);
  assert.equal(p4.report.refusal, "live-older-version");
  assert.match(p4.report.error, new RegExp(`${c2.slice(0, 12)}.*${c3.slice(0, 12)}|${c3.slice(0, 12)}.*${c2.slice(0, 12)}`));
  assert.equal(writes(fake).length, n);
  assert.equal(liveText(fake, "beta"), "Beta v2.");
});

test("R10r2 R2: no window when --base-ref is not an ancestor of HEAD (rewritten history)", async () => {
  const fake = site(); const r = await repo(fake);
  const A = r.head();
  setBody(r, "beta", "Beta v2."); r.commit("v2"); assert.equal((await r.cmd("publish", "beta", "--base-ref", A)).code, 0);
  setBody(r, "beta", "Beta v3."); const C = r.commit("v3");
  assert.equal((await r.cmd("publish", "beta", "--base-ref", r.git("rev-parse", "HEAD~1"))).code, 0);
  r.git("reset", "-q", "--hard", A); // main force-pushed back; C is orphaned
  setBody(r, "beta", "Beta v2."); r.commit("v2 again (rewritten)");
  await adminPublish(fake, "beta", "Beta v2.");
  setBody(r, "beta", "Beta v2, new edit."); r.commit("new edit");
  const n = writes(fake).length;
  const p = await r.cmd("publish", "beta", "--base-ref", C);
  assert.equal(p.code, 3, p.raw);
  assert.equal(p.report.refusal, "live-changed");
  assert.equal(p.report.liveMatchedVersion, undefined);
  assert.equal(writes(fake).length, n);
});

test("R10r2 R3: cms draft (a preview) never uses the window: the pull request's own commits do not count", async () => {
  const fake = site(); const r = await repo(fake);
  const P = r.head();
  await adminPublish(fake, "beta", "Beta, admin edit.");
  r.git("checkout", "-qb", "pr-preview");
  setBody(r, "beta", "Beta, admin edit."); r.commit("copy the admin edit");
  setBody(r, "beta", "Something else entirely."); r.commit("rewrite");
  const n = writes(fake).length;
  const d = await r.cmd("draft", "beta", "--base-ref", P);
  assert.equal(d.code, 3, d.raw);
  assert.equal(d.report.refusal, "live-changed");
  assert.equal(writes(fake).length, n);
  const row = fake.find("beta");
  assert.ok(!row.draftRevisionId || row.draftRevisionId === row.liveRevisionId, "no draft saved");
});

test("R10r2 R6: a ref that looks like an option never reaches git as one", async () => {
  const { gitVersion, rangeVersionsOf } = await import("../src/cms/commands.mjs");
  const fake = site(); const r = await repo(fake);
  const out = join(r.dir, "pwned");
  assert.equal(gitVersion(r.file("beta"), `--output=${out}`), null);
  assert.deepEqual(rangeVersionsOf(r.file("beta"), `--output=${out}`), []);
  assert.deepEqual(rangeVersionsOf(r.file("beta"), `--output=${out}..`), []);
  let made = true; try { readFileSync(out); } catch { made = false; }
  let made2 = true; try { readFileSync(`${out}..HEAD`); } catch { made2 = false; }
  assert.equal(made || made2, false, "git wrote a file named by the ref");
});

// ------------------------------------------------------------------------------------------------ review R10 round 3

test("R10r3 R3-2 (X4): a file with no SEO keys whose newest commit adds them still matches the newest published version", async () => {
  const fake = site(); const r = await repo(fake);
  const res = await fake.fetch(`${URL_}/_emdash/api/content/posts`, { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ slug: "gamma", status: "draft", data: { title: "Gamma", content: [para("Gamma v0.")] } }) });
  const id = (await res.json()).data.item.id;
  await fake.fetch(`${URL_}/_emdash/api/content/posts/${id}/publish`, { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" });
  writeFileSync(r.file("gamma"), stringifyMirror({ id, slug: "gamma", title: "Gamma" }, "Gamma v0.\n")); const P = r.commit("gamma file, no SEO keys");
  setBody(r, "gamma", "Gamma v1."); r.commit("v1"); assert.equal((await r.cmd("publish", "gamma", "--base-ref", P)).code, 0);
  setBody(r, "gamma", "Gamma v2."); const c2 = r.commit("v2"); assert.equal((await r.cmd("publish", "gamma", "--base-ref", P)).code, 0);
  r.edit("gamma", (p) => { p.meta.seoTitle = "Gamma SEO title"; }); r.commit("v3: SEO keys only");
  const p3 = await r.cmd("publish", "gamma", "--base-ref", P);
  assert.equal(p3.code, 0, p3.raw);
  assert.equal(p3.report.liveMatchedVersion, c2);
  assert.equal(liveText(fake, "gamma"), "Gamma v2.");
});

test("R10r3 R3-1 (X1): live-older-version also fires for a version no run published; the message names both causes, both ways out, and what to check", async () => {
  const fake = site(); const r = await repo(fake);
  const P = r.head();
  setBody(r, "beta", "Beta v2."); const c2 = r.commit("beta v2");
  assert.equal((await r.cmd("publish", "beta", "--base-ref", P)).code, 0); // a red run on another file: P stays
  setBody(r, "beta", "Beta v3."); const c3 = r.commit("beta v3"); // its run never reached the CMS
  setBody(r, "beta", "Beta v4."); r.commit("beta v4");
  const n = writes(fake).length;
  const p4 = await r.cmd("publish", "beta", "--base-ref", P);
  assert.equal(p4.code, 3, p4.raw);
  assert.equal(p4.report.refusal, "live-older-version");
  const e = p4.report.error;
  assert.ok(e.includes(c2.slice(0, 12)) && e.includes(c3.slice(0, 12)), e);
  assert.match(e, /rolled (it )?back|rollback/i, "cause 1: a rollback in the admin");
  assert.match(e, /never published|not published|did not publish/i, "cause 2: a newer merged version that never published");
  assert.match(e, /compare the live post with the file at both commits/i, "check which case before exporting");
  assert.match(e, new RegExp(`--base-ref ${c2.slice(0, 12)}`), "way out A names the first commit");
  assert.match(e, /no other file is pending/i);
  assert.match(e, /publish .*in the CMS admin/i, "way out B");
  assert.doesNotMatch(e, /someone rolled it back in the CMS; export again before editing/, "the old, false-in-X1 wording is gone");
  assert.equal(writes(fake).length, n);
  // way out A as written works for this file, way out B too.
  assert.equal((await r.cmd("publish", "beta", "--base-ref", c2, "--dry")).code, 0);
  await adminPublish(fake, "beta", "Beta v3.");
  const viaAdmin = await r.cmd("publish", "beta", "--base-ref", P);
  assert.equal(viaAdmin.code, 0, viaAdmin.raw);
  assert.equal(liveText(fake, "beta"), "Beta v4.");
});
