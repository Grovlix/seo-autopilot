// "revisionsProven": false in the settings file turns every write off, even when the token can read the schema and
// the schema says the collection keeps revisions. A person turns writes on by committing true after preview-check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { cms } from "../src/cms/commands.mjs";
import { parseMirror, stringifyMirror } from "../src/cms/mirror.mjs";

const para = (text) => ({ _type: "block", _key: "p", style: "normal", markDefs: [], children: [{ _type: "span", _key: "ps", text, marks: [] }] });
const site = () => fakeEmDash({ schemaReadable: true, revisions: true, posts: [{ slug: "alpha", data: { title: "Alpha", content: [para("Alpha words.")] }, seo: { title: "Alpha SEO", description: "About alpha." } }] });

async function run(args, fake) {
  const flags = {}; const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) { positional.push(args[i]); continue; }
    const k = args[i].slice(2); if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) flags[k] = args[++i]; else flags[k] = true;
  }
  const saved = { log: console.log, url: process.env.EMDASH_URL, token: process.env.EMDASH_TOKEN, proven: process.env.EMDASH_REVISIONS_PROVEN };
  const lines = [];
  console.log = (s) => lines.push(String(s));
  process.env.EMDASH_URL = "https://cms.example.test"; process.env.EMDASH_TOKEN = "test-token-not-real"; process.env.EMDASH_REVISIONS_PROVEN = "true";
  try { const code = await cms({ flags, positional }, { fetch: fake.fetch }); return { code, raw: lines.join("\n"), report: JSON.parse(lines.join("\n")) }; }
  finally {
    console.log = saved.log;
    for (const [k, v] of [["EMDASH_URL", saved.url], ["EMDASH_TOKEN", saved.token], ["EMDASH_REVISIONS_PROVEN", saved.proven]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

async function setup(proven) {
  const fake = site();
  const dir = mkdtempSync(join(tmpdir(), "cms-rev-off-")); execFileSync("git", ["init", "-q"], { cwd: dir });
  const posts = join(dir, "posts");
  await run(["export", "--dir", posts], fake);
  const file = join(posts, "alpha.md");
  const base = join(dir, "base.txt"); copyFileSync(file, base);
  const settings = join(dir, "cms.json"); writeFileSync(settings, JSON.stringify({ collection: "posts", revisionsProven: proven }));
  const edit = (fn) => { const p = parseMirror(readFileSync(file, "utf8")); fn(p); writeFileSync(file, stringifyMirror(p.meta, p.body)); };
  return { fake, file, base, settings, edit };
}
const writes = (fake) => fake.log.filter((l) => l.method !== "GET");

for (const [label, change] of [
  ["a body edit", (p) => { p.body += "\nMore words.\n"; }],
  ["an SEO-only edit", (p) => { p.meta.seoDescription = "A new description."; }],
]) {
  for (const cmd of ["draft", "publish"]) {
    test(`settings revisionsProven false refuses ${cmd} for ${label}, although the schema shows revisions`, async () => {
      const s = await setup(false);
      s.edit(change);
      const r = await run([cmd, "--file", s.file, "--base", s.base, "--settings", s.settings, "--revisions-proven"], s.fake);
      assert.equal(r.code, 3, r.raw);
      assert.match(r.report.error, /revisionsProven.*false/);
      assert.deepEqual(writes(s.fake), [], "no write reached the CMS");
    });
  }
}

test("settings revisionsProven true still lets a publish through (body and SEO)", async () => {
  const s = await setup(true);
  s.edit((p) => { p.body += "\nMore words.\n"; p.meta.seoDescription = "A new description."; });
  const r = await run(["publish", "--file", s.file, "--base", s.base, "--settings", s.settings], s.fake);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.report.verified, true);
});

test("a dry run with revisionsProven false makes no write and says writes are off", async () => {
  const s = await setup(false);
  s.edit((p) => { p.meta.seoDescription = "A new description."; });
  const r = await run(["publish", "--file", s.file, "--base", s.base, "--settings", s.settings, "--dry"], s.fake);
  assert.deepEqual(writes(s.fake), []);
  assert.equal(r.report.writesOff, true, r.raw);
});
