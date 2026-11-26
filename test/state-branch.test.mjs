// stateBranch: documented since the first release, but loadConfig never returned it, so state.mjs always used "seo-data".
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validate } from "../src/core/config.mjs";
import { save, restore } from "../src/cli/state.mjs";

const SITE = { id: "s", url: "https://s.test/", searchConsoleProperty: "sc-domain:s.test", sitemap: "https://s.test/sitemap.xml" };
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };

test("stateBranch: defaults to seo-data and is returned by loadConfig when set", () => {
  const dir = mkdtempSync(join(tmpdir(), "seo-sb-"));
  writeFileSync(join(dir, "seo-autopilot.config.json"), JSON.stringify({ sites: [SITE] }));
  assert.equal(loadConfig({ cwd: dir }).stateBranch, "seo-data");
  writeFileSync(join(dir, "seo-autopilot.config.json"), JSON.stringify({ stateBranch: "aeo-data", sites: [SITE] }));
  assert.equal(loadConfig({ cwd: dir }).stateBranch, "aeo-data");
});

test("stateBranch: names that are not plain branch names, or that are a site's real branches, are refused (the state is force-pushed)", () => {
  for (const ok of ["seo-data", "aeo-data", "ops/seo-state", "state_1.2"]) assert.deepEqual(validate({ stateBranch: ok, sites: [SITE] }), [], ok);
  for (const bad of ["main", "master", "Main", "HEAD", "gh-pages", "production", "", " x", "-x", "a..b", "a b", "a/", "x.lock", "refs/heads/x ; rm", 5, ["a"]]) {
    assert.equal(validate({ stateBranch: bad, sites: [SITE] }).filter((e) => /stateBranch/.test(e)).length, 1, JSON.stringify(bad));
  }
});

test("stateBranch: save and restore use the configured branch and leave seo-data alone", () => {
  const bare = mkdtempSync(join(tmpdir(), "seo-sb-bare-")), repo = mkdtempSync(join(tmpdir(), "seo-sb-repo-"));
  git(bare, "init", "-q", "--bare");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t"); git(repo, "config", "user.email", "t@t");
  writeFileSync(join(repo, "seo-autopilot.config.json"), JSON.stringify({ stateBranch: "aeo-data", sites: [SITE] }));
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "origin", "main");
  mkdirSync(join(repo, ".seo-autopilot", "s"), { recursive: true });
  writeFileSync(join(repo, ".seo-autopilot", "s", "aeo.json"), '{"ok":true}');
  quiet(() => save({ cwd: repo }));
  const heads = git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").sort();
  assert.deepEqual(heads, ["aeo-data", "main"], "state went to aeo-data, not seo-data, and main was not touched");
  git(repo, "checkout", "-q", "-f", "main"); git(repo, "clean", "-fdxq");
  assert.ok(!existsSync(join(repo, ".seo-autopilot")));
  quiet(() => restore({ cwd: repo }));
  assert.equal(readFileSync(join(repo, ".seo-autopilot", "s", "aeo.json"), "utf8"), '{"ok":true}');
});
