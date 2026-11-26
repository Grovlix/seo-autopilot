// The mirror folder itself must be a plain folder inside the repository (review R2c, N1): a link anywhere in its path,
// or a --files path that leaves it, must not let validate read or export write outside.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { cms } from "../src/cms/commands.mjs";
import { stringifyMirror } from "../src/cms/mirror.mjs";

const para = (text) => ({ _type: "block", _key: "p", style: "normal", markDefs: [], children: [{ _type: "span", _key: "ps", text, marks: [] }] });

async function run(args, fake = fakeEmDash()) {
  const flags = {}; const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) { positional.push(args[i]); continue; }
    const k = args[i].slice(2); if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) flags[k] = args[++i]; else flags[k] = true;
  }
  const saved = { log: console.log, url: process.env.EMDASH_URL, token: process.env.EMDASH_TOKEN };
  const lines = [];
  console.log = (s) => lines.push(String(s));
  process.env.EMDASH_URL = "https://cms.example.test"; process.env.EMDASH_TOKEN = "test-token-not-real";
  try { const code = await cms({ flags, positional }, { fetch: fake.fetch }); return { code, raw: lines.join("\n"), report: JSON.parse(lines.join("\n")) }; }
  finally {
    console.log = saved.log;
    for (const [k, v] of [["EMDASH_URL", saved.url], ["EMDASH_TOKEN", saved.token]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

// A site repository and, next to it, a folder outside it holding a valid-looking post with a secret title.
function layout() {
  const root = mkdtempSync(join(tmpdir(), "cms-dir-guard-"));
  const site = join(root, "site"); mkdirSync(site);
  execFileSync("git", ["init", "-q"], { cwd: site });
  const outside = join(root, "outside"); mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), stringifyMirror({ slug: "secret", title: "SECRET-VALUE-9f3" }, "Private words.\n"));
  return { root, site, outside };
}

test("N1 F1: validate refuses a mirror folder that is a symbolic link to a folder outside the repository", async () => {
  const { site, outside } = layout();
  symlinkSync(outside, join(site, "posts"));
  const r = await run(["validate", "--dir", join(site, "posts")]);
  assert.equal(r.code, 3, r.raw);
  assert.match(r.report.error, /symbolic link/);
  assert.ok(!r.raw.includes("SECRET-VALUE-9f3"));
});

test("N1 F2: export does not write into the target of a linked mirror folder", async () => {
  const { site, outside } = layout();
  symlinkSync(outside, join(site, "posts"));
  const fake = fakeEmDash({ posts: [{ slug: "alpha", data: { title: "Alpha", content: [para("Alpha words.")] } }] });
  const r = await run(["export", "--dir", join(site, "posts")], fake);
  assert.equal(r.code, 3, r.raw);
  assert.deepEqual(readdirSync(outside), ["secret.md"]);
  assert.equal(fake.log.length, 0, "refused before any call");
});

test("N1 F4: validate --files refuses a path that climbs out of the mirror folder or the repository", async () => {
  const { site } = layout();
  mkdirSync(join(site, "posts"));
  writeFileSync(join(site, "posts", "a.md"), stringifyMirror({ slug: "a", title: "A" }, "Words.\n"));
  const escape = join(site, "posts", "..", "..", "outside", "secret.md");
  for (const args of [["validate", "--files", escape], ["validate", "--dir", join(site, "posts"), "--files", escape]]) {
    const r = await run(args);
    assert.notEqual(r.code, 0, `${args.join(" ")}: ${r.raw}`);
    assert.ok(!r.raw.includes("SECRET-VALUE-9f3"), r.raw);
  }
});

test("N1: a plain mirror folder inside the repository still works, and a folder outside any repository and the working folder is refused", async () => {
  const { site, outside } = layout();
  const fake = fakeEmDash({ posts: [{ slug: "alpha", data: { title: "Alpha", content: [para("Alpha words.")] } }] });
  assert.equal((await run(["export", "--dir", join(site, "content", "posts")], fake)).code, 0);
  assert.equal((await run(["validate", "--dir", join(site, "content", "posts")], fake)).code, 0);
  const r = await run(["validate", "--dir", outside]);
  assert.equal(r.code, 3, r.raw);
  assert.match(r.report.error, /not inside/);
});
