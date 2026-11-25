// The only way this tool talks to DataForSEO (api.dataforseo.com). Every paid call goes through a cost guard:
//   1. Before the call: refuse (BudgetError, no request sent) when this month's spend plus a conservative estimate for the call
//      would pass `dataforseo.monthlyCapUsd`, or when the live account balance (free GET /v3/appendix/user_data, cached for 10
//      minutes per run) would fall under `dataforseo.minBalanceUsd`. Unknown balance counts as a refusal: no blind spending.
//   2. After the call: add the response's own `cost` to a ledger (<state>/dataforseo-ledger.json: per month, per job, per
//      endpoint). The state folder is what `seo-autopilot state save` keeps on the data branch, so the ledger survives runs.
//   3. When it refuses: one alert per day per reason through the generic notifier (src/lib/notify.mjs, TELEGRAM_* env).
// Config, per site: "dataforseo": { "monthlyCapUsd": 8, "minBalanceUsd": 10 }. Credentials: DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD
// (only in the Authorization header; never logged, never in an error or an alert). `fetch`, `now`, the ledger and the notifier are
// injectable so tests never touch the network.
import { readJson, writeJson } from "../core/util.mjs";
import { sendTelegram } from "./notify.mjs";
import { DEFAULT_CAP_USD, DEFAULT_MIN_BALANCE_USD } from "./budget-defaults.mjs";

export { DEFAULT_CAP_USD, DEFAULT_MIN_BALANCE_USD };
const BASE = "https://api.dataforseo.com/v3/";
const BALANCE_TTL_MS = 10 * 60 * 1000;

export class BudgetError extends Error {
  /** reason: "monthly-cap" | "min-balance" | "balance-unavailable" | "no-guard" */
  constructor(message, reason, details = {}) { super(message); this.name = "BudgetError"; this.reason = reason; this.details = details; }
}

// A deliberately high estimate of what one call costs, in USD, used only to decide whether it may start. Published pay-as-you-go
// prices are a base per request plus a small amount per returned item; the item count is the `limit` (or `depth`) asked for.
// The real cost always comes from the response and is what the ledger records. Unknown endpoints get a flat, generous estimate.
const ESTIMATES = [
  [/^serp\//, { base: 0.003, per: 0.0004, items: (t) => Number(t.depth) || 10 }],
  [/^dataforseo_labs\//, { base: 0.02, per: 0.0002, items: (t) => Number(t.limit) || 100 }],
  [/^backlinks\//, { base: 0.03, per: 0.0001, items: (t) => Number(t.limit) || 100 }],
  [/^keywords_data\//, { base: 0.1, per: 0, items: () => 0 }],
];
const FALLBACK_ESTIMATE = 0.1;

/** Conservative USD estimate for one task of `path` (for example "dataforseo_labs/google/keyword_ideas/live"). */
export function estimateCost(path, task = {}) {
  const hit = ESTIMATES.find(([re]) => re.test(path));
  if (!hit) return FALLBACK_ESTIMATE;
  const { base, per, items } = hit[1];
  return Number((base + per * items(task || {})).toFixed(6));
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const monthOf = (d) => d.toISOString().slice(0, 7);
const dayOf = (d) => d.toISOString().slice(0, 10);
const usd = (n) => `$${Number(n).toFixed(2)}`;

/** The ledger file of a site: <state>/dataforseo-ledger.json. */
export const ledgerFile = (site) => `${site.paths.state}/dataforseo-ledger.json`;

/** A ledger kept in a JSON file. load() always re-reads, so two guards in one process never overwrite each other. */
export function fileLedger(file) {
  return { load: () => readJson(file, null) || { version: 1, months: {}, alerts: {} }, save: (data) => writeJson(file, data) };
}
/** A ledger in memory (tests, one-off scripts). */
export function memoryLedger(initial) {
  let data = initial || { version: 1, months: {}, alerts: {} };
  return { load: () => JSON.parse(JSON.stringify(data)), save: (d) => { data = JSON.parse(JSON.stringify(d)); }, get data() { return data; } };
}

/** Add one paid call to a ledger object (pure apart from mutating `ledger`). */
export function addToLedger(ledger, { month, job, endpoint, cost, estimated = false }) {
  const m = (ledger.months[month] ||= { usd: 0, calls: 0, jobs: {} });
  const j = (m.jobs[job] ||= { usd: 0, calls: 0, endpoints: {} });
  const e = (j.endpoints[endpoint] ||= { usd: 0, calls: 0 });
  for (const x of [m, j, e]) { x.usd = round(x.usd + cost); x.calls += 1; }
  if (estimated) m.estimatedCalls = (m.estimatedCalls || 0) + 1;
  return ledger;
}

/** What a response says it cost: the top-level `cost`, else the sum of the tasks' costs, else null. */
export function costOf(json) {
  if (Number.isFinite(Number(json?.cost)) && json?.cost != null) return Number(json.cost);
  const tasks = (json?.tasks || []).filter((t) => t && Number.isFinite(Number(t.cost)) && t.cost != null);
  return tasks.length ? tasks.reduce((s, t) => s + Number(t.cost), 0) : null;
}

const authHeader = (env) => `Basic ${Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64")}`;
export const dataforseoEnabled = (env) => Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);

/**
 * Create a cost guard for one run of one job.
 *   cfg        { monthlyCapUsd, minBalanceUsd } (the site's `dataforseo` block; defaults 8 and 10)
 *   job        the job name, for the ledger ("keywords", "rank", ...)
 *   env, fetch DataForSEO credentials and transport
 *   ledger     { load, save } (fileLedger(ledgerFile(site)) in real runs)
 *   label      first words of an alert, usually the site's host
 *   notify     async (text) => { sent, messageId?, reason? }; default: Telegram from env (TELEGRAM_*), silent no-op when not set
 *   getBalance async () => USD; default: the live free endpoint (override for tests)
 *   now        () => Date
 */
export function createCostGuard({ cfg = {}, job = "unknown", env = process.env, fetch: f = globalThis.fetch, ledger, label = "", notify, notifyFetch, getBalance, now = () => new Date() } = {}) {
  if (!ledger) throw new Error("createCostGuard: a ledger is required (fileLedger(ledgerFile(site)) or memoryLedger())");
  const cap = cfg.monthlyCapUsd ?? DEFAULT_CAP_USD, floor = cfg.minBalanceUsd ?? DEFAULT_MIN_BALANCE_USD;
  let cached = null; // { value, at }
  let inflight = 0;
  const alertedThisRun = new Set();
  const send = notify || ((text) => sendTelegram(text, { env, fetch: notifyFetch || globalThis.fetch }));

  async function readBalance() {
    if (cached && now().getTime() - cached.at < BALANCE_TTL_MS) return cached.value;
    let value;
    if (getBalance) value = Number(await getBalance());
    else {
      let r;
      try { r = await f(`${BASE}appendix/user_data`, { headers: { Authorization: authHeader(env) }, signal: AbortSignal.timeout(30000) }); } catch (e) { throw new Error(`request failed (${e.name || "error"})`); }
      if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 401 || r.status === 403 ? " (key rejected)" : ""}`);
      const j = await r.json();
      value = Number(j?.tasks?.[0]?.result?.[0]?.money?.balance);
    }
    if (!Number.isFinite(value)) throw new Error("no balance in the response");
    cached = { value, at: now().getTime() };
    return value;
  }

  async function alertOnce(reason, text) {
    if (alertedThisRun.has(reason)) return;
    alertedThisRun.add(reason);
    try {
      const day = dayOf(now()), l = ledger.load();
      if (l.alerts?.[day]?.includes(reason)) return;
      const r = await send(`${label ? `${label} | ` : ""}${text}`);
      if (!r?.sent) return; // not configured or failed: try again on the next run, never block on it
      l.alerts = { [day]: [...(l.alerts?.[day] || []), reason] }; // older days are dropped
      ledger.save(l);
    } catch { /* an alert problem must never hide the BudgetError */ }
  }

  async function block(reason, message, details) {
    await alertOnce(reason, `DataForSEO paused: ${message} Job: ${job}. No request was sent.`);
    throw new BudgetError(`dataforseo: ${message}`, reason, details);
  }

  const guard = {
    cap, floor, job,
    /** This month's recorded spend in USD. */
    spent: () => ledger.load().months[monthOf(now())]?.usd || 0,
    /** The live balance in USD (cached 10 minutes). */
    balance: readBalance,
    /**
     * POST one or more tasks to a DataForSEO endpoint (path after /v3/, for example "serp/google/organic/live/advanced").
     * Throws BudgetError before any request when the call is not allowed. Returns the parsed response.
     */
    async post(path, tasks) {
      if (!dataforseoEnabled(env)) throw new Error("dataforseo: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set");
      const list = Array.isArray(tasks) ? tasks : [tasks];
      const est = round(list.reduce((s, t) => s + estimateCost(path, t), 0));
      const spent = guard.spent();
      const others = inflight; // estimates of calls already started and not finished
      if (spent + others + est > cap) {
        return block("monthly-cap", `this month's spend ${usd(spent)} plus about ${usd(est)} for this call would pass the monthly cap of ${usd(cap)}.`, { spent, estimate: est, cap });
      }
      inflight += est; // reserved before the first await, so parallel calls see each other
      let json;
      try {
        let balance;
        try { balance = await readBalance(); }
        catch (e) { return await block("balance-unavailable", `the account balance could not be read (${String(e.message).slice(0, 80)}), so no paid call is made.`, { cause: e.message }); }
        if (balance - others - est < floor) {
          return await block("min-balance", `the account balance ${usd(balance)} would fall under the floor of ${usd(floor)}.`, { balance, estimate: est, floor });
        }
        let r;
        try { r = await f(`${BASE}${path}`, { method: "POST", headers: { Authorization: authHeader(env), "Content-Type": "application/json" }, body: JSON.stringify(list), signal: AbortSignal.timeout(30000) }); }
        catch (e) { throw new Error(`dataforseo: request failed (${e.name || "error"})`); }
        // A paid response may still carry a cost on an error status: record it when the body is readable.
        json = await r.json().catch(() => null);
        const real = costOf(json);
        const cost = real ?? (r.ok ? est : 0);
        if (cost > 0 || r.ok) {
          const l = ledger.load();
          addToLedger(l, { month: monthOf(now()), job, endpoint: path, cost, estimated: real == null });
          ledger.save(l);
          if (cached) cached.value -= cost;
        }
        if (!r.ok) throw new Error(`dataforseo: HTTP ${r.status}${r.status === 429 ? " (rate limited)" : r.status === 401 || r.status === 403 ? " (key rejected)" : ""}`);
      } finally { inflight -= est; }
      return json;
    },
    /** `post` for one task: returns { json, task, items } with the task status already checked (a non-20000 task throws). */
    async task(path, task) {
      const json = await guard.post(path, [task]);
      const t = json?.tasks?.[0];
      if (t && t.status_code && t.status_code !== 20000) throw new Error(`dataforseo: task status ${t.status_code}`);
      return { json, task: t, items: t?.result?.[0]?.items || [], result: t?.result?.[0] || null };
    },
  };
  return guard;
}

/**
 * The guard for one job run on one site: an injected one (tests, `deps.guard`) or a real one that keeps its ledger in the
 * site's state folder and alerts through TELEGRAM_* when it blocks.
 */
export function costGuardFor(site, job, { env = process.env, fetch: f = globalThis.fetch, guard, notify, now } = {}) {
  if (guard) return guard;
  let host = site.id || "";
  try { host = new URL(site.url).hostname.replace(/^www\./, ""); } catch { /* keep the id */ }
  return createCostGuard({ cfg: site.dataforseo || {}, job, env, fetch: f, ledger: fileLedger(ledgerFile(site)), label: host, notify, now });
}

/** The error a DataForSEO caller gets when it was not given a guard. Callers must pass one: there is no unguarded path. */
export function requireGuard(guard, who = "dataforseo") {
  if (!guard || typeof guard.post !== "function") throw new BudgetError(`${who}: no cost guard given. Every DataForSEO call goes through createCostGuard / costGuardFor (src/lib/dataforseo.mjs); nothing is called without one.`, "no-guard");
  return guard;
}

/** Plain-text summary of a month in the ledger for reports: "2026-11: $0.42 in 9 calls (rank $0.30, keywords $0.12)". */
export function ledgerSummary(ledger, month) {
  const m = ledger.months?.[month];
  if (!m) return `${month}: $0.00 in 0 calls`;
  const jobs = Object.entries(m.jobs).map(([j, v]) => `${j} ${usd(v.usd)}`).join(", ");
  return `${month}: ${usd(m.usd)} in ${m.calls} calls${jobs ? ` (${jobs})` : ""}`;
}
