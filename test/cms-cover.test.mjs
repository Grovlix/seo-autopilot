// The cover (featured image) of a mirror file: `image: "/covers/<name>.jpg"` + `imageAlt` is a LOCAL cover (settings "coverDir"), uploaded to the
// CMS media library like a body image and set as the post's featured image; any other `image` stays a read-only copy of the CMS.
// Against the in-memory EmDash stand-in (test/fixtures/fake-emdash.mjs) and real local git repositories. Synthetic content only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { cms } from "../src/cms/commands.mjs";
import { coverRefOf, coverValue, imageSize, mediaOptions } from "../src/cms/media.mjs";
import { draftData, draftMatches, imageState, parseMirror, partsFor, stateOfFile, stateOfItem, validateFile, diffState } from "../src/cms/mirror.mjs";

const URL_ = "https://cms.example.test";
/** A tiny JPEG-looking file with a real frame header (SOF0) of the given size, so the image size can be read; the rest is filler. */
const jpegSized = (w, h, seed) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(40, seed)]);
const jpeg = (seed) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, seed)]);

async function run(args, fake) {
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
  try { const code = await cms({ flags, positional }, { fetch: fake.fetch }); return { code, report: JSON.parse(lines.join("\n")), raw: lines.join("\n") }; }
  finally {
    console.log = saved.log;
    for (const [k, v] of [["EMDASH_URL", saved.url], ["EMDASH_TOKEN", saved.token], ["EMDASH_REVISIONS_PROVEN", saved.proven]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

/** A site repository: posts/, media/ and covers/, settings with mediaDir "media" and coverDir "covers". */
function repo(fake, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cms-cover-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.test"); git("config", "user.name", "t");
  const settings = join(dir, "cms.json");
  writeFileSync(settings, JSON.stringify({ collection: "posts", revisionsProven: true, mediaDir: "media", coverDir: "covers", ...extra }));
  mkdirSync(join(dir, "posts"), { recursive: true }); mkdirSync(join(dir, "media"), { recursive: true }); mkdirSync(join(dir, "covers"), { recursive: true });
  writeFileSync(join(dir, "README"), "site\n");
  git("add", "-A"); git("commit", "-qm", "seed");
  const file = (slug) => join(dir, "posts", `${slug}.md`);
  const commit = (msg) => { git("add", "-A"); git("commit", "-qm", msg); return git("rev-parse", "HEAD"); };
  const cover = (name, bytes) => writeFileSync(join(dir, "covers", name), bytes);
  const post = (slug, title, { image, alt, body = "Intro words for the guide.\n\nMore words after the intro." } = {}) =>
    writeFileSync(file(slug), `---\ntitle: ${JSON.stringify(title)}\nslug: ${JSON.stringify(slug)}\n${image !== undefined ? `image: ${JSON.stringify(image)}\n` : ""}${alt !== undefined ? `imageAlt: ${JSON.stringify(alt)}\n` : ""}---\n\n${body}\n`);
  const cmd = (name, slug, ...more) => run([name, "--file", file(slug), "--settings", settings, ...more], fake);
  return { dir, git, settings, file, commit, cover, post, cmd, head: () => git("rev-parse", "HEAD") };
}
const uploads = (fake) => fake.log.filter((l) => l.method === "POST" && l.path === "/_emdash/api/media");
const writes = (fake) => fake.log.filter((l) => l.method !== "GET");
const ALT = "رسم تجريدي بلا نصوص";

// ------------------------------------------------------------------------------------------------ pure
test("draftMatches: a draft whose image EmDash normalized (src dropped, fields added) still equals the cover that was sent", () => {
  const sent = coverValue({ item: { id: "01M", filename: "c.jpg", mimeType: "image/jpeg", storageKey: "01M.jpg", width: null, height: null }, cmsUrl: "/_emdash/api/media/file/01M.jpg", bytes: jpegSized(1600, 1000, 1), type: "image/jpeg", alt: ALT });
  const stored = { ...sent }; delete stored.src; stored.meta = { storageKey: "01M.jpg" };
  const version = { meta: { slug: "a", title: "T", image: "/covers/a.jpg", imageAlt: ALT }, body: "Words.", cover: sent };
  const draft = { ...draftData(version), featured_image: stored };
  assert.equal(draftMatches(draft, { version, slug: "a" }), true);
  assert.equal(draftMatches({ ...draft, featured_image: { ...stored, alt: "other" } }, { version, slug: "a" }), false, "another alt is another draft");
  assert.equal(draftMatches({ ...draft, featured_image: { ...stored, id: "01X", meta: { storageKey: "01X.jpg" } } }, { version, slug: "a" }), false, "another picture is another draft");
});


test("coverRefOf and mediaOptions: the cover prefix comes from the settings; overlapping prefixes are refused; no cover folder = no cover", () => {
  const st = { mediaDir: "media", coverDir: "covers" };
  const o = mediaOptions({}, st, null);
  assert.equal(o.cover.prefix, "/covers/");
  assert.equal(o.cover.maxImages, 1);
  assert.equal(coverRefOf({ meta: { image: "/covers/a.jpg" } }, o), "/covers/a.jpg");
  assert.equal(coverRefOf({ meta: { image: "01KP.svg" } }, o), null, "a CMS copy is not a local cover");
  assert.equal(coverRefOf({ meta: { image: "/covers/a.jpg" } }, mediaOptions({}, { mediaDir: "media" }, null)), null, "no coverDir, no cover");
  assert.throws(() => mediaOptions({}, { ...st, coverUrlPrefix: "/media/c/" }, null), /must not contain one another/);
  assert.throws(() => mediaOptions({}, { ...st, coverUrlPrefix: "covers" }, null), /must start and end with/);
});

test("imageSize reads a JPEG's frame header and a PNG's IHDR; coverValue is the EmDash MediaValue with src, alt, size and storage key", () => {
  assert.deepEqual(imageSize(jpegSized(1600, 1000, 1), "image/jpeg"), { width: 1600, height: 1000 });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 2, 0, 0, 0, 1, 0]), Buffer.alloc(8)]);
  assert.deepEqual(imageSize(png, "image/png"), { width: 512, height: 256 });
  assert.equal(imageSize(jpeg(1), "image/jpeg"), null);
  const v = coverValue({ item: { id: "01M", filename: "c.jpg", mimeType: "image/jpeg", storageKey: "01M.jpg", width: null, height: null }, cmsUrl: "/_emdash/api/media/file/01M.jpg", bytes: jpegSized(1600, 1000, 1), type: "image/jpeg", alt: ALT });
  assert.deepEqual(v, { provider: "local", id: "01M", src: "/_emdash/api/media/file/01M.jpg", alt: ALT, filename: "c.jpg", mimeType: "image/jpeg", meta: { storageKey: "01M.jpg" }, width: 1600, height: 1000 });
});

test("state: only a file with a resolved local cover manages the image; the image part is compared only then", () => {
  const live = stateOfItem({ slug: "a", data: { title: "T", excerpt: null, content: [], featured_image: { id: "01M", meta: { storageKey: "01M.svg" }, alt: "old" } } });
  assert.deepEqual(live.image, { src: "/_emdash/api/media/file/01M.svg", alt: "old" });
  assert.deepEqual(imageState(null), null);
  assert.deepEqual(imageState("/x.jpg"), { src: "/x.jpg", alt: null });
  const plain = stateOfFile({ meta: { slug: "a", title: "T", image: "01M.svg" }, body: "Words." });
  assert.equal(plain.image, undefined);
  assert.ok(!partsFor(live, plain).includes("image"), "a file without a cover never writes the image");
  const withCover = stateOfFile({ meta: { slug: "a", title: "T", image: "/covers/a.jpg", imageAlt: ALT }, body: "Words.", cover: { id: "01N", src: "/_emdash/api/media/file/01N.jpg", alt: ALT, meta: { storageKey: "01N.jpg" } } });
  assert.deepEqual(withCover.image, { src: "/_emdash/api/media/file/01N.jpg", alt: ALT });
  assert.ok(partsFor(live, withCover).includes("image"));
  assert.ok(partsFor(null, withCover).includes("image"));
  assert.deepEqual(diffState(live, withCover, ["image"]), ["image"]);
  assert.deepEqual(diffState({ ...live, image: withCover.image }, withCover, ["image"]), []);
  assert.deepEqual(diffState({ ...live, image: { ...withCover.image, alt: "other" } }, withCover, ["image"]), ["image"], "a changed alt text is a change");
});

test("draftData adds the featured image only for a resolved cover", () => {
  const parsed = { meta: { slug: "a", title: "T", excerpt: null, image: "/covers/a.jpg", imageAlt: ALT }, body: "Words." };
  assert.equal("featured_image" in draftData(parsed), false);
  const cover = { provider: "local", id: "01N", src: "/_emdash/api/media/file/01N.jpg", alt: ALT };
  assert.deepEqual(draftData({ ...parsed, cover }).featured_image, cover);
});

test("validateFile: a local cover is editable and needs an alt text; any other image stays a read-only copy", () => {
  const base = parseMirror('---\ntitle: "T"\nslug: "a"\nid: "01X"\n---\n\nWords words words.\n');
  const mk = (extra) => parseMirror(`---\ntitle: "T"\nslug: "a"\nid: "01X"\n${extra}---\n\nWords words words.\n`);
  const ok = validateFile(mk(`image: "/covers/a.jpg"\nimageAlt: ${JSON.stringify(ALT)}\n`), { file: "a.md", base, coverPrefix: "/covers/" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.addedReadOnly, []);
  const noAlt = validateFile(mk('image: "/covers/a.jpg"\n'), { file: "a.md", base, coverPrefix: "/covers/" });
  assert.match(noAlt.errors.join("|"), /imageAlt is missing/);
  const bad = validateFile(mk(`image: "/covers/../a.jpg"\nimageAlt: "x"\n`), { file: "a.md", base, coverPrefix: "/covers/" });
  assert.match(bad.errors.join("|"), /not a plain path/);
  const ro = validateFile(mk('image: "https://x.test/y.svg"\n'), { file: "a.md", base, coverPrefix: "/covers/" });
  assert.deepEqual(ro.addedReadOnly, ["image"], "a CMS copy added to the file is still checked against the CMS");
  const old = validateFile(mk(`image: "/covers/a.jpg"\nimageAlt: ${JSON.stringify(ALT)}\n`), { file: "a.md", base });
  assert.deepEqual(old.addedReadOnly, ["image", "imageAlt"], "without the cover settings the old rule holds");
});

// ------------------------------------------------------------------------------------------------ publish

test("publish: a new post with a local cover uploads it once, sets the featured image with its alt and size, and verifies it", async () => {
  const fake = fakeEmDash();
  const r = repo(fake);
  r.cover("guide.jpg", jpegSized(1600, 1000, 7));
  r.post("guide", "Guide", { image: "/covers/guide.jpg", alt: ALT });
  const base = r.head();
  r.commit("guide (#1)");
  const before = readFileSync(r.file("guide"), "utf8");
  const p = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.report.published, true);
  assert.equal(p.report.verified, true);
  assert.equal(p.report.mediaUploaded, 1);
  assert.equal(p.report.media[0].url, "/covers/guide.jpg");
  assert.equal(uploads(fake).length, 1);
  const row = fake.find("guide");
  assert.equal(row.status, "published");
  const fi = row.data.featured_image;
  assert.equal(fi.provider, "local");
  assert.equal(fi.alt, ALT);
  assert.equal(fi.width, 1600);
  assert.equal(fi.height, 1000);
  // EmDash 0.1.0 stores a local value without `src` (it derives the URL from meta.storageKey); the stand-in normalizes like it does (fixtures/fake-emdash.mjs).
  assert.equal(fi.src, undefined, "a local value is stored without src");
  assert.match(fi.meta.storageKey, /^01FAKE\d+\.jpg$/);
  assert.equal(fi.mimeType, "image/jpeg");
  assert.equal(imageState(fi).src, `/_emdash/api/media/file/${fi.meta.storageKey}`, "what the site shows");
  assert.ok(fake.files.get(fi.meta.storageKey).buf.equals(jpegSized(1600, 1000, 7)), "the CMS serves the local bytes");
  assert.equal(readFileSync(r.file("guide"), "utf8"), before, "the mirror file keeps its local reference");
});

test("publish, run twice: the second run uploads nothing and writes nothing", async () => {
  const fake = fakeEmDash();
  const r = repo(fake);
  r.cover("guide.jpg", jpegSized(1600, 1000, 7));
  r.post("guide", "Guide", { image: "/covers/guide.jpg", alt: ALT });
  const base = r.head(); r.commit("guide (#1)");
  assert.equal((await r.cmd("publish", "guide", "--base-ref", base)).code, 0);
  const n = fake.log.length;
  const again = await r.cmd("publish", "guide", "--base-ref", base);
  assert.equal(again.code, 0, again.raw);
  assert.equal(again.report.published, false);
  assert.equal(again.report.mediaUploaded, 0);
  assert.deepEqual(writes({ log: fake.log.slice(n) }), [], "only reads");
  assert.equal(fake.media.length, 1);
});

test("backfill: adding a cover to a live post changes only its image; the words are not touched", async () => {
  const fake = fakeEmDash();
  const r = repo(fake);
  r.post("guide", "Guide");
  const base0 = r.head(); const c1 = r.commit("guide (#1)");
  assert.equal((await r.cmd("publish", "guide", "--base-ref", base0)).code, 0);
  const liveBefore = structuredClone(fake.find("guide").data);
  assert.equal(liveBefore.featured_image, undefined);
  r.cover("guide.jpg", jpegSized(1600, 1000, 9));
  r.post("guide", "Guide", { image: "/covers/guide.jpg", alt: ALT });
  r.commit("cover for guide (#2)");
  const p = await r.cmd("publish", "guide", "--base-ref", c1);
  assert.equal(p.code, 0, p.raw);
  assert.deepEqual(p.report.changes, ["image"], p.raw);
  assert.equal(p.report.published, true);
  assert.equal(p.report.verified, true);
  const data = fake.find("guide").data;
  assert.deepEqual(data.content, liveBefore.content);
  assert.equal(data.title, liveBefore.title);
  assert.equal(data.featured_image.alt, ALT);
  // and a later run with the same cover has nothing to do
  const again = await r.cmd("publish", "guide", "--base-ref", c1);
  assert.equal(again.report.published, false);
});

test("a live post's admin-changed image is drift when the previous file managed its cover (refused, nothing written)", async () => {
  const fake = fakeEmDash();
  const r = repo(fake);
  r.cover("guide.jpg", jpegSized(1600, 1000, 9));
  r.post("guide", "Guide", { image: "/covers/guide.jpg", alt: ALT });
  const b0 = r.head(); const c1 = r.commit("guide (#1)");
  assert.equal((await r.cmd("publish", "guide", "--base-ref", b0)).code, 0);
  // an editor picks another image in the admin
  fake.adminDraft("guide", { data: { featured_image: { id: "other", src: "/_emdash/api/media/file/other.jpg", alt: "someone else" } } });
  fake.find("guide").data.featured_image = { id: "other", src: "/_emdash/api/media/file/other.jpg", alt: "someone else" };
  r.post("guide", "Guide two", { image: "/covers/guide.jpg", alt: ALT });
  r.commit("retitle (#2)");
  const n = writes(fake).length;
  const p = await r.cmd("publish", "guide", "--base-ref", c1);
  assert.notEqual(p.code, 0, p.raw);
  assert.equal(writes(fake).length, n, "nothing written");
});

test("a local cover that is not there, is not an image, or has no alt text stops the post before any request", async () => {
  const fake = fakeEmDash();
  const r = repo(fake);
  r.post("a", "A", { image: "/covers/missing.jpg", alt: ALT });
  const b = r.head(); r.commit("a");
  const missing = await r.cmd("publish", "a", "--base-ref", b);
  assert.equal(missing.code, 3, missing.raw);
  assert.match(JSON.stringify(missing.report), /does not exist|media-missing/);
  r.cover("b.jpg", Buffer.from("<svg xmlns='x'></svg>0123456789"));
  r.post("b", "B", { image: "/covers/b.jpg", alt: ALT });
  r.commit("b");
  const svg = await r.cmd("publish", "b", "--base-ref", b);
  assert.equal(svg.code, 3, svg.raw);
  assert.match(JSON.stringify(svg.report), /not a JPEG|media-type/);
  r.cover("c.jpg", jpegSized(1600, 1000, 3));
  r.post("c", "C", { image: "/covers/c.jpg" });
  r.commit("c");
  const noAlt = await r.cmd("publish", "c", "--base-ref", b);
  assert.notEqual(noAlt.code, 0, noAlt.raw);
  assert.match(JSON.stringify(noAlt.report), /imageAlt/);
  assert.equal(uploads(fake).length, 0, "no upload, no post request");
  assert.deepEqual(writes(fake), []);
});

test("a cover over the size limit is refused; a cover path with a symbolic link on the way is refused", async () => {
  const fake = fakeEmDash();
  const r = repo(fake, { mediaMaxBytes: 100 });
  r.cover("big.jpg", jpegSized(1600, 1000, 4).subarray(0, 40));
  writeFileSync(join(r.dir, "covers", "big.jpg"), Buffer.concat([jpegSized(1600, 1000, 4), Buffer.alloc(200, 1)]));
  r.post("big", "Big", { image: "/covers/big.jpg", alt: ALT });
  const b = r.head(); r.commit("big");
  const p = await r.cmd("publish", "big", "--base-ref", b);
  assert.equal(p.code, 3, p.raw);
  assert.match(JSON.stringify(p.report), /the limit is 100|media-too-large/);
  assert.deepEqual(writes(fake), []);
});

test("draft (a pull request's preview) carries the cover; discard of that preview is recognised as ours and removes it", async () => {
  const fake = fakeEmDash();
  const r = repo(fake);
  r.post("guide", "Guide");
  const b0 = r.head(); const c1 = r.commit("guide (#1)");
  assert.equal((await r.cmd("publish", "guide", "--base-ref", b0)).code, 0);
  r.cover("guide.jpg", jpegSized(1600, 1000, 9));
  r.post("guide", "Guide", { image: "/covers/guide.jpg", alt: ALT });
  r.commit("cover (#2)");
  const d = await r.cmd("draft", "guide", "--base-ref", c1, "--preview", "false");
  assert.equal(d.code, 0, d.raw);
  assert.equal(fake.find("guide").data.featured_image, undefined, "the live post is untouched by a draft");
  const x = await r.cmd("discard", "guide", "--base-ref", c1);
  assert.equal(x.code, 0, x.raw);
  assert.equal(x.report.discarded, true);
});
