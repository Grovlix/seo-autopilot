// Optional AI step. Every caller works without it (rule-based fallback), so AI is never required.
// Providers:
//   "claude-code"  the Claude Code CLI run headless (`claude -p --output-format json`) with CLAUDE_CODE_OAUTH_TOKEN, i.e. your
//                  Claude subscription, no API key. Needs the `claude` command (npm i -g @anthropic-ai/claude-code).
//   "anthropic"    the Messages API with ANTHROPIC_API_KEY (pay per use).
//   "openai"       any OpenAI-compatible chat endpoint, OPENAI_API_KEY, optional OPENAI_BASE_URL.
// Choice, first match wins: SEO_LLM_PROVIDER, then "llm": { "provider" } in seo-autopilot.config.json, then whichever key is
// set (ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN). Model: SEO_MODEL, then "llm": { "model" }.
// Output is always treated as untrusted text, and every input a caller passes (search queries, page text, feed items) is
// sent as data in the user message. The CLI runs with no tools, no MCP servers and no project settings, so text in the
// input cannot make it act; it can only answer.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const PROVIDERS = ["claude-code", "anthropic", "openai", "none"];
let configured = {};

/** Called by the job runner with the config's "llm" section. */
export function configureLlm(llm) { configured = llm && typeof llm === "object" ? { ...llm } : {}; }

const claudeBin = (env) => env.SEO_CLAUDE_BIN || "claude";
/** True when the `claude` command can be found (a path, or a name on PATH). */
export function claudeOnPath(env = process.env) {
  const bin = claudeBin(env);
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  return String(env.PATH || "").split(delimiter).some((d) => d && exts.some((x) => existsSync(join(d, bin + x))));
}

/** The provider to use and why, without calling anything. */
export function selectProvider(env = process.env, cfg = configured) {
  const want = env.SEO_LLM_PROVIDER || cfg.provider;
  if (want) {
    if (!PROVIDERS.includes(want)) return { provider: "none", reason: `unknown AI provider "${want}" (use ${PROVIDERS.join(", ")})` };
    if (want === "anthropic" && !env.ANTHROPIC_API_KEY) return { provider: "none", reason: "provider anthropic needs ANTHROPIC_API_KEY" };
    if (want === "openai" && !env.OPENAI_API_KEY) return { provider: "none", reason: "provider openai needs OPENAI_API_KEY" };
    if (want === "claude-code" && !claudeOnPath(env)) return { provider: "none", reason: "provider claude-code needs the claude command (npm i -g @anthropic-ai/claude-code)" };
    return { provider: want, reason: want === "none" ? "AI turned off in the config" : `chosen in the ${env.SEO_LLM_PROVIDER ? "SEO_LLM_PROVIDER variable" : "config"}` };
  }
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", reason: "ANTHROPIC_API_KEY is set" };
  if (env.OPENAI_API_KEY) return { provider: "openai", reason: "OPENAI_API_KEY is set" };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return claudeOnPath(env) ? { provider: "claude-code", reason: "CLAUDE_CODE_OAUTH_TOKEN is set" }
      : { provider: "none", reason: "CLAUDE_CODE_OAUTH_TOKEN is set but the claude command is missing (npm i -g @anthropic-ai/claude-code)" };
  }
  return { provider: "none", reason: "no AI login: set CLAUDE_CODE_OAUTH_TOKEN (Claude subscription), ANTHROPIC_API_KEY or OPENAI_API_KEY" };
}

export const llmAvailable = () => selectProvider().provider !== "none";

export const NO_FAKE_RULES = "Hard rules: never invent statistics, prices, percentages, clients, quotes or results. If a fact is not in the input, leave it out. Plain words.";

let skipNoted = false;
export async function ask(system, user, { maxTokens = 1500, env = process.env, timeoutMs } = {}) {
  const { provider: p, reason } = selectProvider(env);
  if (p === "none") {
    if (!skipNoted) { console.log(`llm: AI step skipped (${reason}); the rule-based result is used.`); skipNoted = true; }
    return null;
  }
  const model = env.SEO_MODEL || configured.model;
  try {
    if (p === "claude-code") return await askClaudeCode(system, user, { model, env, timeoutMs });
    if (p === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: model || "claude-sonnet-5-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) { console.log(`llm: HTTP ${res.status}`); return null; }
      const j = await res.json();
      return (j.content || []).map((c) => c.text || "").join("").trim() || null;
    }
    const base = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: model || "gpt-4o-mini", max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) { console.log(`llm: HTTP ${res.status}`); return null; }
    const j = await res.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { console.log("llm: failed", e.message); return null; }
}

/** The command line for one headless answer. Exported for tests. */
export const claudeArgs = (system, model) => [
  "-p", "--output-format", "json", "--max-turns", "1", "--model", model || "sonnet",
  "--system-prompt", system,
  "--tools", "",                  // no built-in tools: it can only answer
  "--strict-mcp-config",          // and no MCP servers
  "--setting-sources", "",        // ignore the machine's and project's Claude settings, hooks and memory
  "--no-session-persistence",
];

/**
 * One answer from the Claude Code CLI on the Claude subscription. The user text goes in on stdin, never on the command line.
 * ANTHROPIC_API_KEY is removed from the child's environment: in print mode the CLI prefers a key when present, and this
 * provider is chosen to use the subscription. Fails soft: any problem logs one line and returns null.
 */
export function askClaudeCode(system, user, { model, env = process.env, timeoutMs } = {}) {
  const limit = Number(timeoutMs || env.SEO_LLM_TIMEOUT_MS || 120000);
  const childEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const finish = (v, note) => { if (done) return; done = true; clearTimeout(timer); if (note) console.log(`llm: claude-code ${note}`); resolve(v); };
    let child;
    try { child = spawn(claudeBin(env), claudeArgs(system, model), { env: childEnv, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return finish(null, `could not start (${e.code || e.message})`); }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null, `timed out after ${Math.round(limit / 1000)} s`); }, limit);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(null, `could not start (${e.code || e.message})`));
    child.on("close", (code) => {
      let j = null;
      try { j = JSON.parse(out.trim().split("\n").filter(Boolean).at(-1) || "null"); } catch { /* not JSON */ }
      // A failure inside the run (for example a missing or expired login) is printed as the result with an error flag.
      if (!j || typeof j !== "object") return finish(null, `gave no JSON answer (exit ${code})${err.trim() ? `: ${err.trim().slice(-200)}` : ""}`);
      if (j.is_error || (j.subtype && j.subtype !== "success")) return finish(null, `run failed: ${String(j.result || j.subtype || "error").slice(0, 200)}`);
      finish(typeof j.result === "string" && j.result.trim() ? j.result.trim() : null, code ? `exit ${code}` : "");
    });
    child.stdin.on("error", () => {});
    child.stdin.end(user);
  });
}

export async function askJson(system, user, opts) {
  const t = await ask(`${system}\nReply with valid JSON only, no prose.`, user, opts);
  if (!t) return null;
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
