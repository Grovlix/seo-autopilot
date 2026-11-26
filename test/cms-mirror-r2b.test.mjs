// Review R2b and the symlink check from R4, each against the EmDash 0.1.0 stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { cms } from "../src/cms/commands.mjs";
import { parseMirror, stringifyMirror } from "../src/cms/mirror.mjs";

const URL_ = "https://cms.example.test";
const para = (text, key = "p") => ({ _type: "block", _key: key, style: "normal", markDefs: [], children: [{ _type: "span", _key: key + "s", text, marks: [] }] });
const bodyText = (row) => row.data.content.map((b) => b.children.map((c) => c.text).join("")).join("\n");

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
  try { const code = await cms({ flags, positional }, { fetch: fake.fetch }); return { code, report: JSON.parse(lines.join("\n")), raw: lines.join("\n") }; }
  finally {
    console.log = saved.log;
    for (const [k, v] of [["EMDASH_URL", saved.url], ["EMDASH_TOKEN", saved.token], ["EMDASH_REVISIONS_PROVEN", saved.proven]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
// Each temporary folder is its own git repository: mirror folders must sit inside one (or inside the working folder).
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "cms-r2b-")); execFileSync("git", ["init", "-q"], { cwd: d }); return d; };
const publishes = (fake) => fake.log.filter((l) => l.method === "POST" && l.path.endsWith("/publish"));
function repo() {
  const dir = tmp();
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.email", "t@example.test"); git("config", "user.name", "t");
  return { dir, git };
}

// F1: V1 is merged, its publish fails after the draft save (or an editor types the V1 wording into a draft); V1 is
// reverted; a later SEO-only edit must not make the reverted V1 text live.
for (const [label, makeDraft] of [
  ["a failed publish of V1", async ({ fake, file }) => {
    const inner = fake.fetch; let failed = false;
    const flaky = { ...fake, fetch: async (url, init = {}) => { if (!failed && /\/publish$/.test(new URL(url).pathname)) { failed = true; return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "busy" } }), { status: 503 }); } return inner(url, init); } };
    const r = await run(["publish", "--file", file, "--base-ref", "HEAD^1", "--revisions-proven"], flaky);
    assert.equal(r.code, 1);
  }],
  ["an editor's draft equal to V1", async ({ fake }) => { fake.adminDraft("alpha", { data: { content: [para("Unverified claim that was pulled.", "e1")] } }); }],
]) {
  test(`F1: an SEO-only edit never publishes a pending draft of an older version (${label})`, async () => {
    const fake = fakeEmDash({ posts: [{ slug: "alpha", data: { title: "Alpha", content: [para("Original claim, checked.")] }, seo: { title: "Alpha SEO" } }] });
    const { dir, git } = repo();
    const posts = join(dir, "posts");
    await run(["export", "--dir", posts], fake);
    git("add", "."); git("commit", "-qm", "export");
    const file = join(posts, "alpha.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("Original claim, checked.", "Unverified claim that was pulled."));
    git("commit", "-qam", "V1");
    await makeDraft({ fake, file });
    assert.equal(bodyText(fake.find("alpha")), "Original claim, checked.");
    git("revert", "--no-edit", "HEAD");
    await run(["publish", "--file", file, "--base-ref", "HEAD^1", "--revisions-proven"], fake);
    writeFileSync(file, readFileSync(file, "utf8").replace('seoTitle: "Alpha SEO"', 'seoTitle: "Alpha SEO v2"'));
    git("commit", "-qam", "SEO-only");
    const r = await run(["publish", "--file", file, "--base-ref", "HEAD^1", "--revisions-proven"], fake);
    assert.equal(bodyText(fake.find("alpha")), "Original claim, checked.", "the reverted V1 text went live");
    assert.equal(r.code, 0, JSON.stringify(r.report));
    assert.equal(r.report.verified, true);
    assert.equal(fake.seoRows.get(fake.find("alpha").id).title, "Alpha SEO v2");
  });
}

test("F2: export never writes outside the mirror folder for a slug with path characters", async () => {
  const fake = fakeEmDash({ posts: [
    { slug: "alpha", data: { title: "Alpha", content: [para("Alpha words.")] } },
    { slug: "../../escaped", data: { title: "Escaped", content: [para("Out.")] } },
    { slug: ".hidden", data: { title: "Hidden", content: [para("Dot.")] } },
    { slug: "a\\b", data: { title: "Backslash", content: [para("Back.")] } },
  ] });
  const root = tmp();
  const dir = join(root, "a", "b", "posts");
  const r = await run(["export", "--dir", dir], fake);
  assert.equal(r.code, 1);
  assert.deepEqual(r.report.written, ["alpha"]);
  assert.deepEqual(r.report.skipped.map((s) => s.slug).sort(), [".hidden", "../../escaped", "a\\b"].sort());
  assert.equal(existsSync(join(root, "a", "escaped.md")), false);
  assert.deepEqual(readdirSync(dir), ["alpha.md"]);
});

test("F3: the same slug in two locales is skipped and reported, not written over one file", async () => {
  const fake = fakeEmDash({ posts: [
    { slug: "guide", locale: "ar", data: { title: "دليل", content: [para("نص عربي.")] } },
    { slug: "guide", locale: "en", data: { title: "Guide", content: [para("English text.")] } },
    { slug: "other", data: { title: "Other", content: [para("Other words.")] } },
  ] });
  const dir = tmp();
  const r = await run(["export", "--dir", dir], fake);
  assert.equal(r.code, 1);
  assert.deepEqual(r.report.written, ["other"]);
  assert.equal(r.report.skipped.filter((s) => s.slug === "guide").length, 2);
  assert.match(r.report.skipped[0].reason, /locales: ar, en/);
  assert.equal(existsSync(join(dir, "guide.md")), false);
});

test("F4: validate without --dir checks the files' own folder, and a new file may not carry an id", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "a.md"), stringifyMirror({ id: "1", slug: "a", title: "A" }, "Words a.\n"));
  git("add", "."); git("commit", "-qm", "a");
  writeFileSync(join(dir, "b.md"), stringifyMirror({ id: "1", slug: "b", title: "B" }, "Words b.\n"));
  const r = await run(["validate", "--files", join(dir, "b.md"), "--base-ref", "HEAD"], fakeEmDash());
  assert.equal(r.code, 1, JSON.stringify(r.report));
  const errors = r.report.results[0].errors;
  assert.ok(errors.some((e) => /id "1" is also used by .*a\.md/.test(e)), errors.join("; "));
  assert.ok(errors.some((e) => /id "1" on a new file/.test(e)), errors.join("; "));
});

test("F5: a draft someone saves between our draft save and the publish call is not published", async () => {
  const fake = fakeEmDash({ posts: [{ slug: "alpha", data: { title: "Alpha", content: [para("Alpha words.")] } }] });
  const dir = tmp();
  await run(["export", "--dir", dir], fake);
  const file = join(dir, "alpha.md"); const base = join(dir, "base.txt");
  writeFileSync(base, readFileSync(file, "utf8"));
  const p = parseMirror(readFileSync(file, "utf8")); writeFileSync(file, stringifyMirror(p.meta, p.body + "\nMore words.\n"));
  const inner = fake.fetch; let injected = false;
  const racy = { ...fake, fetch: async (url, init = {}) => {
    const res = await inner(url, init);
    if (!injected && init.method === "PUT" && init.body && "data" in JSON.parse(init.body)) { injected = true; fake.adminDraft("alpha", { slug: "alpha-moved" }); }
    return res;
  } };
  const r = await run(["publish", "--file", file, "--base", base, "--revisions-proven"], racy);
  assert.equal(r.code, 3, JSON.stringify(r.report));
  assert.match(r.report.error, /someone saved a draft after ours/);
  assert.equal(publishes(fake).length, 0);
  assert.equal(fake.find("alpha").slug, "alpha");
});

test("F6: a title with U+2028 or U+2029 exports to a file that validates and reads back", async () => {
  const title = "Line separator para";
  const fake = fakeEmDash({ posts: [{ slug: "alpha", data: { title, excerpt: "x y", content: [para("Alpha words.")] } }] });
  const dir = tmp();
  assert.equal((await run(["export", "--dir", dir], fake)).code, 0);
  const v = await run(["validate", "--dir", dir], fake);
  assert.equal(v.code, 0, JSON.stringify(v.report));
  assert.equal(parseMirror(readFileSync(join(dir, "alpha.md"), "utf8")).meta.title, title);
});

test("R4: symbolic links and files outside the posts folder are never read, published or written through", async () => {
  const fake = fakeEmDash({ posts: [{ slug: "alpha", data: { title: "Alpha", content: [para("Alpha words.")] } }] });
  const root = tmp();
  const dir = join(root, "posts"); mkdirSync(dir);
  const secret = join(root, "config"); writeFileSync(secret, "token = do-not-leak\n");
  await run(["export", "--dir", dir], fake);
  symlinkSync("../config", join(dir, "x.md"));
  const all = await run(["validate", "--dir", dir], fake);
  assert.equal(all.code, 1);
  assert.ok(all.report.unsafe?.some((e) => /x\.md is a symbolic link/.test(e)) || all.report.results.some((r) => r.errors.some((e) => /symbolic link/.test(e))), all.raw);
  assert.ok(!all.raw.includes("do-not-leak"));
  const one = await run(["validate", "--files", join(dir, "x.md")], fake);
  assert.equal(one.code, 1);
  assert.match(one.report.results[0].errors[0], /symbolic link/);
  assert.ok(!one.raw.includes("do-not-leak"));
  const pub = await run(["publish", "--file", join(dir, "x.md"), "--revisions-proven"], fake);
  assert.equal(pub.code, 3);
  assert.equal(fake.log.filter((l) => l.method !== "GET").length, 0);
  // export must not write through a link that sits where a post file goes
  const dir2 = join(root, "posts2"); mkdirSync(dir2);
  symlinkSync("../config", join(dir2, "alpha.md"));
  const ex = await run(["export", "--dir", dir2], fake);
  assert.equal(ex.code, 1);
  assert.equal(readFileSync(secret, "utf8"), "token = do-not-leak\n");
});
