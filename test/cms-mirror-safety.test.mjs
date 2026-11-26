// Ways a publish could change the wrong live content (review R2), each against the EmDash 0.1.0 stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { cms } from "../src/cms/commands.mjs";
import { parseMirror, stringifyMirror, validateFile, draftData } from "../src/cms/mirror.mjs";
import { roundTrip } from "../src/cms/portable-text.mjs";
import { createClient } from "../src/cms/emdash.mjs";

const URL_ = "https://cms.example.test";
const para = (text, key = "p" + text.length) => ({ _type: "block", _key: key, style: "normal", markDefs: [], children: [{ _type: "span", _key: key + "s", text, marks: [] }] });

function site(extra = []) {
  return fakeEmDash({
    posts: [
      { slug: "first-post", data: { title: "First post", excerpt: "Short summary.", content: [para("Intro words for the first post.")], featured_image: { id: "m1", src: "/m1.jpg", alt: "A photo" } }, seo: { title: "First | Example", description: "About the first post." } },
      { slug: "third-post", data: { title: "Third post", content: [para("Third post body text here.")] } },
      ...extra,
    ],
  });
}

async function run(args, fake, env = {}) {
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
  Object.assign(process.env, env);
  try { const code = await cms({ flags, positional }, { fetch: fake.fetch }); return { code, report: JSON.parse(lines.join("\n")) }; }
  finally {
    console.log = saved.log;
    for (const [k, v] of [["EMDASH_URL", saved.url], ["EMDASH_TOKEN", saved.token], ["EMDASH_REVISIONS_PROVEN", saved.proven]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

// Each temporary folder is its own git repository: mirror folders must sit inside one (or inside the working folder).
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "cms-safety-")); execFileSync("git", ["init", "-q"], { cwd: d }); return d; };
const edit = (file, fn) => { const p = parseMirror(readFileSync(file, "utf8")); fn(p); writeFileSync(file, stringifyMirror(p.meta, p.body)); };
const publishes = (fake) => fake.log.filter((l) => l.method === "POST" && l.path.endsWith("/publish"));
async function exported(fake, slug) {
  const dir = tmp();
  await run(["export", "--dir", dir], fake);
  const file = join(dir, `${slug}.md`);
  const base = join(dir, "base.md.txt"); copyFileSync(file, base);
  return { dir, file, base };
}

test("fix 1: a post taken down or scheduled in the CMS is never published again, even for an unchanged file or an SEO-only edit", async () => {
  for (const status of ["draft", "scheduled"]) {
    const fake = site();
    const { file, base } = await exported(fake, "third-post");
    fake.find("third-post").status = status;
    const same = await run(["publish", "--file", file, "--base", base, "--revisions-proven"], fake);
    assert.equal(same.code, 3, JSON.stringify(same.report));
    assert.match(same.report.error, new RegExp(`is ${status} in the CMS`));
    edit(file, (p) => { p.meta.seoDescription = "A new description."; });
    const seoOnly = await run(["publish", "--file", file, "--base", base, "--revisions-proven"], fake);
    assert.equal(seoOnly.code, 3);
    assert.equal(fake.find("third-post").status, status);
    assert.equal(fake.seoRows.get(fake.find("third-post").id).description, null);
    assert.equal(publishes(fake).length, 0);
  }
});

test("a trashed (soft-deleted) post is neither exported nor written", async () => {
  const fake = site();
  const { dir, file, base } = await exported(fake, "third-post");
  const row = fake.findAny("third-post");
  row.deletedAt = "2026-01-02T00:00:00Z";
  const ex = await run(["export", "--dir", dir], fake);
  assert.ok(!ex.report.written.includes("third-post"));
  assert.ok(ex.report.notInCms.includes("third-post"));
  edit(file, (p) => { p.body += "\nMore words.\n"; });
  const before = JSON.stringify(row);
  const p = await run(["publish", "--file", file, "--base", base, "--revisions-proven"], fake);
  assert.equal(p.code, 3);
  assert.match(p.report.error, /deleted or in the trash/);
  assert.equal(JSON.stringify(row), before);
});

test("fix 2: someone else's pending draft (a slug change, other fields) is never published by the mirror", async () => {
  const fake = site();
  const { file, base } = await exported(fake, "first-post");
  fake.adminDraft("first-post", { slug: "first-renamed" });
  edit(file, (p) => { p.body += "\nA new closing paragraph.\n"; });
  const p = await run(["publish", "--file", file, "--base", base, "--revisions-proven"], fake);
  assert.equal(p.code, 3, JSON.stringify(p.report));
  assert.match(p.report.error, /did not make/);
  assert.equal(fake.find("first-post").slug, "first-post");
  // An SEO-only edit must not publish a pending slug and image either.
  const fake2 = site();
  const e2 = await exported(fake2, "first-post");
  fake2.adminDraft("first-post", { slug: "first-new-url", data: { featured_image: { id: "m2", src: "/m2.jpg", alt: "Other" } } });
  edit(e2.file, (q) => { q.meta.seoDescription = "Only the description changes."; });
  const s = await run(["publish", "--file", e2.file, "--base", e2.base, "--revisions-proven"], fake2);
  assert.equal(s.code, 3);
  assert.equal(fake2.find("first-post").slug, "first-post");
  assert.equal(fake2.find("first-post").data.featured_image.id, "m1");
  assert.equal(fake2.seoRows.get(fake2.find("first-post").id).description, "About the first post.");
  assert.equal(publishes(fake).length + publishes(fake2).length, 0);
});

test("fix 3: a file never writes to a different post", async () => {
  const fake = site([{ slug: "editor-draft", status: "draft", publishedAt: null, data: { title: "Editor's draft", content: [para("Their own words.")] } }]);
  const dir = tmp();
  const third = fake.find("third-post");
  const bodyBefore = JSON.stringify(third.data);
  // A new file that carries another post's id.
  const stray = join(dir, "new-thing.md");
  writeFileSync(stray, stringifyMirror({ id: third.id, slug: "new-thing", title: "New thing" }, "Replacement words.\n"));
  const a = await run(["publish", "--file", stray, "--revisions-proven"], fake);
  assert.equal(a.code, 3, JSON.stringify(a.report));
  assert.match(a.report.error, /needs its previous version/);
  // With a base, the slug must still be the post's own.
  const base = join(dir, "base.md.txt"); copyFileSync(stray, base);
  edit(stray, (p) => { p.body = "Other replacement words.\n"; });
  const b = await run(["publish", "--file", stray, "--base", base, "--revisions-proven"], fake);
  assert.equal(b.code, 3);
  assert.match(b.report.error, /does not belong/);
  assert.equal(JSON.stringify(third.data), bodyBefore);
  // A new file whose slug is an editor's unpublished draft does not take it over.
  const clash = join(dir, "editor-draft.md");
  writeFileSync(clash, stringifyMirror({ slug: "editor-draft", title: "Mine" }, "My words.\n"));
  for (const cmd of ["draft", "publish"]) {
    const r = await run([cmd, "--file", clash], fake);
    assert.equal(r.code, 3, JSON.stringify(r.report));
    assert.match(r.report.error, /was not made from this file/);
  }
  assert.equal(fake.find("editor-draft").status, "draft");
  assert.equal(fake.find("editor-draft").data.title, "Editor's draft");
  assert.equal(publishes(fake).length, 0);
});

test("fix 3: the mirror's own new-post draft is reused across pull-request pushes (found by the file's git history)", async () => {
  const fake = site(); const dir = tmp();
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "t@example.test"); git("config", "user.name", "t");
  const file = join(dir, "new-guide.md");
  writeFileSync(file, stringifyMirror({ slug: "new-guide", title: "A new guide" }, "First words.\n"));
  git("add", "."); git("commit", "-qm", "v1");
  assert.equal((await run(["draft", "--file", file], fake)).code, 0);
  edit(file, (p) => { p.body = "Second, better words.\n"; });
  git("commit", "-qam", "v2");
  const d2 = await run(["draft", "--file", file], fake);
  assert.equal(d2.code, 0, JSON.stringify(d2.report));
  assert.equal(d2.report.reusedDraft, fake.find("new-guide").id);
  assert.equal([...fake.rows.values()].filter((r) => r.slug === "new-guide").length, 1);
});

test("fix 4: validate --files reports a duplicate id on the changed file", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.md"), stringifyMirror({ id: "1", slug: "a", title: "A" }, "Words a.\n"));
  writeFileSync(join(dir, "b.md"), stringifyMirror({ id: "1", slug: "b", title: "B" }, "Words b.\n"));
  const { code, report } = await run(["validate", "--dir", dir, "--files", join(dir, "b.md")], site());
  assert.equal(code, 1, JSON.stringify(report));
  assert.ok(report.results[0].errors.some((e) => /id "1" is also used by .*a\.md/.test(e)));
});

test("fix 5: an SEO write that failed after the content was published can be finished by a re-run", async () => {
  const fake = site();
  const { file, base } = await exported(fake, "first-post");
  edit(file, (p) => { p.body += "\nNew paragraph.\n"; p.meta.seoDescription = "Refreshed description."; });
  let failSeo = true;
  const flaky = { ...fake, fetch: async (url, init = {}) => {
    if (failSeo && init.method === "PUT" && init.body && "seo" in JSON.parse(init.body)) { failSeo = false; return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "down" } }), { status: 500 }); }
    return fake.fetch(url, init);
  } };
  const first = await run(["publish", "--file", file, "--base", base, "--revisions-proven"], flaky);
  assert.equal(first.code, 1);
  assert.equal(fake.seoRows.get(fake.find("first-post").id).description, "About the first post.");
  const again = await run(["publish", "--file", file, "--base", base, "--revisions-proven"], flaky);
  assert.equal(again.code, 0, JSON.stringify(again.report));
  assert.match(again.report.plan.reason, /resuming/);
  assert.equal(again.report.verified, true);
  assert.equal(fake.seoRows.get(fake.find("first-post").id).description, "Refreshed description.");
});

test("fix 6: validate rejects edits that would publish differently from what the author sees", () => {
  const ok = (body, meta = {}) => validateFile(parseMirror(stringifyMirror({ slug: "a", title: "A", ...meta }, body)), { file: "a.md" }).errors;
  assert.deepEqual(ok("Words.\n"), []);
  const quoted = parseMirror("---\nslug: \"a\"\ntitle: 'Alpha: guide'\n---\nWords.\n");
  assert.ok(validateFile(quoted, { file: "a.md" }).errors.some((e) => /title" is not valid JSON/.test(e)));
  assert.ok(ok("Words.\n\n  <!--ec:block {\"_type\":\"table\"} -->\n").some((e) => /line 3: .*beginning of the line/.test(e)));
  assert.ok(ok("Words.\n\n```\nnot closed\n\nMore words.\n").some((e) => /line 3: the code fence ``` .*never closed/.test(e)));
  assert.ok(ok("Words.\n\n<!--ec:block null -->\n").some((e) => /line 3: .*JSON object with a _type/.test(e)));
});

test("fix 8: an EmDash URL with a user name or password is refused without printing it", () => {
  assert.throws(() => createClient({ url: "https://user:s3cret@cms.example.test", token: "x" }), (e) => /user name or password/.test(e.message) && !e.message.includes("s3cret"));
});

test("fix 9d: revisionsProven in the settings file decides, and a flag cannot override false", async () => {
  const dir = tmp();
  const fake = site();
  const { file, base } = await exported(fake, "third-post");
  edit(file, (p) => { p.body += "\nMore words.\n"; });
  const off = join(dir, "off.json"); writeFileSync(off, JSON.stringify({ collection: "posts", revisionsProven: false }));
  const r = await run(["draft", "--file", file, "--base", base, "--settings", off, "--revisions-proven"], fake);
  assert.equal(r.code, 3, JSON.stringify(r.report));
  assert.match(r.report.error, /settings file/);
  const on = join(dir, "on.json"); writeFileSync(on, JSON.stringify({ collection: "posts", revisionsProven: true }));
  const d = await run(["draft", "--file", file, "--base", base, "--settings", on], fake);
  assert.equal(d.code, 0, JSON.stringify(d.report));
  assert.equal(d.report.draftSaved, true);
});

test("fix 10: links with blank:false stay editable; unchanged blocks keep their keys and the strike mark name", () => {
  const link = { _type: "block", _key: "k1", style: "normal", markDefs: [{ _key: "m1", _type: "link", href: "/posts/x", blank: false }], children: [{ _type: "span", _key: "s1", text: "Read ", marks: [] }, { _type: "span", _key: "s2", text: "this", marks: ["m1"] }] };
  const r = roundTrip([link]);
  assert.equal(r.ok, true);
  assert.equal(r.opaque, 0);
  assert.equal(r.markdown, "Read [this](/posts/x)\n");
  const strike = { _type: "block", _key: "k2", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s3", text: "old", marks: ["strikethrough"] }] };
  const previous = [para("Kept paragraph.", "keep1"), link];
  const file = parseMirror(stringifyMirror({ slug: "a", title: "A" }, "Kept paragraph.\n\nRead [this](/posts/x)\n\nA new ~~line~~.\n"));
  const out = draftData(file, undefined, { previous: [...previous, strike] }).content;
  assert.equal(out[0]._key, "keep1");
  assert.deepEqual(out[1], link, "the link block keeps its markDefs (blank: false) and keys");
  assert.deepEqual(out[2].children.find((c) => c.text === "line").marks, ["strikethrough"]);
});
