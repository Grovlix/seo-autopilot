// Local images in mirror files (src/cms/media.mjs): uploaded to the CMS media library before the post is written, the
// body rewritten to the CMS media URLs, idempotent by content hash, fail closed. Against the in-memory EmDash 0.1.0
// stand-in (test/fixtures/fake-emdash.mjs, media routes included) and real local git repositories. Synthetic content only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { cms } from "../src/cms/commands.mjs";
import { contentHash, sniffType, mediaRefsOf, rewriteBody, unsafeRel } from "../src/cms/media.mjs";

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
const BODY = "Intro words for the guide.\n\n![Step one screen](/media/guide/01-one.jpg)\n\nMore words after the first screen.\n\n![Step two screen](/media/guide/02-two.jpg)\n\nThe end.";

async function guideRepo(fake, opts) {
  const r = await repo(fake, opts);
  r.image("guide/01-one.jpg", jpeg(1)); r.image("guide/02-two.jpg", jpeg(2));
  r.newPost("guide", "Guide", BODY);
  const base = r.head();
  return { r, base, head: r.commit("guide (#1)") };
}

// ------------------------------------------------------------------------------------------------ pure helpers

test("media helpers: content hash is EmDash's sha1: form; types by magic bytes; whole-line images only; unsafe paths named", () => {
  assert.equal(contentHash(Buffer.from("abc")), "sha1:a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(sniffType(jpeg(1)), "image/jpeg");
  assert.equal(sniffType(png(1)), "image/png");
  assert.equal(sniffType(Buffer.from("<svg xmlns='x'></svg>")), null);
  const r = mediaRefsOf("Prose about the /media/ folder stays prose.\n\n![a](/media/p/01-x.jpg)\n\n```\n![c](/media/p/in-code.jpg)\n```\n\n![b](https://cdn.example.test/media/x.png)\n", "/media/");
  assert.deepEqual(r, { images: ["/media/p/01-x.jpg"], stray: [] });
  for (const v of ["see [x](/media/p/y.jpg) here", "text ![i](/media/p/z.jpg) inline", "[r]: /media/p/q.jpg", "![u](/MEDIA/p/x.jpg)", "![e](%2Fmedia%2Fp%2Fx.jpg)"]) assert.ok(mediaRefsOf(`Words.\n\n${v}\n`, "/media/").stray.length > 0, v);
  for (const v of ["../x.jpg", "p/../x.jpg", ".hidden.jpg", "p/x.jpg?v=1", "p/x%2e.jpg", "p//x.jpg", "p/x.svg", "p/x"]) assert.ok(unsafeRel(v), v);
  assert.equal(unsafeRel("p/01-x.jpg"), null);
  assert.equal(rewriteBody("a\n\n![x](/media/p/1.jpg)\n\n```\n![x](/media/p/1.jpg)\n```", new Map([["/media/p/1.jpg", "/cms/1.jpg"]])), "a\n\n![x](/cms/1.jpg)\n\n```\n![x](/media/p/1.jpg)\n```");
});

// ------------------------------------------------------------------------------------------------ publish

test("publish: a new post with two local images uploads both, reads them back, and goes live with the CMS URLs; the file is unchanged", async () => {
  const fake = fakeEmDash();
  const { r, base } = await guideRepo(fake);
  const before = readFileSync(r.file("guide"), "utf8");
  const p = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.report.published, true);
  assert.equal(p.report.verified, true);
  assert.equal(p.report.mediaUploaded, 2);
  assert.equal(p.report.media.length, 2);
  assert.ok(p.report.media.every((m) => m.verified && m.cmsUrl.startsWith("/_emdash/api/media/file/") && m.hash.startsWith("sha1:")));
  assert.equal(uploads(fake).length, 2);
  const row = fake.find("guide");
  assert.equal(row.status, "published");
  assert.deepEqual(imageUrls(row), p.report.media.map((m) => m.cmsUrl));
  assert.deepEqual(row.data.content.filter((b) => b._type === "image").map((b) => b.alt), ["Step one screen", "Step two screen"]);
  assert.doesNotMatch(JSON.stringify(row.data), /\/media\/guide\//, "no local path in the CMS body");
  // Each CMS URL serves exactly the local bytes.
  for (const [i, u] of imageUrls(row).entries()) assert.ok(fake.files.get(u.split("/").pop()).buf.equals(jpeg(i + 1)));
  // Uploads happen before any post write.
  const firstContentWrite = fake.log.findIndex((l) => l.method !== "GET" && l.path.startsWith("/_emdash/api/content"));
  assert.ok(fake.log.findLastIndex((l) => l.method === "POST" && l.path === "/_emdash/api/media") < firstContentWrite);
  assert.equal(readFileSync(r.file("guide"), "utf8"), before, "the mirror file keeps its local paths");
});

test("publish, run twice: the second run uploads nothing and writes nothing (same bytes, same post)", async () => {
  const fake = fakeEmDash();
  const { r, base } = await guideRepo(fake);
  assert.equal((await r.cmd("publish", "guide", "--base-ref", base)).code, 0);
  const n = fake.log.length;
  const again = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(again.code, 0, again.raw);
  assert.equal(again.report.published, false);
  assert.equal(again.report.mediaUploaded, 0);
  assert.equal(again.report.mediaReused, 2);
  assert.deepEqual(fake.log.slice(n).filter((l) => l.method !== "GET"), [], "only reads on the second run");
  assert.equal(fake.media.length, 2);
});

test("publish: one image fails to upload: exit 1, the post is not created; the retry re-uses the uploaded image and publishes (no duplicate)", async () => {
  const fake = fakeEmDash();
  const { r, base } = await guideRepo(fake);
  fake.mediaFail.fn = (name) => (name === "02-two.jpg" ? 500 : 0);
  const p = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(p.code, 1, p.raw);
  assert.equal(p.report.refusal, "media-upload-failed");
  assert.match(p.report.error, /uploading \/media\/guide\/02-two\.jpg failed .*The post was not written/);
  assert.deepEqual(contentWrites(fake), [], "no post request");
  assert.equal(fake.find("guide"), undefined);
  assert.equal(fake.media.length, 1, "the first image is in the library");
  fake.mediaFail.fn = null;
  const retry = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(retry.code, 0, retry.raw);
  assert.equal(retry.report.mediaUploaded, 1);
  assert.equal(retry.report.mediaReused, 1);
  assert.equal(fake.media.length, 2, "no second item for the same bytes");
  assert.equal(fake.find("guide").status, "published");
});

test("publish: the CMS answers a read-back with other bytes: exit 1, nothing is written to the post", async () => {
  const fake = fakeEmDash();
  const { r, base } = await guideRepo(fake);
  const fetch = async (url, init) => {
    const res = await fake.fetch(url, init);
    return String(url).includes("/_emdash/api/media/file/") ? new Response(Buffer.from("not the image"), { status: 200 }) : res;
  };
  const q = await run(["publish", "--file", r.file("guide"), "--settings", r.settings, "--base-ref", base], fake, { fetch });
  assert.equal(q.code, 1, q.raw);
  assert.equal(q.report.refusal, "media-readback-failed");
  assert.deepEqual(contentWrites(fake), []);
});

test("publish: an image already in the library (same bytes) is reused, not uploaded; the same file twice in one post is one image", async () => {
  const fake = fakeEmDash({ media: [{ filename: "old-name.jpg", type: "image/jpeg", bytes: jpeg(1) }] });
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Words first.\n\n![One](/media/guide/01-one.jpg)\n\nMiddle words.\n\n![One again](/media/guide/01-one.jpg)");
  const base = r.head(); r.commit("guide (#1)");
  const p = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(p.code, 0, p.raw);
  assert.equal(uploads(fake).length, 0);
  assert.equal(p.report.media.length, 1);
  assert.equal(p.report.media[0].reused, true);
  const urls = imageUrls(fake.find("guide"));
  assert.equal(urls.length, 2);
  assert.equal(urls[0], urls[1]);
  assert.equal(urls[0], `/_emdash/api/media/file/${fake.media[0].storageKey}`);
});

test("publish: the media library is read across pages before deciding an image is new", async () => {
  const seed = Array.from({ length: 7 }, (_, i) => ({ filename: `x${i}.jpg`, type: "image/jpeg", bytes: jpeg(100 + i) }));
  const fake = fakeEmDash({ mediaPage: 3, media: [...seed, { filename: "one.jpg", type: "image/jpeg", bytes: jpeg(1) }] });
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("guide", "Guide", "Words.\n\n![One](/media/guide/01-one.jpg)");
  const base = r.head(); r.commit("guide (#1)");
  const p = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(p.code, 0, p.raw);
  assert.equal(uploads(fake).length, 0);
  assert.equal(fake.log.filter((l) => l.method === "GET" && l.path.startsWith("/_emdash/api/media?")).length, 3);
});

test("publish, later edits: a text edit keeps the images (no upload, the slug claim still holds); removing an image publishes without it", async () => {
  const fake = fakeEmDash();
  const { r, base } = await guideRepo(fake);
  assert.equal((await r.cmd("publish", "guide", "--base-ref", base)).code, 0);
  const b1 = r.head();
  writeFileSync(r.file("guide"), readFileSync(r.file("guide"), "utf8").replace("The end.", "The end, edited."));
  r.commit("edit (#2)");
  const n = uploads(fake).length;
  const e = await r.cmd("publish", "guide", "--base-ref", b1);
  assert.equal(e.code, 0, e.raw);
  assert.equal(e.report.published, true);
  assert.equal(uploads(fake).length, n);
  assert.equal(e.report.claimedBySlug.matched, "previous version");
  const b2 = r.head();
  writeFileSync(r.file("guide"), readFileSync(r.file("guide"), "utf8").replace("![Step two screen](/media/guide/02-two.jpg)\n\n", ""));
  r.commit("drop image (#3)");
  const d = await r.cmd("publish", "guide", "--base-ref", b2);
  assert.equal(d.code, 0, d.raw);
  assert.equal(imageUrls(fake.find("guide")).length, 1);
});

test("publish: an image whose bytes changed under the same name is uploaded as a new item and the post points at it", async () => {
  const fake = fakeEmDash();
  const { r, base } = await guideRepo(fake);
  assert.equal((await r.cmd("publish", "guide", "--base-ref", base)).code, 0);
  const b1 = r.head();
  r.image("guide/02-two.jpg", jpeg(9));
  r.commit("new screen (#2)");
  const p = await r.cmd("publish", "guide", "--base-ref", b1);
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.report.mediaUploaded, 1);
  assert.ok(fake.files.get(imageUrls(fake.find("guide"))[1].split("/").pop()).buf.equals(jpeg(9)));
});

// ------------------------------------------------------------------------------------------------ fail closed, before any request

test("publish: a bad local image refuses the post before ANY request (path, missing, link, type, size, stray reference, count)", async () => {
  const cases = [
    ["traversal", "![x](/media/../cms.json)", null, "media-path"],
    ["missing", "![x](/media/guide/09-none.jpg)", null, "media-missing"],
    ["wrong bytes", "![x](/media/guide/01-one.jpg)", (r) => r.image("guide/01-one.jpg", Buffer.from("<html>not an image</html>")), "media-type"],
    ["png named jpg", "![x](/media/guide/01-one.jpg)", (r) => r.image("guide/01-one.jpg", png(1)), "media-type"],
    ["too large", "![x](/media/guide/01-one.jpg)", (r) => r.image("guide/01-one.jpg", jpeg(1, 200)), "media-too-large", { mediaMaxBytes: 100 }],
    ["symbolic link", "![x](/media/guide/01-one.jpg)", (r) => { mkdirSync(join(r.dir, "media/guide"), { recursive: true }); symlinkSync(join(r.dir, "cms.json"), join(r.dir, "media/guide/01-one.jpg")); }, "media-path"],
    ["inline", "Words ![x](/media/guide/01-one.jpg) inline.", (r) => r.image("guide/01-one.jpg", jpeg(1)), "media-ref-form"],
    ["link", "See [the screen](/media/guide/01-one.jpg).", (r) => r.image("guide/01-one.jpg", jpeg(1)), "media-ref-form"],
    ["too many", "![a](/media/guide/01-one.jpg)\n\n![b](/media/guide/02-two.jpg)", (r) => { r.image("guide/01-one.jpg", jpeg(1)); r.image("guide/02-two.jpg", jpeg(2)); }, "media-too-many", { mediaMaxImages: 1 }],
  ];
  for (const [name, body, setup, refusal, extra] of cases) {
    const fake = fakeEmDash();
    const r = await repo(fake, { settings: extra || {} });
    setup?.(r);
    r.newPost("guide", "Guide", `Words first.\n\n${body}`);
    const base = r.head(); r.commit("guide (#1)");
    const p = await r.cmd("publish", "guide", "--base-ref", base);
    assert.equal(p.code, 3, `${name}: ${p.raw}`);
    assert.equal(p.report.refusal, refusal, name);
    assert.equal(p.report.refused, true, name);
    assert.deepEqual(fake.log, [], `${name}: no request at all`);
  }
});

test("publish: writes off (revisionsProven false) refuses before any media request", async () => {
  const fake = fakeEmDash();
  const { r, base } = await guideRepo(fake, { proven: false });
  const p = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(p.code, 3);
  assert.equal(p.report.refusal, "writes-off");
  assert.deepEqual(fake.log, []);
});

test("publish: a token without the media scopes stops the post (exit 1, media-list-failed), no post request", async () => {
  const fake = fakeEmDash({ mediaScope: false });
  const { r, base } = await guideRepo(fake);
  const p = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(p.code, 1, p.raw);
  assert.equal(p.report.refusal, "media-list-failed");
  assert.match(p.report.error, /media:read and media:write/);
  assert.deepEqual(contentWrites(fake), []);
});

test("publish --dry: nothing is uploaded; the report says which images would be", async () => {
  const fake = fakeEmDash({ media: [{ filename: "a.jpg", type: "image/jpeg", bytes: jpeg(1) }] });
  const { r, base } = await guideRepo(fake);
  const p = await r.cmd("publish", "guide", "--base-ref", base, "--dry");
  assert.equal(p.code, 0, p.raw);
  assert.deepEqual(writes(fake), []);
  assert.deepEqual(p.report.media.map((m) => [m.file, !!m.reused, !!m.wouldUpload]), [["guide/01-one.jpg", true, false], ["guide/02-two.jpg", false, true]]);
});

test("no media folder in the settings: local images are left alone, exactly as before (no media request)", async () => {
  const fake = fakeEmDash();
  const { r, base } = await guideRepo(fake, { media: false });
  const p = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.report.media, undefined);
  assert.deepEqual(fake.log.filter((l) => l.path.startsWith("/_emdash/api/media")), []);
  assert.deepEqual(imageUrls(fake.find("guide")), ["/media/guide/01-one.jpg", "/media/guide/02-two.jpg"]);
});

test("draft (preview) uploads the images too, so the preview shows them; a published post with images is untouched by it", async () => {
  const fake = fakeEmDash({ previewSecret: true });
  const { r, base } = await guideRepo(fake);
  const d = await r.cmd("draft", "guide", "--base-ref", base);
  assert.equal(d.code, 0, d.raw);
  assert.equal(d.report.mediaUploaded, 2);
  const row = fake.find("guide");
  assert.equal(row.status, "draft");
  assert.deepEqual(imageUrls(row), d.report.media.map((m) => m.cmsUrl));
});

// ------------------------------------------------------------------------------------------------ validate

test("validate: media problems are errors offline (missing file, stray reference); a good image passes; no media folder: no check", async () => {
  const fake = fakeEmDash();
  const r = await repo(fake);
  r.image("guide/01-one.jpg", jpeg(1));
  r.newPost("good", "Good", "Words.\n\n![One](/media/guide/01-one.jpg)");
  r.newPost("bad", "Bad", "Words.\n\n![Gone](/media/guide/02-gone.jpg)\n\nSee [x](/media/guide/01-one.jpg).");
  const v = await run(["validate", "--settings", r.settings, "--files", `${r.file("good")},${r.file("bad")}`], fake);
  assert.equal(v.code, 1, v.raw);
  const by = Object.fromEntries(v.report.results.map((x) => [x.file.split("/").pop(), x.errors]));
  assert.deepEqual(by["good.md"], []);
  assert.ok(by["bad.md"].some((e) => /02-gone\.jpg.*does not exist/.test(e)), by["bad.md"].join("; "));
  assert.ok(by["bad.md"].some((e) => /outside a whole-line image/.test(e)), by["bad.md"].join("; "));
  assert.deepEqual(fake.log, []);
  writeFileSync(r.settings, JSON.stringify({ collection: "posts", revisionsProven: true }));
  const off = await run(["validate", "--settings", r.settings, "--files", r.file("bad")], fake);
  assert.equal(off.code, 0, off.raw);
});
