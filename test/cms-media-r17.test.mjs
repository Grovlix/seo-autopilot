// Regression tests from the R17 review of the local image upload (src/cms/media.mjs): path attacks, paging, a list
// without hashes, a read-back with other bytes, a stable pick among items with the same bytes (L1), and the read-only
// `cms media-refs` command a caller uses to compare its own image list with the fork's (one parser, M1). Against the
// in-memory EmDash 0.1.0 stand-in and real local git repositories. Synthetic content only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { cms } from "../src/cms/commands.mjs";
import { mediaRefsOf } from "../src/cms/media.mjs";

const URL_ = "https://cms.example.test";
const para = (text, key = "p") => ({ _type: "block", _key: key, style: "normal", markDefs: [], children: [{ _type: "span", _key: key + "s", text, marks: [] }] });
/** A small synthetic JPEG-looking file (magic bytes FF D8 FF, then filler). */
const jpeg = (seed, size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, seed)]);
const png = (seed) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, seed)]);

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

/** A site repository: posts/ and media/, settings with revisionsProven and mediaDir "media", one commit per step. */
async function repo(fake, { proven = true, media = true, settings: extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cms-media-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.test"); git("config", "user.name", "t");
  const settings = join(dir, "cms.json");
  writeFileSync(settings, JSON.stringify({ collection: "posts", revisionsProven: proven, ...(media ? { mediaDir: "media" } : {}), ...extra }));
  const posts = join(dir, "posts");
  mkdirSync(posts, { recursive: true }); mkdirSync(join(dir, "media"), { recursive: true });
  writeFileSync(join(dir, "README"), "site\n");
  git("add", "-A"); git("commit", "-qm", "seed");
  const file = (slug) => join(posts, `${slug}.md`);
  const commit = (msg) => { git("add", "-A"); git("commit", "-qm", msg); return git("rev-parse", "HEAD"); };
  const image = (rel, bytes) => { const p = join(dir, "media", rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, bytes); return p; };
  const newPost = (slug, title, body) => writeFileSync(file(slug), `---\ntitle: ${JSON.stringify(title)}\nslug: ${JSON.stringify(slug)}\n---\n\n${body}\n`);
  const cmd = (name, slug, ...more) => run([name, "--file", file(slug), "--settings", settings, ...more], fake);
  return { dir, git, posts, settings, file, commit, image, newPost, cmd, head: () => git("rev-parse", "HEAD") };
}
const writes = (fake) => fake.log.filter((l) => l.method !== "GET");
const contentWrites = (fake) => writes(fake).filter((l) => l.path.startsWith("/_emdash/api/content"));
const uploads = (fake) => fake.log.filter((l) => l.method === "POST" && l.path === "/_emdash/api/media");
const imageUrls = (row) => row.data.content.filter((b) => b._type === "image").map((b) => b.asset.url);
const sl = symlinkSync;
const posted = (fake, slug) => [...fake.rows.values()].find((r) => r.slug === slug && !r.deletedAt);

test("R17-2 symlinks: a linked file or a linked folder inside mediaDir is refused before any request", async () => {
  const fake = fakeEmDash();
  const r = await repo(fake);
  const outside = join(r.dir, "secret.jpg"); writeFileSync(outside, jpeg(9));
  mkdirSync(join(r.dir, "media", "g"), { recursive: true });
  sl(outside, join(r.dir, "media", "g", "01-a.jpg"));
  sl(r.dir, join(r.dir, "media", "linked"));
  for (const url of ["/media/g/01-a.jpg", "/media/linked/secret.jpg"]) {
    r.newPost("s", "S", `Words.\n\n![x](${url})\n\nEnd.`);
    const base = r.head(); r.commit("s " + url);
    const out = await r.cmd("publish", "s", "--base-ref", base);
    assert.equal(out.code, 3, out.raw); assert.equal(out.report.refusal, "media-path", out.raw);
  }
  assert.equal(fake.log.length, 0, "no request at all");
});

test("R17-3 traversal forms are refused offline: .., %2e, backslash, query, fragment, double slash, dot segment", async () => {
  for (const url of ["/media/../secret.jpg", "/media/%2e%2e/secret.jpg", "/media/a\\b.jpg", "/media/a.jpg?x=1", "/media/a.jpg#f", "/media//a.jpg", "/media/./a.jpg", "/media/.hidden.jpg"]) {
    const fake = fakeEmDash();
    const r = await repo(fake);
    r.image("a.jpg", jpeg(1));
    r.newPost("s", "S", `Words.\n\n![x](${url})\n\nEnd.`);
    const base = r.head(); r.commit("s");
    const out = await r.cmd("publish", "s", "--base-ref", base);
    assert.equal(out.code, 3, url + " " + out.raw);
    assert.equal(fake.log.length, 0, url);
  }
});

test("R17-4 pagination: the matching item sits on page 3 of a 250-item library (pages of 100): reused, nothing uploaded", async () => {
  const seed = Array.from({ length: 249 }, (_, i) => ({ filename: `f${i}.jpg`, type: "image/jpeg", bytes: jpeg(100 + (i % 100), 64 + i) }));
  seed.push({ filename: "01-one.jpg", type: "image/jpeg", bytes: jpeg(1) });
  const fake = fakeEmDash({ media: seed, mediaPage: 100 });
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Intro.\n\n![x](/media/guide/01-one.jpg)\n\nEnd.");
  const base = r.head(); r.commit("g");
  const out = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(out.code, 0, out.raw);
  assert.equal(uploads(fake).length, 0);
  assert.equal(fake.log.filter((l) => l.path.startsWith("/_emdash/api/media?")).length, 3);
});

test("R17-5 a list without contentHash: the fork uploads, EmDash answers deduplicated, the post uses the existing item", async () => {
  const fake = fakeEmDash({ media: [{ filename: "x.jpg", type: "image/jpeg", bytes: jpeg(1) }] });
  const real = fake.fetch;
  const strip = async (u, init) => { const res = await real(u, init); if (String(u).includes("/_emdash/api/media?")) { const j = await res.json(); for (const it of j.data.items) delete it.contentHash; return new Response(JSON.stringify(j), { status: res.status, headers: { "content-type": "application/json" } }); } return res; };
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Intro.\n\n![x](/media/guide/01-one.jpg)\n\nEnd.");
  const base = r.head(); r.commit("g");
  const out = await run(["publish", "--file", r.file("guide"), "--settings", r.settings, "--base-ref", base], fake, { fetch: strip });
  assert.equal(out.code, 0, out.raw);
  assert.equal(fake.media.length, 1, "no duplicate item");
  assert.equal(out.report.media[0].deduplicated, true);
});

test("R17-6 read-back serves other bytes: refused, no content write", async () => {
  const fake = fakeEmDash();
  const real = fake.fetch;
  const tamper = async (u, init) => { const res = await real(u, init); if (String(u).includes("/media/file/")) return new Response(Buffer.from("not the image"), { status: 200 }); return res; };
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Intro.\n\n![x](/media/guide/01-one.jpg)\n\nEnd.");
  const base = r.head(); r.commit("g");
  const out = await run(["publish", "--file", r.file("guide"), "--settings", r.settings, "--base-ref", base], fake, { fetch: tamper });
  assert.equal(out.code, 1, out.raw); assert.equal(out.report.refusal, "media-readback-failed");
  assert.equal(contentWrites(fake).length, 0);
});


test("R17-7 (L1) a second ready item with the same bytes, listed first: the re-run keeps the URL the live post uses (green, no write)", async () => {
  const fake = fakeEmDash();
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Intro.\n\n![x](/media/guide/01-one.jpg)\n\nEnd.");
  const base = r.head(); const head = r.commit("g");
  const first = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(first.code, 0, first.raw);
  const url1 = imageUrls(posted(fake, "guide"))[0];
  const dup = { ...fake.media[0], id: "01DUP", storageKey: "01DUP.jpg", createdAt: "2027-01-01T00:00:00Z" };
  fake.media.unshift(dup); fake.files.set("01DUP.jpg", fake.files.get(fake.media[1].storageKey));
  const before = contentWrites(fake).length;
  const again = await r.cmd("publish", "guide", "--base-ref", head);
  assert.equal(again.code, 0, again.raw);
  assert.equal(again.report.media[0].cmsUrl, url1);
  assert.equal(contentWrites(fake).length, before);
  assert.equal(uploads(fake).length, 1);
});

test("L1: with no live post to follow, the OLDEST item with the same bytes is used (EmDash lists newest first)", async () => {
  const fake = fakeEmDash({ media: [{ filename: "old.jpg", type: "image/jpeg", bytes: jpeg(1) }] });
  const old = fake.media[0];
  fake.media.unshift({ ...old, id: "01NEWER", storageKey: "01NEWER.jpg", createdAt: "2027-06-01T00:00:00Z" });
  fake.files.set("01NEWER.jpg", fake.files.get(old.storageKey));
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Intro.\n\n![x](/media/guide/01-one.jpg)\n\nEnd.");
  const base = r.head(); r.commit("g");
  const out = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(out.code, 0, out.raw);
  assert.equal(out.report.media[0].cmsUrl, `/_emdash/api/media/file/${old.storageKey}`);
  assert.equal(uploads(fake).length, 0);
});

test("L1: the item the live post points at was deleted in the CMS: the next edit uploads the bytes again but is refused (the previous version no longer maps to the live URL); nothing is written", async () => {
  const fake = fakeEmDash();
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Intro.\n\n![x](/media/guide/01-one.jpg)\n\nMore.");
  const base = r.head(); const h1 = r.commit("g");
  assert.equal((await r.cmd("publish", "guide", "--base-ref", base)).code, 0);
  const url1 = imageUrls(posted(fake, "guide"))[0];
  fake.media.splice(0, 1);
  r.newPost("guide", "Guide", "Intro.\n\n![x](/media/guide/01-one.jpg)\n\nMore words.");
  r.commit("edit");
  const before = contentWrites(fake).length;
  const out = await r.cmd("publish", "guide", "--base-ref", h1);
  assert.equal(out.code, 3, out.raw); assert.equal(out.report.refusal, "slug-taken");
  assert.equal(uploads(fake).length, 2, "uploaded again (stays in the library, reused next time)");
  assert.equal(contentWrites(fake).length, before, "no content write: never a guess");
  assert.equal(imageUrls(posted(fake, "guide"))[0], url1);
});

test("media-refs (M1): read-only, no request; lists whole-line images under the prefix exactly as publish reads them, escaped brackets in the alt included", async () => {
  const fake = fakeEmDash();
  const r = await repo(fake);
  r.newPost("guide", "Guide", "Intro.\n\n![a\\]b](/media/other-post/99-x.png)\n\n![ok](/media/guide/01-one.jpg)\n\nSee [x](/media/guide/02.jpg) here.");
  const out = await run(["media-refs", "--file", r.file("guide"), "--settings", r.settings], fake);
  assert.equal(out.code, 0, out.raw);
  assert.deepEqual(out.report.images, ["/media/other-post/99-x.png", "/media/guide/01-one.jpg"]);
  assert.equal(out.report.stray.length, 1);
  assert.equal(out.report.prefix, "/media/");
  assert.equal(fake.log.length, 0);
  // the same list as the upload path: mediaRefsOf
  assert.deepEqual(out.report.images, mediaRefsOf(readFileSync(r.file("guide"), "utf8").split("---\n").slice(2).join("---\n"), "/media/").images);
  // without mediaDir in the settings it still reports (default prefix): a caller can refuse images that would not upload
  const r2 = await repo(fake, { media: false });
  r2.newPost("p", "P", "Words.\n\n![x](/media/p/01-a.jpg)\n");
  const out2 = await run(["media-refs", "--file", r2.file("p"), "--settings", r2.settings], fake);
  assert.deepEqual(out2.report.images, ["/media/p/01-a.jpg"]);
});

test("R17-8 (documented): EmDash 0.1.0 unpublish keeps publishedAt; a later publish of the id-less file is refused slug-taken (the rollback is undone in the admin first)", async () => {
  const fake = fakeEmDash();
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Intro.\n\n![x](/media/guide/01-one.jpg)\n\nEnd.");
  const base = r.head(); const head = r.commit("g");
  assert.equal((await r.cmd("publish", "guide", "--base-ref", base)).code, 0);
  const row = posted(fake, "guide"); row.status = "draft"; row.liveRevisionId = null;
  const again = await r.cmd("publish", "guide", "--base-ref", head);
  assert.equal(again.code, 3); assert.equal(again.report.refusal, "slug-taken");
  assert.match(again.report.error, /already used by a draft post/);
});
