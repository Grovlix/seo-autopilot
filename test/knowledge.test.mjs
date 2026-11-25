// Every agent reads real playbooks and skills (what scripts/knowledge-review.mjs relies on). Moved from the removed agent-runner test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readKnowledge, referencesOf } from "../src/core/knowledge.mjs";
import { listAgents } from "../src/core/agents.mjs";

test("knowledge: every agent reads its playbooks and skills, and each one it names exists", () => {
  const kb = readKnowledge();
  for (const a of listAgents()) {
    const text = readFileSync(a.file, "utf8").replace(/\r\n/g, "\n");
    const read = (text.match(/## Read first\n([\s\S]*?)(\n## |$)/) || [])[1] || "";
    for (const m of read.matchAll(/`(?:seo-autopilot\/knowledge\/)?([a-z0-9-]+\.md)`/g)) {
      if (["site-profile.json"].includes(m[1])) continue;
      assert.ok(existsSync(new URL(`../knowledge/${m[1]}`, import.meta.url)), `${a.name} names knowledge/${m[1]}, which does not exist`);
    }
    assert.ok(kb.refs[a.name].playbooks.length > 0, `${a.name} reads at least one playbook`);
  }
  assert.deepEqual(kb.refs["seo-content-pruner"].playbooks.slice(0, 1), ["refreshing-and-pruning-content.md"]);
  assert.ok(kb.refs["seo-link-builder"].skills.includes("digital-pr"));
  const r = referencesOf("## Read first\n`seo-autopilot/knowledge/a.md`, `b.md`, `missing.md`\n## Method\n`c.md`", { playbooks: new Set(["a.md", "b.md", "c.md"]), skills: new Set() });
  assert.deepEqual(r.playbooks, ["a.md", "b.md"], "only Read first, only files that exist");
});
