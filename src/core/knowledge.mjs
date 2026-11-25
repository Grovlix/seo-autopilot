// The playbooks and skills each agent reads. Every agent's "Read first" section names its playbooks (knowledge/*.md);
// its skills are named anywhere in the file as seo-autopilot/skills/<name>/SKILL.md. Our own files: trusted reference
// material, unlike site data. Used by scripts/knowledge-review.mjs to see which playbooks each agent depends on.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listAgents, listSkills, DEPARTMENTS_DIR } from "./agents.mjs";

export const KNOWLEDGE_DIR = (() => { try { return fileURLToPath(new URL("../../knowledge/", import.meta.url)); } catch { return null; } })();

/** The playbooks and skills one agent names. text: the agent's markdown; known: { playbooks: Set, skills: Set }. */
export function referencesOf(text, known) {
  const t = String(text).replace(/\r\n/g, "\n");
  const read = (t.match(/## Read first\n([\s\S]*?)(\n## |$)/) || [])[1] || "";
  const playbooks = [], skills = [];
  for (const m of read.matchAll(/`(?:seo-autopilot\/knowledge\/)?([a-z0-9-]+\.md)`/g)) if (known.playbooks.has(m[1]) && !playbooks.includes(m[1])) playbooks.push(m[1]);
  for (const m of t.matchAll(/seo-autopilot\/skills\/([a-z0-9-]+)\/SKILL\.md/g)) if (known.skills.has(m[1]) && !skills.includes(m[1])) skills.push(m[1]);
  return { playbooks, skills };
}

const stripFront = (s) => String(s).replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").trim();

/** Everything read from the repository: { playbooks: {file: text}, skills: {name: text}, refs: {agent: {playbooks, skills}} }. */
export function readKnowledge(kdir = KNOWLEDGE_DIR, ddir = DEPARTMENTS_DIR) {
  const playbooks = Object.fromEntries(readdirSync(kdir).filter((f) => f.endsWith(".md") && f !== "README.md").sort().map((f) => [f, stripFront(readFileSync(join(kdir, f), "utf8"))]));
  const skills = Object.fromEntries(listSkills(ddir).map((s) => [s.name, stripFront(readFileSync(s.file, "utf8"))]));
  const known = { playbooks: new Set(Object.keys(playbooks)), skills: new Set(Object.keys(skills)) };
  const refs = Object.fromEntries(listAgents(ddir).map((a) => [a.name, referencesOf(readFileSync(a.file, "utf8"), known)]));
  return { playbooks, skills, refs };
}
