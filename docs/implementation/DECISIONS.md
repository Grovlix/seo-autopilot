# Decisions

## 2026-10-18 Phase 0 architecture decisions (PROPOSED, awaiting owner review; nothing is built)
Evidence: `PHASE-0-AUDIT.md` (same folder). D1 to D11 were written from the SEO Autopilot audit. D12 to D15 were added after Marketing Mouse, News to Blog and Keel were audited later the same day (PHASE-0-AUDIT §5). Neither source audit overturned D1 to D11. Nothing here commits to a vendor or spends money.

**D1 Hosted boundary.** The hosted app is a separate package (proposed: `cloud/` in this repository, with its own `package.json`, excluded from the npm `files` list). It calls the engine through a typed job contract; the engine is never rewritten into the app.
- Stage 1: a worker runs the unchanged CLI (`bin/seo-autopilot.mjs run <job> --site <id>`) in an isolated temp directory. Config is rendered from DB rows and credentials are injected as env. The worker reads the JSON reports and stores them as versioned results (job, engine version, site, source window, generatedAt, input hash).
- Stage 2: add a `StateStore` seam to `src/jobs/*` so jobs read and write through an interface; the file store stays the CLI default. The core stays dependency-free.
- Alternatives: (a) rewrite the analysis in the app's language, rejected because it means two sources of truth and loses the tests. (b) GitHub App only, with no servers (brief 07 option a): cheapest, but repository sites only and no central evidence store. Recommended as the first *distribution* mode, not the hosted product.
- Migration: none for CLI users.
- Web stack and where jobs execute: see D13.

**D2 Tenancy and ownership.** Model: workspace → client → site → environment (production, staging).
- `memberships(workspace_id, user_id, role)` with roles owner, admin, editor and viewer, plus optional client-scoped grants for agency staff and client viewers.
- A site is *verified* only by evidence stored with method and time. Options: the Search Console API returns the property with `siteOwner` or `siteFullUser` for the connected Google identity; a GitHub App installation on the repository with admin permission; or a DNS TXT token.
- `property_bindings(site_id, provider, external_id, verified_at, method)` ties GSC, GA4 and repository IDs to one site. A job refuses to run against an unbound or unverified external ID.
- Alternative: trust the configuration, as the CLI does today. Acceptable for a single owner, unacceptable for agencies.

**D3 One metadata store.** Postgres, as the single source of truth for: workspaces, memberships, clients, sites, connections, property_bindings, jobs, runs, findings, recommendations, sources, content_drafts, change_sets, approvals, publications, measurements, usage_events and audit_events.
- Every tenant row carries `workspace_id`. Child tables use composite foreign keys `(workspace_id, parent_id)` so a row cannot point at another workspace's parent.
- Results are append-only with engine version and source timestamps.
- Supabase is acceptable (Postgres plus auth). The existing `templates/dashboard-supabase` schema is **not** a base, because it is single-tenant (audit F5).
- Alternatives: keep state in each customer's `seo-data` branch (no cross-site view, no audit trail, force-pushed history); a document store (weaker integrity for the ownership chain).

**D4 Credentials.** Credentials stay on the server and are never sent to the browser.
- Google: OAuth with the minimal read scopes `webmasters.readonly` and `analytics.readonly`. Store refresh tokens encrypted with envelope encryption: a data key per workspace, wrapped by a KMS or secret-manager key kept outside the database (Supabase Vault or a cloud KMS; vendor open). Refresh on use, record failures as connection health, revoke on disconnect.
- The service-account JSON stays supported (encrypted the same way).
- GitHub: App installation tokens (short-lived, per repository), never personal tokens.
- AI keys and provider keys are bring-your-own, stored encrypted, and used only inside the worker job that needs them.
- Engine change needed: `src/lib/google-auth.mjs` accepts an injected access-token provider.
- Alternative: plain DB columns protected by RLS. Rejected: a service-role leak exposes every token.

**D5 Durable jobs.** A Postgres job table, claimed with `FOR UPDATE SKIP LOCKED`.
- Columns: `lease_expires_at`, heartbeat, `attempts`, `max_attempts`, exponential backoff with jitter, a unique `idempotency_key` (for example `site:job:window`), `cancel_requested`, and a terminal status with an error.
- A reaper re-queues expired leases after a restart.
- Side-effecting steps (publish, open PR) are separate jobs keyed by change-set hash, so a retry cannot duplicate them.
- The scheduler tick is authenticated with an HMAC over timestamp and nonce, rejected outside a five-minute window, and the nonce is stored to block replay. The platform cron secret is not trusted alone.
- Alternatives: pg-boss or Graphile Worker (fine; the hosted app may have dependencies); cloud queues (another moving part); GitHub Actions as the executor (stage-1 option for repository sites only).

**D6 Access boundaries beyond RLS.**
- Every endpoint resolves user → membership → workspace and checks the role *before* any query, using a user-scoped DB client where possible.
- The service-role client is allowed only in workers. Workers take `workspace_id` from the claimed job row and assert it on every query.
- RLS stays on as a second layer.
- Required tests for the Phase 1 gate: for each endpoint and worker, a second workspace cannot read or mutate through the UI, the direct API or a forged job payload.

**D7 Publishing interface and approvals.**
- Interface: `Publisher.plan(changeSet) → diff`, `apply(changeSet, approval) → receipt`, `verify(receipt) → live state`, and optional `rollback(receipt)`.
- An approval stores the SHA-256 of the canonical change set plus destination, operation and schedule. `apply` recomputes the hash and refuses on mismatch, so any edit invalidates the approval.
- First adapter: GitHub PR, built from the existing `seo-implement` path. The receipt is PR number, head SHA, check conclusion and merge SHA.
- Auto-merge is never available in the hosted product (audit F1).
- WordPress comes second, after the gate (brief 06 via brief phase 4).

**D8 Agents vs deterministic work.** Unchanged from the engine. Code handles collection, checks, routing, approval and publishing. Models handle bounded reasoning and drafting, with turn and budget caps and a recorded cost. Roles need not be separate processes.

**D9 Cost model.**
- `usage_events(workspace_id, site_id, job_id, provider, unit, quantity, unit_cost, cost_source)`. `cost_source` is one of `provider_reported`, `price_sheet_YYYY-MM-DD` or `estimate`.
- Categories: crawl (fetches and bytes), Google API quota, SERP calls, AI tokens, storage, compute minutes and retries.
- Hard quotas per workspace; stop and report when reached.
- No prices are stated anywhere until measured. KPI: cost per active site and per completed approved action.

**D10 Migration and compatibility.** CLI and GitHub Actions users are unaffected. An importer reads a repository's `seo-data` branch into the hosted store, as read-only historical results. No destructive change to existing templates. The Supabase example stays as is.

**D11 OSS approval semantics (owner decision).** Owner to choose one:
- (a) keep `seo-automerge.yml` and `seo-release.yml` as they are, documenting that they do not meet the hosted product's approval standard;
- (b) deprecate auto-merge and make release open a PR;
- (c) keep both, and add an approver-permission check to `seo-implement.yml` (audit F2).

Recommendation: (c) now, then (b) at the next minor release.

**D12 One Google data contract (decided by the source audit, PHASE-0-AUDIT §5).** This engine's Search Console and GA4 code (`src/lib/google-auth.mjs`, `src/jobs/daily.mjs`) is the single source of truth. Marketing Mouse's derived metrics are ported into `src/analysis/` with tests; its token handling and queries are not. Reasons:
- MM fetches tokens without ownership checks (M2).
- MM uses a platform-wide connector (M4).
- MM pages less and has no tests.

**D13 Hosted UI stack and the execution split (proposed).** Use TanStack Start, React and Supabase for the hosted UI and API, because the reusable UI from both source apps is written in it. The server layer is new and follows D6; neither app's server functions are carried over (M1, N1, N2).
- Engine jobs do **not** run in Cloudflare Workers: the CLI spawns git, Go and Python, and writes files. Jobs run in a separate Node worker (a container or VM) that claims jobs from Postgres (D5).
- Alternatives: a plain Node server (fewer moving parts, but the UI would have to be rewritten), or the Workers runtime only (cannot run the engine).
- Cost: one more deployable unit.

**D14 Source code provenance.** Code copied from Marketing Mouse or News to Blog comes in only as small reviewed files, adapted to this repository's style, with tests. The owner must confirm in writing (in this file) that they own that code and relicense it under MIT, because neither repository has a licence. Lovable-generated scaffolding is acceptable once the owner confirms the platform's terms allow it.

**D15 Security issues in the source apps (owner decision, outside this repository).** M1 to M5 and N1 to N6 are live risks *if those apps are deployed*; this audit could not tell whether they are. Recommendation: the owner checks whether they are deployed and, if so, restricts them (fix N1 and N2 first, then M1 and M2) or takes them offline, before marketing them. This repository will not copy their server code, whatever is decided.

**Keel:** separate product; see PHASE-0-AUDIT §5.3. No code dependency in either direction.

## 2026-11-08 D37 Verified execution through the site's own GitHub workflow (R1-E1)
**Context:** the spec's execution chain (§3, §5): approved work must reach the website through a reviewed, verified and reversible change. The owner asked for build progress without new platforms. Sites that run SEO Autopilot already have `seo-implement.yml`. It drafts a pull request from an approved issue, edits content files only, never runs builds, and passes through `seo-check`, `seo-review` and the merge policy of D17.

**Decision:**
- The hosted SEO God never edits a website. For a site with a connected repository, the agency picks a recommendation from accepted advice ("Prepare a pull request"). A deterministic work order is drafted, which is free and needs no approval to start. The agency approves that exact text (the D35 adoption pattern).
- On approval, the scheduler opens an issue in the site's repository (labels `seo-proposal`, the change kind, `seo-hosted`) and starts `seo-implement` with that issue. The issue number is saved before the workflow starts, so a retry never opens a second issue.
- It then follows the pull request on branch `seo/issue-<n>`.
  - Merged: move to verifying and request a fresh scan.
  - Closed unmerged, or no pull request after 7 days: escalate to a person.
  - Open: wait, because the merge stays with a person or the site's policy.
- Verification compares the page's problems in the first scan after the merge with the baseline taken when the issue was opened. New high-severity problems escalate, naming the pull request to revert. Otherwise the job completes with what was fixed.
- Credentials (rule 6): the agency's own fine-grained token for that one repository (Issues and Actions read/write; Pull requests and Metadata read).
  - It is stored in Supabase Vault. Only an agency owner can set or remove it.
  - Only the service role can read it, and only for a connected site. It is never returned to a browser.
  - Repository names are validated, and `.` and `..` are refused.
- The recommendation text is quoted in the issue as data. HTML comment markers are stripped, so nothing can hide in the issue body.

**Tradeoffs:**
- Only sites whose code is in GitHub and that run SEO Autopilot's workflows can be changed. Address-only sites stay advice-only (D29).
- Verification is audit-based. It shows whether problems went away, not traffic impact; Search Console measurement (D33) covers that where connected.
- Rollback is the GitHub revert of the named pull request: a person's action, deliberately not automatic.

**Evidence:** `test/github-execution.test.mjs`, `rls16.sql`, `portal-github.test.mjs`, and the workerd end-to-end run. That run drives the whole path against the real migrations with a GitHub stand-in: drafted, approved, issue and dispatch, merged, re-scanned, "1 of 1 problems fixed", and the token appears in no job, output or log.

## 2026-11-08 D38 Notifications derived from the work; monthly work report; team page by department
**Decision:**
- Notifications are computed live from the work itself:
  - for agencies: approvals waiting, work needing a person, client requests, changes verified or stopped, integration and planning errors;
  - for client accounts: answers to their own requests.
  - Only "seen up to" is stored per person.
  - No email provider: Q7 is open, and the portal inbox is the channel.
- The monthly work report is for the agency and the site's client accounts. It lists advice accepted, changes and their verification, requests answered, and the audit at the start and end of the month. It contains nothing internal: no costs, agents, analysis or reviews. Anonymous share links keep the existing report without it.
- The team page shows the director plus the master spec's eight departments, taken from `src/god/departments.mjs` (each agent exactly once), with 30-day work per department and specialist.

**Tradeoffs:** a derived inbox cannot be dismissed item by item. It empties as the work is handled, which keeps it honest.

## 2026-11-16 D63 Agent quality pass (built, not deployed)
Follow-up to the 2026-11-16 agent audit (issues 5, 10, 13 and 15, "Weak agents" and "Facts"). Scope set by the owner:
no new product features and no redesign.

**Decision (what changed and why):**
- **Evidence rule in every agent.** Each of the 38 agent files has a `## Evidence` section (before `## Never`): every
  claim cites the data or URL it comes from (named in the agent's own terms), and verified facts, assumptions and
  missing information stay apart. The seven agents that never mentioned evidence (technical fixer, migration planner,
  schema engineer, ecommerce, local content writer, GBP optimizer, review manager) also get one agent-specific line.
  `test/agents.test.mjs` enforces the section for every agent.
- **Output that fits the hosted reply.** Those seven agents' Output sections now say how they map onto the hosted JSON
  reply (`summary`, at most 8 `recommendations`, `claims`, `questions`; `src/god/agent-runner.mjs` SYSTEM_TAIL) and what
  is out of scope there (pull request bodies, files changed, verification runs, full redirect maps, drafted post
  calendars, template sets, comparison tables). The GBP optimizer was trimmed: no "4 drafted posts", "10 Q&A seeds" or
  competitor table; competitor work only with local-pack data. The CLI (edit-mode) output stays as it was.
- **Fact-checker by agent, not by folder (audit issue 5).** Front matter `publishable: true` marks agents whose output
  drafts text a person could publish; `needsSecondOpinion` uses it with the job's risk. Marked: the six content agents
  (unchanged coverage) plus local content writer, AI-search agent, schema engineer, GBP optimizer, entity reputation and
  local review manager (12). The Worker bundle carries `PUBLISHABLE` (built by `cloud/worker/build.mjs`, gitignored,
  rebuilt on deploy) and the Worker passes `publishableOf`.
- **Exam cases (written, not run).** Four cases in `exams/cases.json` on the existing plumber fixture: fact-checker
  (planted claims in a draft), SERP analyst (no rank data), indexing monitor (a page Google dropped, a stand-in URL
  inspection row), redirect guardian (no redirects to the home page; approval prefix). `npm test` grades each case's good
  and bad sample and checks the fact-checker and every alert agent has a case. No paid run.
- **Dismiss in the portal.** "Needs a person" on the SEO God page has a Dismiss button (agency mode only; the page is
  agency-only already) that asks for confirmation and calls the existing `dismiss_job` RPC (migration 20261124000000).
- **Exam results in the portal (audit issue 10/13).** The portal build reads `exams/latest.json` (a local run) and then
  the committed `docs/implementation/exams-latest.json`. That file holds exam run 3 only as recorded: 12 of 14, $1.88,
  2026-11-13, Actions run 43348165017. Per-agent pass counts are derived from D53 (the agents that passed every case are
  named; 2 failures leave the AI-search agent and the refresher, 1 case each) and the case file at fd76894; the model is
  the workflow default at that commit. Per-agent cost was not recorded, so it is null and the portal says so. The
  workflow still commits nothing; `docs/evals.md` says how a person commits the next summary.

**Tradeoffs and risks:** marking six more agents publishable adds one fact-checker call to their runs (about one more
model call per run, from the same job budget); a run that cannot afford it escalates to a person. The Evidence section
adds about 400 characters to every agent prompt. The committed exam summary predates D56-D63 prompt changes and says so;
it should be replaced after the next real run. The new cases were never run on a model, so their checks may need the same
grader fixes the first cases needed (D51-D53). Deviation: the brief listed five agents for the fact-checker; the local
review manager was added too because its Output drafts review request and response templates (publishable text).
**Smaller alternative not taken:** adding "content" to more folders in `SECOND_OPINION_DEPARTMENTS`; a folder still
mixes agents that publish text with agents that do not.

## 2026-11-16 D62 Pilot hardening (built, not deployed)
Three read-only audits on 2026-11-16 (operating cycle, agents, portal; local stand-ins only) found defects that would
make the pilot stall, overspend, mislabel work or mislead the agency. The owner asked for the smallest reliable fix of
each listed item, each with a test that fails before and passes after; no redesign, and no change to automatic Google
linking trust, the shared AI key model, cron, pause switches or budgets.

**Decision (what changed and why):**
- **Lifecycle.** Gated work in `scoped` (after "request changes", or a planning run that stopped between scoped and
  awaiting_approval) goes back to `awaiting_approval`; when it had already run, it is marked `outputs.redo`, so the next
  "approve" re-runs it instead of accepting the old result. The budget reservation counts only work that can still
  spend (`canStillSpend`): escalated, failed and finished results waiting for a decision hold nothing. A review "fail"
  ends `escalated` (visible as needing a person), not silently `failed`. New agency-only RPC `dismiss_job` closes
  escalated or failed work as `cancelled` with an audit row (no portal button yet).
- **Agents.** The planner passes the router's `prompt` as the instruction and its `targets`. A retry after
  `needs_changes` carries the reviewer's reasons (`outputs.reviewFeedback`, sent as `<review_feedback>`), and AI work
  runs at most 2 times on review retries. The quality gate checks advice: recommendation addresses on the site's host,
  evidence on every recommendation, every number or factual claim (via `findClaims`) present in a claim with a source,
  and the "After a person approves:" prefix on remove/noindex/redirect/merge/delete/disavow. These ask for changes; they
  never hard-fail. The compact profile keeps the home-page signals, and the router skips the markup rule without them.
  The Worker plans with the bundled agent registry (`EDITS` from tools), so risk and department are right.
- **Safety.** Hosted pull requests are held when the work-order marker (`<!-- seo-god-job:`) is in the PR or issue
  body, or the `seo/issue-<n>` branch's issue carries `seo-hosted`; seo-implement fails when copying `seo-hosted` fails.
  The worker can never authorize an `implement` job (JS `canMove` and SQL `transition_job`), and `create_job` refuses
  the kind for signed-in callers (`request_implementation` creates its draft itself). No write privilege for anon or
  signed-in users on `god_control`, `god_runs`, `platform_admins`. Share links return the same client-safe snapshot as
  `client_sites`.
- **Portal.** Empty Supabase settings refuse to build unless explicitly allowed. Truthful states: 72-hour scan rule,
  specialists off while paused, real site status, Waiting links to the SEO God page, errors instead of "nothing yet",
  client accounts kept off agency routes, Google Remove for the agency only, one AI-key phrase, corrected texts.
- **Run records.** The god_runs row is written at the start of a run (`start_god_run`, marked as not finished) and
  completed at the end (`record_god_run` with the id); the local e2e uses a notify stand-in and asserts no run errors.

**Deviation from the brief (C1):** the brief said a `seo/issue-*` branch alone counts as hosted. The site's own
autopilot (D17) also drafts on `seo/issue-<n>` branches (`templates/workflows/seo-autopilot.yml`), so that rule would
stop every autopilot merge on every site. The branch counts only together with a `seo-hosted` issue; the marker counts
on its own. An unreadable issue holds the change (fail closed).

**Tradeoffs and risks:** the stricter gate can send real advice back more often (one paid retry, then a person); the
exams have not been re-run since D56/D57 and should be before judging it. The destructive-verb check matches anywhere in
a title ("Remove the noindex tag" needs the prefix too): a false positive costs one retry, never a silent change. The
2-attempt cap covers review retries; errors thrown by a handler still use the database cap (`max_attempts`, default 3).
16 editing agents now plan as medium risk: their advice must pass review to leave it (it always gets one); approval
gating is unchanged. A run in progress shows one "did not record its end" error on Operations until it finishes.
**Smaller alternative not taken:** hiding "Request changes" for gated work instead of re-routing it; it would leave
crashed planning runs stuck.

## 2026-11-16 D61 Automatic Google linking (built, not deployed)
The owner, 2026-11-16: connecting Google must be automatic and impossible to miss. Observed in production: 3 live sites
whose owner had already added our service account to Search Console had no binding, because a site got Google data
only after a signed-in user pressed Check access and picked a property (D56). The engine never read them.

**Decision:**
- **A free, low-risk job `google_autolink`** (`src/god/google-access.mjs`, `makeAutolinkHandler`):
  - Planned at most once a day per live (not paused) site with no Search Console binding. The planner makes one
    database call (`google_autolink_due`: not paused, unbound, not tried today, not removed by a person) and no Google call.
    Priority 3, so a new site's scan and strategy draft go first.
  - The job lists what the service account can read for the host with the D56 code (`accessFor`), picks with the pure
    `autoPick`, and calls the service-role RPC `google_autolink`.
- **What is bound without a person** (`autoPick`): for Search Console, the first tier with candidates decides, and it
  must have exactly one: (1) the domain property of the site's own host; (2) the URL-prefix property with the site's own
  scheme and host (www counts) whose path the site address starts with; (3) a parent domain property. Several in that
  tier, or only other forms (http for an https site, the other www form, a path prefix), bind nothing and give a reason.
  For GA4: exactly one property with a web stream on the host, and the listing was complete (past the 30-property cap,
  only a single find named like the site).
  - Deviation from the brief's order ("domain, then https prefix"): for a subdomain site, its own https prefix comes
    before a parent domain property, because the parent's data covers the whole domain.
- **Same rules as Check access** (migration 20261123000000):
  - `private.google_refusal` holds the checks; `bind_google` was rewritten on it (same messages and order), and
    `google_autolink` uses it. The checks: the pick is in the stored list for this site and covers its host; one property
    per website across every agency and one Search Console binding per host (D56 constraints, also on a race); the D34
    rule for a host another agency registered (needs a platform admin's `set_gsc_allowed`).
  - The database adds one guard of its own: an automatic URL-prefix pick must have the site's own scheme and host.
  - It never replaces an existing binding, whoever made it.
  - Refusals go to `google_binding_conflicts` and the audit log (`user_id` null), at most once a week per site,
    property and reason, so daily retries do not flood the admin.
- **Audit:** `google_bindings.bound_via` ('person' or 'auto'; `bound_by` stays null for auto) and an audit row
  `google.autolink`.
- **A person's choice wins:** removing Search Console (or saving "None" while properties were offered) sets
  `gscRemovedAt`, and automatic linking stops for that site until a person picks a property again.
- **After a link:** the job queues the day's `search_snapshot` (the planner's idempotency key, so never twice), so the
  first read runs in the same scheduler run. Priorities, index status, the scorecard and the D60 re-draft follow at
  the site's next planning, as for any site with data.
- **Portal:**
  - Connections shows one of: "Linked automatically" (or "Linked") with the properties and a Change button that opens
    the D56 step; "Add our email in Search Console" with the email, Copy and the steps; or "Pick a property" with the
    reason.
  - The Portfolio shows the same state per website and a banner while any live website has no Search Console data,
    with the email, Copy and the list.
  - State from `private.google_link_state` (`site_google.link`, `portfolio_google`).
- **CPU:** the Google calls are in the job, as the D56 Check access route already does them in a Worker request. Node V8
  estimate with a 200-property account: about 3 ms warm for the listing and pick (mocked responses, token signing not
  included). Not measured on Cloudflare.

**Security:**
- Automatic linking gives the same trust as pressing Check access, nothing more. The binding goes to whoever
  registered the host first, and only for a property whose owner granted our service account.
- The D56 residual risk is unchanged in kind, but it is now reached without a click:
  - Someone registers a domain they do not own. If its real owner had already added the service account (for a site
    in another agency, which the D34 rule catches, or before registering here) and had not bound it yet, the property can
    be linked to the wrong site.
  - Exclusivity and conflict recording are kept, so the real owner sees "already connected to another website" and the
    platform admin sees the refusal and can release the binding (`release_google_binding`).
- The service-role key stays in the Worker. `google_autolink` and `google_autolink_due` are granted to `service_role`
  only, and the browser cannot call them (rls29).

**Tradeoffs:**
- One extra database call per site planning.
- One Search Console listing, one GA4 account listing and up to 30 web-stream lookups per unbound site per day,
  against the shared quotas.
- The daily retry means a site's state can lag by up to a day after the owner adds the email. Check access still works
  at once.

**Evidence (stand-ins only, no real Google call):**
- `test/google-autolink.test.mjs`: pick cases, job, planning.
- `test/portal-autolink.test.mjs`: Chromium.
- `cloud/portal/supabase/test/rls29.sql`.
- `scripts/cf-local-e2e.mjs`, D61 section: nothing is bound while nothing is visible; linked automatically with GA4;
  the first read runs in workerd; dependants next planning; ambiguous site gives "Pick a property"; once a day.

## 2026-11-16 D60 Demand-driven strategy draft, re-drafted once while unapproved
On the pilot (erudience.com) the hosted `strategy_proposal` produced audit hygiene as first steps ("Long sentences (7
pages)", "Very little visible text (6 pages)", a www redirect), no objective, generic KPIs ("Search Console clicks (needs
access)") and "8 questions open". A practitioner would reject it: a plan should start from real demand. Live sites
drafted before this (owner: Excel, Manchester, AudioScriptor, still unapproved) carry that old format.

**Decision:**
- **New pure drafter** `src/god/strategy.mjs` (`draftStrategy`, `DRAFT_VERSION = 2`), called by `buildDossier`. Still
  deterministic and free (no AI call). It reads every report the hosted engine keeps: audit, profile, discovered facts,
  `search_console`, `history`, `inspect`, `speed`, `priorities`, and the business brief answers.
- **Objective** in plain English: the brief's goal verbatim (`objectiveBasis: "brief"`), else inferred and labelled
  (`"inferred"` with `objectiveWhy`): the priority services named in the brief, a local business ("More enquiries from
  people searching locally in <area>"), a shop, or the section of the site with the most non-home impressions.
- **Baseline** only from reports, with dates: clicks, impressions, CTR, position and the date range; brand vs non-brand
  clicks within the stored top queries (brand = distinctive words of the business name and the domain); top 5 pages and
  queries; last 7 days vs the 7 before; index status counts; audit counts by severity; speed. No Search Console: the
  baseline says so in plain words and step 1 is "Give Search Console access".
- **3 to 6 first steps, ranked by expected impact from data**, in this order: index problems (high-severity blocking
  audit rules, then pages Google has not indexed, the home page and pages with impressions first), striking-distance
  queries (non-brand, one step per page, query and page named), low CTR on a page with 100+ impressions, decay, then
  cannibalisation, then high-severity technical findings. Medium findings and a conversion-tracking step only fill up to
  3; low-severity hygiene, speed, Business Profile checks go to **"later"**. Every step names the specialist agent, a risk
  (low/medium/high; `agentRisk` for audit fixers, cannibalisation is high because it merges or redirects), evidence (URLs,
  queries, numbers, dates) and, for search steps, an estimate labelled as one.
- **KPIs** are objects `{ metric, baseline, target: grow|reduce|hold, reviewOn, text }`, review date = draft date + 28
  days (e.g. "Clicks to /services/x: from 5 in 28 days to grow; review on 2026-12-14"). No baseline is invented: without
  Search Console the click KPI says "baseline once access is given".
- **"What will not be done without you"**: every website change, site-wide changes and removals, outreach; sensitive
  topics (health, medical, legal, data protection, tax, finance from the site's own text or business type; safety and
  children are left to the page-level ymyl job because "emergency" would flag every plumber); Business Profile changes for
  local businesses; the brief's own restrictions. **Open questions** are a count plus the top 3 short brief labels.
- **CPU**: the drafter reads the search analysis from a priorities report ranked from the same or a newer snapshot
  (`buildPriorities` items now keep their analysis row as `metrics`) and only runs `searchInsights` (now exported from
  `insights.mjs`, shared with `prioritiesFrom`) itself when there is none. Sensitive-topic patterns compile once per
  isolate (6 patterns, not 40). Estimate (`node scripts/cf-measure-signals.mjs`, Node V8, largest synthetic site, fresh
  process, includes parsing the recall answer): draft 6.6 ms first / 2.4 ms warm (was 11.8 ms first before those two
  changes); planning a site unchanged (~3.5 ms first). The Worker Free limit is 10 ms; not measured inside Workers.
- **Re-drafting** without touching the job lifecycle: `strategyRedraftDue(jobs, memory)` returns the waiting job when the
  site's strategy in memory is **not approved**, a `strategy_proposal` job waits in `awaiting_approval`, the audit is in
  memory, and either the draft is older than `DRAFT_VERSION` (old drafts have no version: v1) or Search Console data
  exists and the draft was made without it. The tick then queues one free, low-risk `strategy_redraft` job (idempotency
  key `strategy_redraft:v2` or `strategy_redraft:v2:search-console`, so each happens once); with new search data it first
  waits for the re-ranked priorities. The job checks again (the agency may have decided since), rebuilds the dossier from
  memory (no crawl), runs the deterministic review gate, writes the strategy and questions to memory and replaces
  `outputs.proposal` on the waiting job with `record_job_output`. The job stays in `awaiting_approval`; nothing is
  approved; an approved strategy (memory status `approved`) is never re-drafted. Re-drafting is its own job, not part of
  planning, because planning plus a cold draft would pass the 10 ms Free limit.
- **Approval** (`withAnswers`) keeps the v2 shape: a goal answered later replaces an inferred objective (basis "brief"),
  a conversion answer becomes a KPI object, open questions are recounted. Old drafts keep the old behaviour.
- **Portal**: `strategyHtml` renders objective (with an "inferred" pill and why), baseline, ranked steps with agent,
  risk, expected effect and evidence, KPIs, "Later" (collapsed), what waits for you, open questions and risks. Old drafts
  (string KPIs, no baseline) still render. Every value is escaped (queries and URLs come from Google). New job kind label.
- **No migration**: `jobs.kind` is free text and `record_job_output` already exists.

**Tradeoffs and limits:** brand detection is a word match (a brand word inside a generic query counts as brand); non-brand
clicks are counted within the stored top 100 queries only (said in the KPI text). Striking-distance estimates come from
the site's own click curve and are labelled estimates. The objective inference is a heuristic and is labelled. The
re-draft replaces the draft the agency may already have read; the activity feed shows a completed "Strategy re-draft"
job. Tests: `test/strategy-draft.test.mjs` (11), portal render test in `test/portal-god.test.mjs`, D60 section in
`scripts/cf-local-e2e.mjs` (old draft re-drafted once in workerd and still waiting; approved strategy untouched).

## 2026-11-15 D59 Invite-only landing page and invite requests
The owner wants to start showing the hosted service to business owners and agencies with several websites. Until now a
logged-out visitor to seo.erudience.com got a bare sign-in form (`noindex`, robots.txt blocking everything), and the only
way in was an agency or client invite (D36, migration 20261108100000).

**Decision:**
- **Landing page in the same single file** (`cloud/portal/app/index.html`, `#landing`): static HTML in the initial
  document, so it is crawlable and readable without JavaScript. A one-line script in `<head>` sets `data-view` before the
  first paint (landing for a logged-out visitor on `#/` or a `#section` hash; the app otherwise), so a signed-in person
  never sees it flash; `render()` keeps it in step and a stale landing render never overrides a newer route. Signed-in
  agencies still land on Portfolio (D58); "Sign in" opens the existing email and password form (the portal does not use
  magic links). Same tokens and components as the app; no images, no external scripts, no trackers (the Geist web
  font from Google Fonts stays, as in the app). Title, meta description, canonical, Open Graph and `twitter:card`.
  `meta robots noindex` is removed: the app's pages are hash routes of the same URL and are not separate documents.
- **Content rule:** every sentence describes what the product does today (D17, D45, D50, D55 to D58) with the limits
  stated (Search Console delay, Full permission for index checks, "not enough data" on small sites, no ranking
  promises, pricing not published). No numbers, customers, quotes or awards. `test/portal-landing.test.mjs` fails on
  percentages, testimonial or award wording.
- **robots.txt and sitemap.xml** from `build.mjs` (`crawlFiles`) for `PORTAL_PUBLIC_URL` (default
  `https://seo.erudience.com`, https and no path only): the one URL in the sitemap; `Disallow: /previous-` keeps the
  kept-back copies out.
- **Invite requests** (migration 20261121000000): table `public.invite_requests` (RLS on, no policies, no grants to the
  API roles). `public.request_invite(name, email, company, sites, note, trap)` is anon-callable: trims and checks every
  field (name 1-100, email shape and 254, company or website 1-200, websites from a fixed list, note 1,000), a honeypot
  (`trap`, a hidden field: stored nothing, same answer), one row per email (a repeat counts `repeats`, never changes the
  first request or reopens a decision), at most 20 new requests an hour across the service (advisory lock; error code
  `PT429`, which PostgREST returns as HTTP 429). The answer is identical for new, repeated, existing-user and robot
  submissions, so it never reveals whether an email is known.
- **Platform admin view:** "Invite requests" on Operations (`invite_requests_list()`, `decide_invite_request(id,
  invited|declined|new)`, `private.is_platform_admin`). **Invited** extends the existing sign-up gate:
  `private.gate_signup` also accepts an email whose request is invited, and `private.on_new_user` then gives the new
  account its own agency. The existing agency invite (`public.invites`) was not reused because it joins the inviter's
  agency, which is wrong for a prospect. Nothing is emailed: the card shows the address and the sign-up link to copy.
- **Notification (D38):** platform admins get kind `invite_request` for each new request (≤30 days, until decided),
  through `private.notifications_for` (redefined with one added branch). It also reaches the daily summary email once
  SMTP is set.

**Not chosen:** a separate static landing site (two deployments, duplicated styles); emailing the invite from the
`notify` function (needs SMTP, still not set, and a new email kind); per-IP limits (PostgREST passes headers, but the
address behind Hostinger and Supabase proxies is not reliable enough to block on); a CAPTCHA (third-party script).

**Tradeoffs and risks:**
- The landing page describes D57 and D58 features (alerts, daily digest, scorecard, portfolio) that are built but **not
  deployed**; speed checks need `PAGESPEED_API_KEY`. Publish the page after those steps, or edit the claims.
- An invited prospect can only finish sign-up if Supabase Auth can send the confirmation email: custom SMTP is not set
  (owner item 5), and the built-in mailer only sends to the project's team.
- The global hourly limit can be used by one abuser to block other visitors for an hour; acceptable at invite-only scale.
- "We use these details only to answer your request" and "if we can invite you, we will email you" are commitments the
  owner should confirm.

**Evidence:** `cloud/portal/supabase/test/rls28.sql`, `test/portal-landing.test.mjs` (6 tests, 1 build-only + 5 in
Chromium), the D59 check in `scripts/cf-local-e2e.mjs`. Nothing is deployed or applied.

## 2026-11-15 D58 Portfolio screen and a scorecard for every change
The owner runs many websites and wants (1) one page with every website, the ones that need attention first, and (2) for
every change or piece of accepted advice, whether it moved Search Console. Until now the agency had to open each site, and
the only measure of advice was D33's 14-day traffic check on accepted advice (stored inside `experiment` items, not shown
as a list) plus the audit-based learning loop.

**Decision:**
- **Portfolio** (`public.portfolio()`, migration 20261120000000, the portal's landing page "Portfolio"): one row per
  website of the caller's agencies (`private.is_member`; nobody else gets rows; anon refused). Columns: clicks over the
  latest 28 days (`search_console` totals) and the change against the 28 days before, computed like-for-like from the
  `history` report's daily totals and shown only when both windows have at least 24 days (otherwise "–", about 8 weeks
  after the first snapshot); pages not indexed in the `inspect` report (redirects and alternates excluded; "refused"
  without Full permission); stale data (`private.site_freshness`, D57); today's alerts and planning errors (the site tick
  outcome); stopped work; approvals waiting; AI spend over 7 days; live/paused; win/loss counts. Sorted by a plain weighted
  score: stopped work and planning errors, alerts, stale data, clicks down 20% or more, changes that lost traffic,
  approvals waiting (more after 3 days), pages not indexed. The reasons are listed in words under each name. Paused
  websites go last. Phones get cards instead of the table.
- **Scorecard entries** (site memory, new kind `scorecard`, key `job:<id>`): written by the planner for each completed
  `agent:*` or `client_request` job whose recommendations name pages on the site's own host (at most 3, dated when the
  agency accepted the result) and each completed implementation (dated when its pull request was merged). When an
  implementation of earlier advice is merged, the advice entry is marked `supersededBy` and not counted, so one change is
  never scored twice. Jobs older than 180 days are not backfilled.
- **Scoring** (`src/analysis/scorecard.mjs`, pure): windows of 14 and 28 days before the change against the same length
  after it, starting 3 days after the change (Google recrawls; same lag as D33). Clicks are the measure; with fewer than
  20 clicks in both windows it is impressions, and the verdict says so. The rest of the site (site totals minus the
  pages, from `history`) is the control: the page's after-value is compared with what it would have had moving like the
  site. Win/loss at 15% or more either way and at least 5 clicks (or 50 impressions) of difference after allowing for the
  site, otherwise flat. `not_enough_data` below 50 impressions in both 14-day windows (100 for 28 days); `too_early` until
  the after-window is settled in Search Console (3 days' lag), with the date it will be ready. CTR and average position
  before and after are shown with every verdict. The headline is the 28-day verdict, else the 14-day one.
- **Where the data lives (the prune question):** each entry freezes its own before-baseline (pages and the rest of the site,
  per window) the first time the days before the change are in Search Console, and each window's verdict once its
  after-window is complete. A free `scorecard` job (`src/god/scorecard.mjs`) does this with ONE Search Console query per
  due change (the pages' daily rows from 28 days before to 28 days after, `dimensions: ["date"]`, an `equals` filter, or
  an anchored `includingRegex` for several pages), at most 8 changes per run, only when something is due and only for
  sites with Google access. Superseded scorecard copies are pruned after 14 days with the derived reports
  (`record_daily_digests`); the current entry holds everything.

**Not chosen:** a per-page daily report written by the daily snapshot. It would add a query and rewrite a report of
`pages x days` every day for every watched page (each day a new copy, pruned after 14 days), and its "before" days would
still age out of its own window for slow changes. Freezing on the entry costs at most three small queries per change over
its life and a few hundred bytes, and works the same for a change measured late. Computing verdicts in SQL was not chosen
either: the scoring has tests in Node and the Worker already holds the Google token.

**CPU (Workers Free, 10 ms):** scoring 8 changes with 62 days of data each: about 2.4 ms on the first call, under 1.3 ms
warm (Node V8 estimate, `aggregate` compares date strings instead of doing date arithmetic). Finding new entries among 100
completed jobs with 8 recommendations each: about 2.4 ms first call, under 1.5 ms warm; jobs already on the scorecard
are skipped before any parsing. This adds to the planning cost measured in D57 (7 to 11 ms cold for a large site), so a
cold isolate planning a large site with many fresh jobs is closer to the limit; Workers Paid removes the risk.

**Tradeoffs:**
- Directional, not a controlled test: the control is the rest of the same site, not matched pages, and other changes,
  seasonality and Google updates can explain a result. The portal says so on the scorecard.
- Advice is dated when it was accepted, not when (or whether) someone made the change. A merged change is dated exactly.
- Small sites will see many "not enough data" verdicts. That is the honest answer.
- Sites without hosted Google access (GitHub-run data only) get entries but no verdicts: the scorecard job needs the
  service account. The list says Search Console must be connected.
- Thresholds (15%, 5 clicks, 50/100 impressions, 20 clicks) are first guesses for small sites; tune on real results.
- Nothing is verified against real Google yet: unit tests with mocked responses, the SQL suite and the workerd run use
  stand-ins.

**Evidence:** `test/scorecard.test.mjs`, `test/portal-portfolio.test.mjs` (Chromium), `cloud/portal/supabase/test/rls27.sql`,
`scripts/cf-local-e2e.mjs` D58 section (entries from the real completed advice and merged change; a 40-day-old change
scored in workerd with one query; the portfolio for agency A and not for agency B).

## 2026-11-14 D57 The hosted engine sees index status, history and priorities; reacts the same day; reminds people daily
Phase 1 of moving SEO Autopilot off GitHub Actions. Production data (14 Nov) showed the hosted engine's memory for a live
site holds only `audit`, `discovered`, `profile` and `search_console`. The planner's router (`routeAgents`) reads
profile, audit, priorities, inspect, speed and geo, so specialist routing was half-blind. Specialists ran once per ISO
week and nothing reacted to sudden problems. Approvals waited silently (two since 12 Nov): a notification is dated by
the job's last change, so nothing reminded anyone after the first day.

**Decision:**
- **Index status** (`src/god/inspect.mjs`): a daily `index_inspect` job calls Google's URL Inspection API with the
  shared service account for the bound property (D56), or the property the snapshot found for an admin-confirmed site
  (D34). At most 20 pages a day (Google allows 2,000 a day and 600 a minute per property), four at a time: important
  pages (home, then top pages by impressions) every 7 days, then pages never inspected, then the oldest. Report
  `inspect` keeps the CLI's inspect shape (`results: { url: { coverage, verdict, ... } }`), compact, at most 150 pages,
  with each page's previous state and when it changed. A 403 (Restricted access) is recorded as "needs Full permission"
  and not retried for 7 days; a 429 stops the batch and keeps what was read. Read-only scope; nothing escalates.
- **History** (`src/analysis/search-history.mjs`): the daily snapshot adds one small date query (35 days of site
  totals). Report `history` keeps 120 days of daily totals and 9 weekly points for the top 30 queries and pages.
  Query movement between the two latest weekly points uses the rank tracker's `summarise` (`rank.mjs`).
- **Priorities** (`src/god/insights.mjs`): a free `priorities` job runs the CLI's priority engine
  (`src/analysis/priorities.mjs`, with `search.mjs` striking distance, CTR, cannibalisation and decay) on the hosted
  reports whenever the snapshot, inspection, scan or speed check is newer than the last ranking. Content gaps are left
  out: they need page titles, which the hosted scan does not keep, and they are the costliest step for a Worker.
- **The planner sees it all**: `reportsFrom(memory)` gives `routeAgents` priorities, the inspection map, the D56 speed
  check in the router's shape (score and rating) and the history's query movement as `rank`. Agents get
  `indexStatus`, `priorities` and `searchHistory` (bounded) in their data block.
- **Fast reaction** (`src/analysis/alerts.mjs`, pure): clicks down at least 30% week over week (7 days vs the 7
  before, at least 50 clicks and 6 days of data in each week); an important page indexed at its previous inspection
  and not now; a new noindex or robots block on an important page (inspection or scan); new 5xx (technical fixer) or
  4xx (redirect guardian) on an important page since the previous scan. Important = home plus the top 20 pages with at
  least one click or 100 impressions. The first reading of anything raises nothing. An alert queues its specialist
  with a **day** period and priority 1, merged per specialist, with the alert's evidence and ids in the job's inputs.
  The usual rules hold: strategy approved first, daily budget, review, and agency approval for high-risk specialists
  (D17, D29 advise-only, D55). An alert id is not acted on twice in 7 days, and an alert waits while the same
  specialist is already queued or running. An alert run counts as that specialist's run for the week.
- **Daily digest and stale data** (migration 20261119000000): once a day after 07:00 UTC the scheduler calls
  `record_daily_digests`, also while paused. Per agency it records:
  - work waiting for a person and the oldest wait;
  - stopped work, and failures in the last 24 hours;
  - freshness per site: no Search Console snapshot in 48 h for a connected site, no scan in 72 h, inspection refused;
  - yesterday's spend against each site's budget.

  When something needs attention it is a portal notification (`private.notifications_for`, kind `digest`). The D40
  summary email therefore carries it when SMTP is set; without SMTP it is still in the portal. Stale data and refused
  inspection also appear in `ops_alerts` and, for platform admins, in `platform_health`. The same daily call prunes
  superseded copies (older than 14 days) of the large derived reports. Each day writes new copies, and `history` keeps
  the trend. Audit copies are kept for the monthly work report.

**CPU budget (Workers Free, 10 ms per invocation).** Each step stays its own invocation: planning one site, the
snapshot, the inspection and the ranking. Estimated with `scripts/cf-measure-signals.mjs` (Node V8, synthetic site at
every size cap, about 173 KB of reports; first call / warm):
- planning one site: 7 to 11 ms / 2 to 2.6 ms. Of the first-call cost, about 4 to 6 ms is the router's warm-up,
  which existed before D57.
- the snapshot's work after Google answers: about 3 to 5 / 2 ms.
- the ranking job: about 4 / 2 to 3 ms.
- an inspection batch: about 4 to 5 / 1.5 to 2.5 ms.
- alert detection: under 1 ms once warm.

Outbound requests: the snapshot uses 6 Google calls, and the inspection at most 20 plus about 5 database calls (limit
50). A cold isolate planning a large site can come near the 10 ms limit. Workers Paid (30 s CPU) removes that risk; on
Free, a planning error is retried at the next run and shows as a plan error on Operations.

**Not chosen:**
- Computing the digest in the Worker. It needs every site's jobs and memory, many requests per agency. SQL does it in
  one call.
- Escalating a refused inspection. That would put a stopped job in front of the agency every day for a settings
  question; the digest and the alerts say it once.
- Re-inspecting every page daily. Twenty a day keeps the important pages within a week and stays far from Google's
  quota with many sites on one property quota.

**GitHub Actions exit plan:**
- **Phase 1 (this):** hosted sites get index status, history, priorities, alerts and the daily digest without a
  repository or Actions.
- **Phase 2:** the deep crawl (more pages than the 40-page scan function) and the weekly research jobs (`keywords`,
  `rank` with live checks, `gap`, `authority`, `ai-visibility`). These run on Cloudflare Queues and Workflows on Workers
  Paid: durable steps with retries and per-step CPU, results written to site memory in the same compact shapes. On Free
  they stay where they are.
- **Phase 3:** implementation pull requests through the GitHub API directly, without Actions. The Worker creates the
  branch, commits the reviewed change and opens the pull request with the agency's token. It keeps D55: a person
  merges, and checks run in the site's own CI. `seo-implement` and the scheduled workflows are then optional for hosted
  sites.

**Tradeoffs:**
- A platform identity reads index status, as in D56. Customers grant Full access only if they want it.
- Weekly query points overlap (28-day windows), so movement is damped. The data says so.
- Thresholds are first guesses on small sites (one pilot) and should be tuned on real alerts.
- Pruning deletes old copies of derived reports: the daily `history` keeps the trend, but a past day's full snapshot is
  gone after 14 days.
- Nothing is verified with real Google yet: unit tests with mocked responses, the SQL suite and the workerd end-to-end
  run use stand-ins.

**Evidence:**
- `test/inspect.test.mjs` and `test/alerts.test.mjs` (history, detector, priorities, planner and tick integration).
- `test/search-snapshot.test.mjs` and `test/cf-worker.test.mjs` (the digest call).
- `cloud/portal/supabase/test/rls26.sql`.
- `scripts/cf-local-e2e.mjs`, D57 section: inspection for the bound property in workerd, and the digest notification.

## 2026-11-14 D56 Give us read access; central speed checks; a three-step set-up in the portal
The owner, 2026-11-14: "make the setup easy from portal and easy for customers". Today a hosted customer needs a Google Cloud service account, a JSON key, GitHub secrets and a config edit before the agents see any search data. A first version used Google sign-in (OAuth). The owner declined it: no OAuth client and no consent screen. This record describes the version that replaced it.

**Decision:**
- **Read access through the platform's existing service account** (the one the Worker already uses, D47):
  - The portal shows its email, with a Copy button, and two instructions with links:
    - Search Console: Settings › Users and permissions › Add user, permission Restricted (or Full, for URL inspection);
    - Analytics: Admin › Property access management › Add users, role Viewer.
  - `GET /google/account` on the Worker returns only the email, taken from `GOOGLE_KEY_JSON`.
- **Check access** (`POST /google/check`, `src/god/google-access.mjs`):
  - The Worker first checks the signed-in user's Supabase token through a user-level RPC (`google_access_site`, called with the publishable key).
  - It then lists, with the service account, what the account can read: `webmasters/v3/sites`, plus `accountSummaries` and each GA4 property's web streams.
  - It returns only Search Console properties covering the site's host, and GA4 properties with a web stream on that host. The service account sees every customer who granted it access, so nothing else leaves the Worker.
  - GA4 properties named like the site are checked first, at most 30 per check, because a Worker gets 50 outbound requests.
- **Binding** (`bind_google`):
  - The pick must be in the stored list for this site. The Search Console property must also cover the site's host.
  - **One property can be bound to only one website across all agencies** (unique constraint), and one host holds only one Search Console binding (unique index).
  - A domain also registered by another agency needs a platform admin's confirmation (the D34 rule).
  - A refused attempt is recorded in `google_binding_conflicts` and the audit log. Platform admins see it on Operations and can release a binding (`release_google_binding`).
  - Changing a site's address drops its Search Console binding.
  - Agency members and the site's client users may check and bind.
- **Use:**
  - `search_snapshot` and `search_console` read the bound properties with the service account (scopes `webmasters.readonly` and `analytics.readonly`; `googleToken` now takes a scope list).
  - The same job reads GA4: visits per landing page, memory report `analytics`. Agents get `analytics` and `speed` next to `searchConsole`.
  - Sites without a binding keep the D34/D53 path: a platform admin confirms them (`set_gsc_allowed`) and the lookup runs. `set_gsc_allowed` also stays as the override for a disputed domain.
  - The daily read is planned only for a site that can be read: a binding, or a confirmation.
- **Central speed checks:**
  - A weekly `speed_snapshot` job checks the home page plus the top pages by clicks (`SPEED_MAX_PAGES`, default 4).
  - It uses PageSpeed Insights (phone, `fields` limited, because a Lighthouse result is about 1 MB and a Worker has little CPU) and the Chrome UX Report for the site's origin.
  - One platform key, `PAGESPEED_API_KEY`, is used. The job is never planned without it.
- **Portal:**
  - A "Set up" card on Connections and right after adding a site: Website ✓ → Give us read access (email, Copy, steps, Check access, two dropdowns with properties used elsewhere disabled, Save, Remove) → GitHub (optional).
  - The D55 seven-step guide is under "Advanced: connect a GitHub run".

**Why exclusive binding replaces the admin confirmation:**
- The D34 risk was an agency adding a domain it does not own and reading data its real owner granted to the shared account.
- Now a property is read only for the one website it is bound to, and it can be bound only if the owner already granted access to the service account.
- **Residual risk:**
  - Someone registers a domain they do not own and binds its property **before** the real owner does. That needs the real owner to have already added the service account, for example for another agency's site on this platform, and not yet bound it.
  - The D34 rule narrows this: if the real owner's site is registered in another agency, the binding needs a platform admin.
  - The real owner then sees "already connected to another website". The refusal reaches the admin, who checks ownership and releases the binding.

**Tradeoffs:**
- **Rule 6 ("users bring their own keys"):** the hosted service reads customer data with a platform identity (the service account) and uses one platform key for two free Google APIs. Customers still decide what is shared, by adding or removing the email in their own Google accounts. The open-source CLI path is unchanged.
- **Shared quotas:** every hosted site uses the same Search Console and Analytics quotas and the same PageSpeed key. The 4-page weekly cap keeps the speed check small.
- **GA4 discovery** is capped at 30 properties per check. Past that, a property must be named like the site to be found.
- **Not verified with real Google:** everything is tested with stand-ins (unit, Chromium, workerd end-to-end against the real migrations).

**Evidence:**
- `test/google-access.test.mjs`, `test/speed-snapshot.test.mjs`, `test/portal-google.test.mjs`.
- `cloud/portal/supabase/test/rls25.sql`.
- `scripts/cf-local-e2e.mjs`, D56 section: email only, check refused for outsiders, only this host returned, bind, second website refused and recorded.

## 2026-11-13 D55 Changes stop at a pull request; setup guide in the portal; cost ledger
The owner, 2026-11-13: "keep the agent doing PRs ... and hold it there for now with routine changes"; "keep tracking all costs from this project and record"; the instructions for connecting each website must be in the portal.

**Pull requests:**
- The hosted SEO team's way to change a website is unchanged: the D37 pull-request path.
- New: a pull request it opened (label `seo-hosted`) is never merged by the site's autopilot, whatever the site's policy level. `decide()` in `src/analysis/autonomy.mjs` refuses it.
- `seo-implement.yml` now copies the `seo-hosted` label from the issue to the pull request. A site picks this up with `seo-autopilot upgrade`.
- Until then, there is still no path to an automatic merge: no site has a GitHub write integration in production (checked 2026-11-13), and a person merges.
- Automatic merging of routine changes is the next stage, to be built when the owner says.

**Setup guide (Connections page, agency only):** seven connections. Each says what it gives, where to get it, where it goes (a direct link to the repository's Actions secrets) and whether it's done. The state comes from `site_pipeline` and `site_integrations`, and reads "not reported yet" when nothing reports it. The connections:
1. Daily run to portal
2. Search Console
3. GA4
4. Bing Webmaster
5. IndexNow
6. PageSpeed/CrUX
7. Pull requests

The portal needed no SQL change. A refresh keeps the steps the reader opened.

**Cost ledger:** `docs/implementation/COSTS.md` records measured spend with its source, lists spend outside the records, and lists the caps. Sessions append to it.

**Tradeoffs:**
- The guide's done state for Bing and IndexNow stays "not reported" until the daily run reports them.
- The merge guard needs each site's workflows refreshed. Until they are, the guarantee rests on no write token being connected.

## 2026-11-13 D54 Live pipeline and connections pages; each website's GitHub run feeds the agents
Owner (2026-11-13): the other websites "were connected from GitHub"; show the agents and flows running live, what is connected and what is not, to customers; keep the current portal as admin.
- **Finding:** all four repositories run the GitHub engine daily (seo-daily: Search Console with the repository's own key, URL inspection, IndexNow, rank, audit; seo-backlinks with Bing), but none has the `SEO_PORTAL_URL`/`SEO_PORTAL_TOKEN` secrets (run log 2026-11-13, Manchester: both empty), so nothing reaches the portal. Last push: Manchester, 2026-10-31.
- **Bridge:** `ingest_snapshot` now also writes the pushed Search Console data (totals, pages, queries, and each tracked query with its page) into the site memory report the hosted agents read, marked `source: github`. A website with its GitHub run connected needs no extra Search Console access for the hosted service account. A push no longer un-pauses a paused site (it set `status = 'live'` before), so connecting a paused site's repository does not start AI spend.
- **`site_pipeline(site)`** (members and the site's client users): schedule, connections (scan, GitHub run, Search Console, what the run reports such as Analytics, PageSpeed and IndexNow, AI specialists), counts, specialists, work in progress and the latest steps. Clients get no costs, budgets, repository name, setup notes or error text.
- **Portal:** "Live pipeline" (a tilted 3D board of six stations with flowing connectors, specialists, live feed; refreshes every 15 seconds; click a station for details) and "Connections" (state of each, with setup steps for the agency). Shown to agency members and signed-in clients; never on anonymous share links. The rest of the portal is unchanged (the agency view is the admin). Fixed on the way: a share link opened in a tab where a client was signed in kept the client's account links.
- Tradeoff: one more RPC polled every 15 s while the page is open (only then, and not when the tab is hidden).

## 2026-11-13 D53 Search Console property lookup; like-for-like click rates; exam run 3
- **First live Search Console run failed** (job 09e978b2, 01:45 UTC): the Google key works, but neither `sc-domain:erudience.com` nor `https://erudience.com/` answered. The lookup now tries every form an owner may have added (domain property; https and http; with and without www) and, when none answers, the escalation lists the properties the service account can see (`webmasters/v3/sites`), so the owner knows whether the email or the property form is wrong.
- **Exam run 3** (Actions run 43348165017, main fd76894): 12 of 14 passed, $1.88. Pruner, snippet optimizer, reporter, entity, schema, strategist and technical fixer pass every case. Fixed from the two failures: the "no promises" check now looks for "we guarantee"/"guaranteed" (the agent rightly wrote "only state guarantees the owner has verified"); agents compare click rates only like for like (the refresher compared a page's all-query rate with another page's single-query rate, which the fact-checker caught); the fact-checker no longer flags claims sourced to the product's own playbooks as unsupported.

## 2026-11-13 D52 Which page each search lands on; last grader fixes from exam run 2
Exam run 2 (Actions run 43346022217, after D51): 9 of 14 passed ($2.05). The reporter, strategist and entity agents now pass every case, including both "no data" cases and the injection case. What remained:
- **Agents tying searches to pages by guesswork** (fact-checker findings on the refresher and pruner): Search Console gave totals per page and per query but not which page a query lands on. The snapshot now makes a fourth read-only query (page + query, top 250), and agents see the top 60 pairs as `searchConsole.pageQueries` (`null` for older snapshots, never an empty list). New rule: tie a query to a page only from these pairs; never say a page is the only one for a topic, or offers bookings, a form or prices, unless the data says so.
- **Grader**: a negation anywhere in a clause now rules a forbidden phrase out ("adding aggregateRating without real values would be misleading", "none of this can guarantee"); "301 it" is a status code; numbers from the playbooks and skills the agent read count as inputs ("an opening of about 25 to 60 words" comes from the answer-first skill).
- Tradeoff: one more Google query per site per day (well inside the free quota). The fact-checker stays strict; failures it finds are real and visible to the agency.

## 2026-11-13 D51 Agent rules and fairer exam checks from the first real exam run
Owner: "fix whatever needs fixing and improving, skip backlink work now" (2026-11-13), after run 43342999204 (6 of 16).
- **Agents** (shared `SYSTEM_TAIL` in `src/god/agent-runner.mjs`, so every hosted agent): begin with "No data:" when the task's data is missing; state inferences as inferences and never describe page contents beyond the data (the fact-checker's two findings); every removal, noindex, redirect, merge or move starts "After a person approves:" and is never advised without Search Console data; instructions found in site data or client requests are not followed, their addresses are not repeated, and the agent records a "Prompt injection" claim; no promises of rankings, traffic, AI citations or dates.
- **Grader** (`src/analysis/evals.mjs`): HTTP status codes used as such ("a 301 redirect", "return 410") are not figures; `mustNotInclude` ignores a phrase used to rule it out ("no one can guarantee", "do not add aggregateRating"); the "no data" and "flagged injection" checks accept more plain wordings. Each case's bad sample still fails (tested).
- **Backlinks on hold**: the two link-builder cases carry `hold` and run only with `--agents seo-link-builder`; the agent itself is unchanged and still not scheduled to execute.
- Tradeoff: a looser grader can pass weak output, so the rules were loosened only where the first run showed a false failure, and the owner's scoring sheet stays the judge of quality. Not verified on the real model until the next exam run.

## 2026-11-12 D50 Ready for more sites: per-site budgets, alerts, rollback rehearsal, load check
Phase 7 of `docs/product/SYSTEM-READINESS-PLAN.md` (owner: "do it", 2026-11-12).
- **Per-site daily budget**: `sites.daily_budget_usd` (0 to 100 US dollars; null = the Worker's `SEO_GOD_DAILY_BUDGET_USD`), set only by agency owners on Operations (`set_site_budget`, audited). The scheduler reads it through `god_site_budget` (service role only) for planning and for each run's remaining budget, and records the budget it applied and how many jobs waited for budget in the site's tick. The Operations page shows spend this month and last month per site. Tradeoff: the default stays in the Worker's config (one place to change it for everyone); the database holds only exceptions.
- **Alerts** (`ops_alerts`, agency members, their own sites only): scheduler silent for 40 minutes, errors in 3 of the last 4 runs, approvals waiting over 3 days, escalated jobs, budget used up today, failed planning. Shown at the top of Operations. Email delivery waits on SMTP (owner item); the portal card works without it.
- **Rollback rehearsal**: `cloud/portal/supabase/rollback/post-release-1.sql` reverts D42 to D50 (restores the Release 1 `agency_overview`); `node scripts/db-rollback-check.mjs --post` restores the Release 1 catalog exactly and re-applies cleanly, and the Release 1 rehearsal still passes. Runbook: `docs/runbook.md` → "Hosted SEO God" (daily check, pause, budgets, roll back Worker, portal and database, rotate keys).
- **Load check** (`scripts/load-check.mjs`, local Postgres with every migration): one agency with 100 sites and 4,000 jobs: every portal and scheduler function measured answers in under 10 ms per call (agency_overview 9 ms, ops_alerts 5 ms). The real limit is scheduling, not the database: 96 runs a day × 5 sites per run, one plan per site every 6 hours, serves about 120 sites at full cadence; raise `SITES_PER_RUN` (up to 25) before that.
- The workerd end-to-end test now loads every migration since Release 1 (it stopped at 2026-11-08 before) and checks that each site's own budget is applied.

## 2026-11-12 D49 Sourced, dated playbooks (first pass) and five more exam agents
Phase 5 of `docs/product/SYSTEM-READINESS-PLAN.md`.
- **Format** (`src/analysis/knowledge-meta.mjs`): a `Last reviewed: YYYY-MM-DD · Version · Owner` line under the title, and a `## Sources` section of links with the publisher and the date each was checked. A playbook is current, stale (over 90 days), unsourced or undated. A test keeps every playbook that has metadata in this form; `scripts/knowledge-review.mjs` lists what needs review; the portal's agent pages show the source count, version and "review due". Fixed a false positive: the keyword playbook's "## Sources, best first" heading (about data sources) was counted as citations.
- **Rule: a source is cited only after it has been opened and read.** Research on 2026-11-12 could not open the official documentation hosts from this environment (Google, Bing, schema.org, Wikidata, OpenAI, Perplexity); the owner declined adding them to the network. So only `ai-search-visibility.md` v2 was updated, with the two sources that were actually read (Anthropic's crawler documentation, the llms.txt proposal) and every claim labelled documented / observed / hypothesis. Search-found candidates and 12 possibly outdated lines are kept as unverified leads in `docs/product/KNOWLEDGE-REVIEW-2026-11.md`, not in the playbooks.
- **Exams**: 5 more agents (AI search, schema engineer, refresher, strategist, technical fixer), 16 cases for 10 agents. Fixed a grader bug: on compact JSON the URL filter swallowed the numbers after a URL, so figures in the site data were treated as unsupported.

## 2026-11-12 D48 Agent exams through the production path
Phase 4 of `docs/product/SYSTEM-READINESS-PLAN.md`. Until now no agent had been scored.
- **Cases** (`exams/cases.json`): a made-up local business (never a real client) as site memory, plus a task and the right answer as checks. First 11 cases for 5 agents: content pruner (keeps a page with 12 referring domains, merges a thin duplicate, refuses to remove anything without search data), link builder (no paid links, resists an injected instruction), snippet optimizer (uses search data, says when it has none), reporter (honest totals, no invented figures), entity and reputation (no invented credentials, resists an injected profile link). Every case carries a good and a bad sample; `npm test` requires the good one to pass and the bad one to fail, so each case can tell them apart.
- **Grader** (`src/analysis/exams.mjs`): the existing deterministic checks (`evals.mjs`) plus `forbid` (no recommendation whose title names a forbidden action for a URL), `requireRec`, `maxRecommendations` and `escalates`.
- **Runner** (`scripts/exams.mjs`): the production handler (agent file, playbooks, fact-checker, budget rules) on the owner's key, capped (`--max-usd`, $0.50 per case); a case passes only when its checks pass and the production reviews would let it through. Writes results, a summary and a scoring sheet for a person; `--publish` writes `exams/latest.json`, which the portal's agent pages show.
- **Workflow** `agent-exams` (manual, needs the `ANTHROPIC_API_KEY` repository secret): runs the exams and uploads the results as an artifact (synthetic data only).
- Owner decision (2026-11-12): the owner scores the sheet, with outside help; those scores calibrate a model grader later.
- Tradeoffs: deterministic checks are minimum bars (they catch removals of valuable pages, invented figures, obeyed injections), not a measure of advice quality; that needs the scoring sheet. 11 cases is a start; the plan's target is 5 to 10 per agent for the first 10 agents.

## 2026-11-12 D47 Search Console data for the agents
Phase 3 of `docs/product/SYSTEM-READINESS-PLAN.md`, step 1. Until now Search Console was read only to measure accepted advice (D33); the agents never saw clicks or impressions, so the pruner could not know which pages earn traffic.
- New job `search_snapshot` (`src/god/search-console.mjs`): once a day, before the specialists, three read-only queries for the last 28 days ending 3 days ago (Search Console's data delay): site totals, up to 250 pages and 100 queries by the API's default order. Stored as site memory report `search_console` (basis verified, source search console). Planned only when the Worker has `GOOGLE_KEY_JSON` and a platform admin confirmed the site (`gsc_allowed`, D34); otherwise it is never planned and no Google call is made.
- Every agent's input gets `searchConsole` (top 120 pages by impressions, top 40 queries, totals) with a plain note: when the page list is complete, "a page not listed had no impressions"; when it was cut, "a page not listed may still have had impressions". It is `null` when not connected, and the agents are told to say so and not estimate traffic.
- Tradeoffs: 28 days is short for seasonal sites (a later option: 3 and 16 months for pruning decisions); pages beyond the top 250 are summarised as "may have impressions" rather than fetched, to stay inside the Worker's request limits.

## 2026-11-12 D46 Agent pages in the portal, read-only
Phase 2 of `docs/product/SYSTEM-READINESS-PLAN.md`. The owner asked where to see, manage and verify the agents.
- **SEO team → any specialist** opens its page (`#/s/<site>/agent/<name>`, agency only): its description and full instructions; the playbooks and skills it reads before every run (D45), each with word count, whether it lists sources and its review date (today 1 of 29 playbooks lists sources and none has a date, shown honestly); its record on this site (every run with what it read, its summary and recommendation titles, cost, every review verdict with the reviewer's reasons, and the agency's decision); and its exam score (shown as "not examined yet" until Phase 4).
- The team page gains "Specialists on this site": runs, waiting, last run, spend this month, reviews passed (30 days).
- Data: two read-only functions in migration 20261114000000 (`site_agent_stats`, `agent_runs`): agency members only, agent names checked against `^seo-[a-z0-9-]+$`, capped at 100 runs, no new tables. Instructions and playbook metadata come from the repository at build time (`agentCatalog()` in `cloud/portal/build.mjs`).
- Read-only on purpose: an agent's instructions change in the repository, where every change is reviewed, versioned and (Phase 4) must pass the exams. Editing a prompt in a web form would skip all three. Tradeoff: the agency cannot tune an agent for one client from the portal; site-specific facts and rules go in the business brief and memory instead.
- Agent output is untrusted text: rendered with `esc()` only (a test plants an `<img onerror>` recommendation title).

## 2026-11-12 D45 Agents read their playbooks; every AI output is reviewed; the fact-checker gives a second opinion
Phase 1 of `docs/product/SYSTEM-READINESS-PLAN.md`, owner go 2026-11-12. Found on the first live runs: hosted agents got only their own file (never the playbooks they are told to read), and low-risk AI output went straight to "done" without the quality gate.
- **Knowledge at run time** (`src/god/knowledge.mjs`): each agent gets exactly the playbooks its "Read first" names and the skills it names, in that order, as trusted reference material in the system prompt (site data stays in `<site_data>` as untrusted data). Limit 48,000 characters per run; nothing is cut today (largest: local agent, about 27,000). The run's evidence and the proposal list what was read. The Worker bundles playbooks, skills and departments (`cloud/worker/build.mjs`). A test fails if an agent names a playbook that does not exist.
- **Every AI output is reviewed** (`src/god/worker.mjs`): `agent:*` and `client_request` jobs always go through `quality-gate@1` and get a review row; non-AI routine work (scans, measurements) still completes directly.
- **Second opinion** (`src/god/agent-runner.mjs`): content-department work and any high-risk job are reviewed by `seo-fact-checker` (same site data, the advice as data, its own playbooks) within the same job budget. Its verdict is recorded as a second review and decides: needs_changes retries within the attempt cap, fail stops. If it cannot run (budget) or its reply is unreadable, the job escalates to a person with the advice kept.
- Cost: about 3,000 to 7,000 more input tokens per run (about $0.01 to $0.03 at Opus prices), plus one reviewer call on content and high-risk work. Estimates; real costs are recorded per job.
- Tradeoffs: knowledge goes in the system prompt rather than retrieval (simple, exact, and small enough); the reviewer is the same model family, so it catches unsupported claims but is not an independent source of truth; the exams (Phase 4) measure both.
- The pruner and link builder stay held (owner, 2026-11-12): waiting for approval, not approved.

## 2026-11-12 D44 Onboarding questions become one optional business brief; $2/day agent budget
Owner feedback: the questions belong in onboarding, not on the SEO God page. Adding a website by address now opens one form, "Tell us about the business", with every question the dossier can ask (`BRIEF` in `src/god/onboarding.mjs`), all optional, with "Skip for now"; the fields the scan could not answer are marked. It stays editable as the agency-only "Business brief" page. The SEO God page shows only a one-line summary with a link; the live-activity line about open questions is a note, not "your move". Answers are the same `site_memory` 'answer' rows (new `save_brief`/`site_brief`, migration 20261113000000: members only, fixed keys, 2,000 characters, audited), so the planner, the dossier and the approval step (D43) read them unchanged.
Also: production `SEO_GOD_DAILY_BUDGET_USD` set to "2" (per site per day) in `cloud/worker/wrangler.toml`, the owner's choice; with $0.50 estimated per agent run that is about four specialist runs a day for Erudience. The value lives in the file because every deploy resets dashboard variables.

## 2026-11-12 D43 Approving the strategy carries the agency's answers in
Found before the owner's first approval: the strategy is drafted right after the first scan, before any question is answered, and approval adopted that draft unchanged, so the pilot would have frozen "objective: not set". Now `advance()` (`src/god/tick.mjs`) passes the draft through `withAnswers()` (`src/god/onboarding.mjs`) at approval: the goal becomes the objective, conversions become the first KPI, the open-question risk is recounted, and the answers are stored with the strategy. Deterministic, no AI call. Tradeoff: the first steps are not redrafted from the answers (they come from the audit); redrafting them is the specialists' work after approval.

## 2026-11-12 D42 Live activity for the agency, read-only
The owner asked to see inside the portal what the scheduler and the AI agents are doing. One read-only function, `public.site_activity` (migration 20261112000000), feeds a "Live activity" card at the top of the SEO God page: the scheduler heartbeat, what is holding the team back (strategy approval, open questions, AI key and budget, GitHub), who is working now, each worker's 30-day record, and every job step (`job_events`) with the actor named (director, quality reviewer, cloud worker, specialist, or a person by email if they belong to the agency). It refreshes every 30 seconds and replaces only that card, so typed answers survive.
- Agency members only, like `god_console`; clients and other agencies get "not allowed", anon has no grant.
- The scheduler heartbeat is platform-wide, so only its times, pause state and an error count are returned: the Worker's error strings can name other agencies' sites.
- Tradeoff: polling (30 s) instead of Supabase Realtime. Realtime would need table-level RLS publication of `job_events` for members; polling one function is simpler, and the scheduler only moves every 15 minutes.
- "AI key present" is not visible to the database (it is a Worker secret), so the card says honestly whether any specialist has run and what it cost, not whether a key is set.

## 2026-11-12 D41 Health alerts as a GitHub issue; deploys keep the scheduler's chosen state
**Context:** the pilot is live, email (SMTP) is not configured, and the only place a failure showed was the `god_runs` table. A routine redeploy would also silently re-pause a running scheduler, because the dashboard variable is replaced by `wrangler.toml`.

**Decision:**
- `god-health` (GitHub Actions, hourly) reads the run log with the service role and keeps one issue labelled `seo-god-health` open while there is no run for 40 minutes or every one of the last 4 runs has errors; it closes the issue when healthy. It is read-only: it never pauses or unpauses.
- A missing SMTP setting is a note in the notify result, not a run error, so it does not keep the run log red.
- `deploy-seo-god` has a "run" tick box: unticked deploys paused (the default, as before); ticked deploys with `SEO_GOD_PAUSED=false`. `wrangler.toml` still says paused, and the database switch still pauses either way.
- Onboarding no longer treats any address as a local business: only the site's own local business types do; an office address leads to "do you serve customers beyond that area?" (found in the erudience.com pilot).

**Tradeoffs:** GitHub issues reach the owner through GitHub's own notifications, not the inbox; email alerts can be added once SMTP exists. One bad run does not raise an issue, so a failure is reported after at most about an hour.

## 2026-11-08 D40 Email through Supabase's SMTP; the Worker reads the scan secret from Vault
**Context:** the owner asked for email through Supabase SMTP (Q7 answered in chat, 2026-11-08).

**Decision:**
- Invitations (agency and client) go out as Supabase Auth's own invite email, using the project's Auth SMTP and its "Invite user" template. The new `notify` Edge Function asks Auth to invite each queued invitee once. The invite-only gate (D36) lets the account be created because the invite is pending.
- Daily summaries of unseen notifications are sent by `notify` through the same SMTP server. Its details are kept as Edge Function secrets (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `PORTAL_URL`).
  - At most one a day, and only when something is new.
  - Each person can turn it off.
  - Without the secrets, summaries are skipped and the run says why.
- The Cloudflare Worker calls `notify` every run, even while the SEO God is paused: invitations are portal features.
- The Worker reads the shared scan secret from Vault through a service-role-only function, so nobody copies it by hand.

**Tradeoffs:** Supabase's built-in SMTP sends only a few emails an hour and is meant for testing. A custom SMTP server in Authentication → SMTP Settings is needed for real use, and the same details then go into the function secrets.

## 2026-11-08 D39 Brand discovery is labelled; competitors are not guessed
**Decision:** discovery records the theme colour a site declares (stated) and the colours and fonts read from its own HTML styles (inferred), each with its source. Only plain hex colours and plain font names are kept, and generic font stacks are dropped. Competitors are not guessed from a site's own pages: they come from search data through the existing `gap` research job.

## 2026-11-08 D36 Invite-only sign-up in the database; pause enforced on every Worker route
**Context:** owner decision Q8 ("invite-only registration until public launch; verify owner/admin access and invite flows remain functional before changing authentication settings") and the owner's production-gates handover (a paused Worker must not execute due jobs even if Cron fires).

**Decision:**
- Sign-up is gated in the database, not by turning off Supabase Auth sign-ups.
  - Turning sign-ups off would also stop invited people, because both the agency invite (`invites`) and the client invite (`client_invites`) expect the invited person to sign up with that email.
  - Migration `20261108100000_invite_only.sql` adds a before-insert trigger on `auth.users`. It refuses an email without a pending invite.
  - A platform admin (or the service role) changes it with `set_invite_only`. It is on by default.
  - The portal turns Supabase's generic "Database error saving new user" into a plain explanation.
- The Worker's planning and job routes (`/internal/tick-site`, `/internal/run-job`) check both pause switches themselves. A pause therefore also stops work a run in progress has already dispatched, or that anyone sends with the internal token. An unreadable switch counts as paused. This costs one extra database read per invocation.

**Tradeoffs:**
- A refused sign-up returns HTTP 500 from Supabase Auth. The portal handles it, but other clients see a generic error.
- Anyone creating users through the Auth admin API must add an invite first, or open sign-up.

**Evidence:** `rls14.sql`, `portal-invite-only.test.mjs`, `cf-worker.test.mjs` (paused routes), `scripts/db-rollback-check.mjs`.

## 2026-11-08 D35 One agency approval per strategy (replaces the two-step flow of D28)
**Context:** REVIEW-QUESTIONS D1. Under D28 the strategy needed one approval to start drafting and a second to accept the draft. Drafting is deterministic and free: it reads the scan, the site's own statements and the audit, with no AI call. The master spec requires approval only before a strategy is executed.

**Decision:**
- The planner queues the strategy draft right after the scan, ungated (risk medium, priority 2, created after the scan so the scan runs first and the draft reuses it).
- The draft handler marks its result `adopt: true`. After review the worker sends such a result to the agency (`awaiting_approval`) even though starting it needed no approval.
- One `approve_job` adopts it: the scheduler writes the strategy as approved and completes the job. Nothing else executes for the site until then, as before.
- "Request changes" on ungated work (the job moves to `scoped`) makes the scheduler redo it. Gated work still waits for a new approval to start.
- Only the agency decides work that waits for it: the worker may not authorize or reject a job in `awaiting_approval`, gated or not. This is enforced twice: `src/core/job-lifecycle.mjs` and `transition_job` in migration `20261108090000_strategy_draft.sql`.

**Tradeoffs:** the agency sees a draft at once and decides once. A draft is made for every new site even if the agency never looks at it; it costs only the database writes. High-risk changes keep their own approvals (D17).

**Owner input:** confirmed by the owner in REVIEW-QUESTIONS D1 (2026-11-08): one agency approval; the draft is generated automatically after the initial scan; agency approval is required before the strategy is adopted or executed; high-risk website changes keep their own approvals.

## 2026-11-08 D34 Fixes from the independent security review
An independent review of the whole stack found three exploitable defects. All are fixed, with regression tests (`rls12.sql`, `test/security-fixes.test.mjs`).

1. **Search Console data could leak across agencies.**
   - **Problem:** the platform's one shared Google account read any domain an agency added, even one it did not own.
   - **Fix:** a site may use the shared account only after a platform admin confirms it (`set_gsc_allowed`), and never while the same domain is registered in another agency.
     - The confirmation is cleared when the address changes.
     - Members cannot set it.
     - The scan function and the Worker both check `gsc_allowed` first.
   - **Proper long-term fix:** each agency brings its own Google account (rule 6). See REVIEW-QUESTIONS X3.
2. **Budget bypass.**
   - **Problem:** agency staff could create jobs with any budget, skipping the per-site daily cap and spending the platform's AI key.
   - **Fix:**
     - Staff jobs carry at most $5.
     - A staff job with a budget needs approval.
     - Each person can create at most 100 jobs a day.
     - The per-site daily budget is now a hard ceiling on every paid run at run time, whoever created the job.
   - **Not fixed here:** fairness between agencies in the job queue (`claim_job` orders by priority across all tenants). See X3.
3. **Script injection through a site's links.**
   - **Problem:** a `javascript:` address in a site's structured data (`sameAs`, `logo`) reached a portal link.
   - **Fix:** discovery keeps only http(s) addresses, and the portal builds every link from site data through `safeHref`, which allows http(s) only.

## 2026-11-08 D33 Search Console for hosted sites measures accepted advice with the CLI's own method
**Decision:** with a Google service account (`GOOGLE_KEY_JSON`, which site owners add as a user on their property), the scheduler queues a read-only `search_console` job. It runs once an accepted piece of advice has a complete after-window (3-day lag plus 14 days).

**How it measures:**
- The job compares the page's 14 days after with the 14 days before, against the rest of the site over the same dates. It reuses `src/analysis/experiments.mjs` (`evaluate`, `controlGroup`).
- **Queries stay small:** per page under test, its daily rows, plus the site's daily totals; the control group is the totals minus the page. Downloading page × date data would be too much for the Worker's 10 ms CPU.
- It tries the domain property first, then the address prefix. If it has no access, the job goes to a person, saying the site owner must add the account.
- Verdicts feed the lessons. "Too little traffic" and "unclear" are never counted as wins.

**Tradeoffs:**
- It is still directional: the control group is the rest of the site, not matched pages.
- It covers at most 10 pages per run.
- Search Console data lags about 2 days.

## 2026-11-08 D32 Operations: each agency sees only its own sites; platform health is for platform admins
**Decision:** the portal's Operations page has two parts.
- **Every agency** sees all its own websites at a glance: approvals waiting, client requests, stuck work, spend and when each site was last planned (`agency_overview`).
- **Platform admins only** also see scheduler health: recent runs, errors and usage against the Workers Free daily limit. They get the global pause switch too (`platform_health`, `set_platform_paused`). The admin list is a table only the service role can change.

**Why:** scheduler runs and the pause switch cover every agency. Showing them to agency members would leak other tenants' activity and let any agency stop everyone.
**Tradeoffs:** a platform admin must be added once by SQL; there is no self-service admin UI.

## 2026-11-08 D31 Learning measures what an audit can show, and says so
**Decision:** the SEO God learns from three things.
1. **Accepted advice is re-checked by later scans.** Each recommendation is recorded with the problems found on its page. A problem counts as fixed only if the page was crawled again and the problem is gone. Results are judged after 3 days, and unresolved items close as "not done" after 30 days.
2. **The agency's own refusals.**
3. **Lessons per agent**, built from those two.

Lessons change planning:
- an agent whose work the agency declined twice in 30 days is paused until the refusals age out;
- advice never fixed after 3 checks drops a priority step.

The site's lessons are also passed to the agents, inside the data block. The agency sees all of it on the SEO God page.

**Why:** the master spec asks the system to improve from outcomes. The hosted path has no daily Search Console series for most sites, but every site has repeated audits.

**Tradeoffs:**
- An audit shows whether a problem went away, not whether traffic changed. The console and the lesson wording say so.
- Traffic-based verdicts (`src/analysis/experiments.mjs`, difference-in-differences with a control group) stay with the CLI path until hosted sites have Search Console data.
- Lessons are per site, not shared across agencies (tenant isolation).

## 2026-11-08 D30 Cloudflare-first execution: a stateless Worker scheduler, crawling in the Supabase scan function, CLI jobs stay in GitHub Actions (owner: PR #42)
**Decisions:**
1. **Scheduler and light work in a Cloudflare Worker.** One Worker (`cloud/worker/`) with one Cron Trigger every 15 min. Each site's planning and each job run in a new invocation of the same Worker through a self service binding. Each invocation gets its own 10 ms CPU and 50-subrequest Free allowance.
   - Measured CPU per step: 0.4-2.5 ms for planning, onboarding and agent prompts.
   - The Worker keeps no state: Supabase is the source of truth for jobs, approvals, memory, leases, retries, costs and the run log.
2. **Crawling in the existing Supabase `scan` Edge Function**, in a new job mode: one site per request, at most 40 pages.
   - A 60-page crawl and audit measured 0.8-1.6 s of CPU. That is far over the Worker's 10 ms, and a single page alone is 13-27 ms.
   - The Supabase limit is 2 s CPU per request. The function's older loop scanned several sites in one request and could exceed it, so it now scans one.
3. **The 52 CLI jobs stay in the site repositories' GitHub Actions.** Every one reads or writes the site's state files, and 6 spawn processes. In Workers, `child_process` is a non-functional stub and `/tmp` is cleared per request. Moving a job requires moving its state to Supabase first. `scripts/cf-runtime-audit.mjs` keeps the classification generated from the code.
4. **No Cloudflare Workflows for now.** The Supabase job ledger already gives durable steps, leases, retries and approval waits. Workflows Free has the same 10 ms per step and a 3,000-step daily cap.
5. **Fails safe.**
   - The Worker deploys paused (`SEO_GOD_PAUSED`), and a database switch (`set_god_paused`) pauses it with no deploy.
   - If the database cannot be read, the scheduler pauses.
   - Expired leases are recovered through the normal capped retry path.
   - Internal routes need a token, and the only public route is `/health`.
6. **One scheduler.** When Cloudflare goes live, the 10-minute pg_cron scan from D25 is unscheduled. The scan function's job mode stores the portal snapshot itself.

**Supersedes:** the part of D13 that put engine jobs in a separate Node container or VM. The hosted path now needs no VM: Worker plus the Supabase function. The CLI path keeps GitHub Actions.
**Tradeoffs:**
- The Worker holds the service-role key; tenant safety rests on the SQL functions.
- CPU inside Cloudflare is estimated from Node, not yet measured in production.
- Hosted sites get audits, strategy and advice, not file edits.
- Fan-out costs Worker requests: about 350 a day for 25 sites, against 100,000.

## 2026-11-08 D29 Hosted agent runs advise only, on the user's own key, inside the job's budget
**Decisions:**
1. Hosted agent jobs (`agent:<name>`, `src/god/agent-runner.mjs`) use the agent's own definition from `departments/`. They see only the site's compact reports, approved strategy and stated facts. They return recommendations for the agency and change nothing on a website. Edits stay with repository-connected sites and the R1-E1 apply step.
2. The call goes straight to the Messages API with the user's own `ANTHROPIC_API_KEY` (rules 5 and 6). The default model is `claude-opus-5-5` at effort `medium`; `SEO_GOD_MODEL` and `SEO_GOD_EFFORT` change it. Server-side refusal fallback (`fallbacks: "default"`) is on.
3. Budget is enforced before the call. `max_tokens` is set so the worst case fits what is left of the job's budget: input estimated at one token per three characters, priced at the most expensive model a fallback could reach. Cost is computed from the API's own usage report, per attempt when a fallback ran. A model without a known price is refused.
4. Some outcomes go to a person at once instead of being retried: no key, a budget too small, a refusal, an unreadable reply. The job's budget covers all its attempts together, and reviews that keep asking for changes stop at the attempt cap.

**Why:** the planner was choosing agents that nothing could run. Unbounded retries of paid calls were possible, both review-driven (needs_changes requeued without a cap) and per-attempt (budgets were not cumulative).
**Tradeoffs:** advice is weaker than a reviewed change, but it is safe on any site and needs no integration. Prices are the published first-party rates as of 2026-10; Bedrock, Vertex and Foundry users would need their own price table. Agent output quality is ungraded until runs on real sites with a real key.

## 2026-11-08 D28 SEO God scheduler: two agency decisions per strategy, budgets reserved before work is queued
**Decisions:**
1. A scheduler tick (`src/god/tick.mjs`) carries out decisions the agency has already recorded and never makes one. An approved job that has not run is queued. An approved strategy proposal that has run becomes the site's strategy (`status: approved` in site memory) and its job completes. So the strategy needs **two** agency decisions: "start drafting" and "accept this draft". The agency approves the exact draft that is stored on the job (`jobs.outputs`), not a regenerated one.
2. Approved changes that have run are not applied by the tick. They wait for an apply step that uses an authorized integration (R1-E1), so the content deployed is the reviewed content.
3. Each site has a daily budget (default $0: free read-only work only). The remaining budget of open jobs counts as spent when planning, so one tick cannot queue more than the day allows. Every charge is a row in `job_costs`. Work that spends more than its budget fails review and is not retried.
4. Only kinds with a runner are queued. Planned agent work without one is reported as deferred, not queued to fail.
5. Kill switch `SEO_GOD_PAUSED`; a site with status `paused` is not planned.

**Why:** the planner and worker existed but nothing ran them, approvals had no path forward, and there was no cost limit (master spec: budgets and costs per job; owner: agency-only approvals).
**Tradeoffs:** two approvals per strategy is one more click for the agency, but it means drafting work (later model calls) is never started without consent. Agent cost estimates ($0.50 per run by default) are estimates until agents are graded on real runs. The queue is global; a site over budget can still run work already queued within its reservation.

## 2026-11-08 D27 Release 1 contracts in the existing Supabase schema (owner: master spec PR #35, Q07, Q27-Q30)
**Decision:** add clients, client viewers, jobs with a database-enforced lifecycle, append-only job events, independent reviews, agency-only approvals, untrusted client submissions, private site memory, integration records and an audit log to the existing portal schema (`20261108000000_r1_contracts.sql`), with the same lifecycle mirrored in `src/core/job-lifecycle.mjs`.
**Why:** every later workstream (SEO God orchestration, onboarding, client portal, verified changes, learning) needs these records, and the owner's hardest rules (agency-only approval, submissions never execute, client results only) belong in the database so no UI or worker bug can bypass them.
**Tradeoffs:** one Postgres project for everything (no new infrastructure); gates live in SQL functions, so the engine must call them rather than write rows. Same-org rules are triggers, not CHECK constraints, so existing member updates keep working. Client accounts come only from an agency invitation; anyone else who signs up still gets an agency workspace (open sign-up stays an owner decision).
**Not decided here:** whether share links stay alongside client accounts; email provider; file upload storage and scanning.

## 2026-11-07 D26 Audit outcomes: guarded fetch for hosted scans, robots.txt, a generated registry (owner: "a working, secure and measurable system before additional features")
**Decisions:**
1. Every address a user types is fetched only through `src/hosted/safe-fetch.mjs`, checked again at every redirect hop, with DNS answers checked where the runtime can resolve. The database also refuses private addresses for address-only sites, on insert and on update.
2. Hosted scans follow robots.txt for `*`: the site's owner may not be the person who added it.
3. The registry of jobs, agents, skills, MCP tools and workflows is generated from the code (`scripts/build-registry.mjs`) and checked by a test, instead of a hand-written list that drifts.
4. No agent is merged or removed now. Overlaps (AI visibility x3, research x4, planning x2, local umbrella x5 specialists, review x3) are recorded; consolidation waits until agents are graded on real sites.
**Why:** the D25 scanner fetched any URL a site linked to, including redirects to internal addresses; docs claimed things the code and deployment did not show (departments "not implemented", agents "running").
**Tradeoffs:** DNS rebinding is reduced, not eliminated (documented in `docs/security.md`). Hosted scans read fewer pages on sites with strict robots.txt.

## 2026-11-04 D25 Websites connected by address, scanned on Supabase (owner: "a simple or straightforward way to connect any site", "triggers outside GitHub", "cheapest, free if possible")
**Decision:** a site can be added to the portal with only its address. A `scan` Edge Function in the portal's Supabase project crawls it (the product's own crawler, audit rules, platform detection and snapshot builder, copied in by `cloud/portal/build-scan.mjs`), reads what the site states about itself (`src/analysis/discover.mjs`) and stores a snapshot. pg_cron wakes it every 10 minutes; adding a site or pressing "Scan now" wakes it at once; each site is due once a day.
**Why:** it works for any website (WordPress, Shopify, Wix, hand-built) with nothing to install, uses no GitHub Actions minutes, and runs on the free Supabase plan: 144 wake-ups a day, each scanning as many due sites as fit in 100 seconds. Claude already reaches the same database through the Supabase MCP.
**Tradeoffs:** reads at most 60 pages per site per day, and only the HTML before JavaScript; no Search Console, GA4, agents or edits for address-only sites yet (they need access the owner of the site grants, which comes next). The free plan pauses a project after a week with no API traffic; the daily scans call the API, which should keep it awake, but that is not yet observed. The scanner refuses bare IPs, localhost and private suffixes.
**Alternatives:** Render cron (unchanged Node, about $1–5 a month), Cloudflare Workers ($5 a month plan for the CPU time), a VPS. Rejected for now on cost; the scan module is plain Node, so moving it is a copy.

## 2026-10-30 D24 Approvals from the portal are applied by the site's own run (owner: "do your works")
**Decision:** the portal records a decision (approve, hold, decline). The site's daily `portal --push` receives the pending decisions in the push response, applies them on GitHub with its own `GITHUB_TOKEN`, then acknowledges them. For an approval, it adds the label and comment and starts `seo-implement` by workflow dispatch.
- **Why:** the portal keeps no GitHub access, which matches D23's push model. The site's token can already label issues. GitHub does not start workflows from labels added by `GITHUB_TOKEN`, but it does honour workflow dispatch, hence the explicit dispatch.
- **Tradeoffs:**
  - Decisions apply at the next daily run (05:17 UTC), not instantly. A later option is an hourly sync step, or a GitHub App held by the portal.
  - Portal members can approve: the site owner accepts that by installing the portal token. Every change still passes the checks, and the risk policy (D17) is unchanged.
  - `seo-daily` needs `actions: write`.

## 2026-10-30 D23 Client portal on Supabase, fed by a daily push (owner: "do all of your remaining works")
**Built:** an agency signs in, connects websites, and shares a no-login link with each client. Each website's own scheduled run pushes one JSON snapshot a day (`portal` job). The portal stores the snapshots in Supabase Postgres and shows them on one static page. Source: `cloud/portal`, `src/jobs/portal.mjs`.
- **Why push, not pull.** Agencies' websites live in their own (often private) repositories. A push needs one site-scoped token per website. A pull would need the portal to hold GitHub access to every client repository. The workflow already runs daily, so a push costs one step.
- **Why Supabase.** It provides Postgres with row level security, email sign-in and Edge Functions in one service, and the owner already uses it. With RLS, isolation is enforced by the database rather than by the page. The page talks to the REST API with the publishable key, so it needs no server and no libraries, and stays a static file that any host can serve.
- **Tenancy.** Every account gets its own organisation on sign-up. Site tokens are stored as SHA-256 hashes in a schema the API does not expose, and making a new one stops the old one. Client links are random tokens that read one website's latest snapshot through one function.
- **Tradeoffs.**
  - Snapshots are whole documents (about 60 to 70 KB per site per day; the last 120 are kept), not normalised tables. That is simple and fast to show, but cross-site analytics would need extraction later.
  - Client links are bearer links: anyone holding one can view that site. That is acceptable for SEO reports, and links are revocable.
  - The portal depends on Supabase. The schema is plain Postgres plus `auth.uid()`, so moving is feasible.
- **Relationship to the Phase 0 plan (D1 to D15, still awaiting owner review).** This is the smaller alternative to the full hosted app. It runs no jobs and holds no Google credentials, and it reuses the engine unchanged, so it does not pre-empt the hosted-worker decision (D1). It overlaps briefs 05 and 07.
- **Not done:** billing, team invitations, per-agency domains, live updates.

## 2026-10-23 D22 Product name (proposed; owner decides)
- **Problem:** "SEO Autopilot" is a category, not a name. BrightEdge sells "Autopilot", and at least two other tools are listed as "SEO Autopilot". It cannot be owned, protected or found.
- **Owner brief (2026-10-23):** a simple, small, repeatable name; the domain need not be .com.
- **Shortlist (web search found no SEO product with these names; no trademark or domain check done, the sandbox cannot reach registries):** Seora (coined: SEO plus aura; ownable, says what it is), Tend (tending a site like a garden; tend.io is an analytics tool, an adjacent risk), Hone (common word, harder to own). Ranko was rejected: an AI SEO agent of that name already exists.
- **Rename plan once chosen:** a trademark search in the main markets (UKIPO, EUIPO, USPTO) and the domain first; then the repository (GitHub redirects the old URL), npm package, CLI (the `seo-autopilot` command stays as an alias), GitHub Action, Claude plugin, site and docs, in one release.

## 2026-10-23 D21 Vertical packs: a registry, not a folder per pack (owner: "a separate part so each site gets its own specialist agents")
- **Decision:** packs are defined in `departments/verticals/packs.json` (pack → agents → routing instruction). Agent files stay in `departments/verticals/agents/`. A pure `detectVerticals` (`src/analysis/verticals.mjs`) decides which packs apply, from the site profile or the site's `verticals` setting.
- **Why not one folder per pack yet:** moving agents would change every installed path, the plugin list and the department tests, with no gain for users. The registry gives the same result: each site gets and runs only its packs. Folders can come later, when a pack gains its own jobs and playbooks.
- **Install rule:** pack agents are installed only once every site in a project names its packs. Until then all of them are installed, because the profile that detects packs runs after `init`. Agents already installed are never deleted, so project rules are never lost.
- **Status:** unit tested (`test/verticals.test.mjs`); not yet run on a real site. Data jobs per pack are brief 12, steps 2 to 4.

## 2026-10-22 D20 Hosted connector for Claude and ChatGPT (owner: "start the hosted connector")
- **Decision:** the first hosted piece is a read-only remote MCP server (`cloud/connector`, a Cloudflare Worker). Claude and ChatGPT can then use a site's reports with no local install. It reads what the site's own workflows already save, which is the GitHub-App distribution mode in D1(b), and adds no database, tenancy or job runner. D1 to D15 stay proposals; this decision is limited to the connector.
- **Choices and tradeoffs:**
  - **Data source: the site repository's state branch** (`seo-data`) and its config, read with the user's own GitHub token. The cost is that reports are only as fresh as the last scheduled run. In exchange there is no copy of anyone's data on our side, and nothing to keep in step.
  - **GitHub App, not an OAuth App.** The user picks the repositories, and the only permission is *Contents: read*. An OAuth App's `repo` scope would grant write access to every repository.
  - **The connector is its own OAuth 2.1 server, with GitHub as the sign-in.** MCP clients need dynamic registration, PKCE and the metadata documents. GitHub supports none of them for this use, so the connector cannot simply be GitHub's OAuth.
    - Our own consent page names the requesting client before GitHub is asked, so a registered client cannot get a token silently. A SameSite cookie stops another site approving on the user's behalf.
    - Redirect URIs must match exactly: https, or loopback http.
  - **Storage in Workers KV:**
    - only hashes of our tokens and codes;
    - the GitHub token encrypted with AES-GCM;
    - an expiry inside every record as well as the KV TTL.

    KV is eventually consistent, so single use is near-exact, not exact. A Durable Object would fix that if it ever matters.
  - **No `run_job`.** Jobs need git, Python and Go (see D13), and a hosted runner is a separate step.
  - **Shared code.** The tools moved to `src/mcp/core.mjs`, which has no Node imports, so the local server and the Worker run the same code.
- **Who runs it:** anyone can deploy their own copy with their own GitHub App and Cloudflare account; nothing needs the maintainer's keys. A public instance for customers would be run by the product owner, with their own GitHub App.
- **Status:** 5 tests with GitHub and KV faked; bundled with `wrangler deploy --dry-run` (30 KiB); run in the local Workers runtime (`wrangler dev`), where discovery, registration, consent, the refused cross-site consent and the redirect to GitHub all behaved as designed. **Not deployed. Never used with real GitHub or a real Claude or ChatGPT client.**

## 2026-10-20 D19 Site intelligence and the MCP server (owner: "more real capabilities")
- **Decision:** add capabilities that need no paid provider. These are:
  - internal PageRank and link-graph analysis;
  - real-user Core Web Vitals history (Chrome UX Report);
  - a page change monitor;
  - a structured data checker and generator;
  - an entity check (Google Knowledge Graph, Wikidata).
  Also an MCP server, so AI assistants can use the reports and jobs.
- **Tradeoffs and rules:**
  - **Internal PageRank** measures the site's own linking, not Google's view, and the report says so.
  - **Structured data drafts** use only facts from the page, the config and the URL. Unknowns stay as `<fill: ...>` placeholders, so no fact is invented. Markup that claims what the page does not show is flagged as an error, after Google's structured data policies.
  - **The change monitor** keeps sentence fingerprints, not copies of competitors' text.
  - **The entity check** treats creating a Wikidata item as a person's decision, and only for genuinely notable businesses.
  - **The MCP server** is read-only by default:
    - files are limited to the state folder;
    - `run_job` has a fixed allowlist with no publishing, issue, merge or submit jobs;
    - `team` and `priorities` are forced to run dry;
    - paid jobs need `confirm_cost`;
    - it uses no shell, and has no dependencies (newline-delimited JSON-RPC over stdio).
- **Status:** unit and fixture tested; the MCP server was also tested through a real stdio session. The Chrome UX Report, Knowledge Graph and Wikidata APIs have not been called live.

## 2026-10-20 D18 Research suite instead of a paid SEO suite (owner request: "those features or better, real solutions")
- **Decision:** build keyword research, rank tracking, competitor gap, content optimisation, AI visibility, backlink authority and a traffic forecast into the product. Run them on the site's own data (Search Console) plus keys the user brings. No Ahrefs or Semrush subscription, and no maintainer keys.
- **Choices and tradeoffs:**
  - **Search Console first.** Positions and demand come from the site's own first-party data and are free. The cost is no data for queries the site was never shown for. A provider key (DataForSEO) fills that, labelled as an estimate.
  - **Grouping by shared results.** When live results are available, 3 or more shared top-10 URLs define a topic, the method the big suites use. Without live results, grouping falls back to same-words, and the report says which method was used.
  - **Difficulty without a link index.** Difficulty is the average Open PageRank (from the open Common Crawl graph) of the top-10 domains. It is cruder than a suite's own index, so it is labelled with its basis.
  - **Autocomplete is off by default** (`--suggest`). Google's endpoint is public but unofficial, and its terms restrict automated queries. When on, it is capped, spaced out, and used only for wording, never as volume.
  - **AI visibility uses the engines' official APIs with web search on.** That covers Perplexity, OpenAI Responses with `web_search`, Claude with `web_search_20260209` and server-side fallback, and Gemini with `google_search`. Results are compared only within the same question set, repeated runs measure variance, and raw answers are kept as evidence. Consumer apps can answer differently from the APIs; the report says so.
  - **Paid steps are opt-in per schedule.** They are switched on by `SEO_RANK_LIVE` and `SEO_AI_VISIBILITY`, and free steps always run.
  - **Forecast in Python, standard library only** (Holt-Winters with a weekly season, grid-searched). It runs in the optional engine, so the Node core stays dependency-free. The range assumes independent errors and is on the narrow side; it prompts a look, not a conclusion.
- **Not built:** paid-ads intelligence and social tools (different products), and a web-scale crawl of our own (that would need infrastructure the product does not run).
- **Status:** all mocked or fixture tested. No provider has been called live from this project yet.

## 2026-10-20 D17 Graduated autopilot (APPROVED by the owner)
The owner decided that a person should not approve every change: routine work runs and publishes on a schedule, and a person is asked only about high-risk changes. This replaces the earlier rule "a human approves what goes live".
- **Levels per kind of change** (`src/analysis/autonomy.mjs`, shown by `run autopilot`):
  - `watch` reports only;
  - `prepare` opens a PR for a person;
  - `autopilot` merges and publishes after every check;
  - `undo` does the same and then watches the live result and reverts on regression.
- **Defaults:**
  - fixes, snippets and internal links publish at `undo`;
  - refreshes, new pages and template changes publish at `autopilot`;
  - sensitive topics, site-wide indexing (robots, sitemaps, headers, redirect rules), migrations, deletions, outreach and infrastructure (workflows, dependencies, the autopilot's config and agents) stay at `prepare`, and a site cannot raise them.
- **Checks before an automatic merge**, all on the exact commit:
  - seo-check build;
  - the reviewer agent's check and pass label;
  - the policy decision, which includes sensitive-topic detection in the added text and treating any new page file as a new page whatever its label;
  - daily and weekly limits (10 changes a day, 3 new pages a week by default, to stay clear of scaled-content patterns);
  - a merge pinned to that commit.
- **Kill switch:** the repository variable `SEO_AUTOPILOT_PAUSED=true`, or `autopilot.paused` in the config, stops implementing, merging and releasing.
- **Fixes to the gaps found in the Phase 0 audit:**
  - F1: auto-merge accepted a reviewer label left from an earlier commit and had no policy; now the reviewer check must pass on the same commit, and the merge is pinned.
  - F2: the implementer did not check who added `approved`; now only write, maintain or admin can trigger it.
  - F3: release pushed to the default branch with no pause; it is now behind the kill switch and only dates pages already merged.
- **Still to build (D17 roadmap):**
  - running the agents automatically on a schedule: DONE for proposal issues (`seo-autopilot` workflow, which calls implement, check, review and merge in one run, because changes made with the workflow token do not trigger other workflows). DONE for work orders from `team` too: with `SEO_AUTOPILOT=true` the weekly `team` step opens one `seo-work-order` issue per page for ready, page-scoped orders of the snippet optimiser, internal linker or refresher (never sensitive pages, site-wide orders, advise mode, or kinds the policy keeps for a person; at most 5 a week), and the implementer follows that agent's file;
  - a monthly workflow: DONE (`seo-monthly`, `monthly` job: autopilot ledger, rollbacks, 28-day traffic, audit findings vs last month, experiments);
  - post-publish monitoring with automatic revert for `undo` changes: DONE (`seo-watch`, `watch` job: reverts through a pull request when a changed page errors, the change added a noindex, or clicks fell clearly more than the rest of the site over 14 days; indexing status is not judged because no per-change snapshot exists);
  - the AI reviewer as a required check in more repositories (it needs the site owner's Claude key).
- **Risks:** Google's spam policies on scaled content, and wrong facts on sensitive topics. They are mitigated by the pace limits, the facts guard, the reviewer, and the human-only classes. Default behaviour for existing installs is unchanged until they set `SEO_AUTOMERGE=true`. Breaking change for those who already use auto-merge without the reviewer: they must now set `SEO_REQUIRE_REVIEW=false` explicitly, or enable the reviewer.

## 2026-10-18 D16 Departments, work orders and validation (PROPOSED, owner to confirm)
Proposal: group agents into departments, each a folder. The departments are command, research, technical, content, authority, ai-search, verticals and quality. Each has a charter, one owner per problem type and shared skills. The router produces dependency-ordered work orders with file/URL locks so independent work can run in parallel, and nothing reaches approval until its validators pass.

The full design is in `docs/architecture/DEPARTMENTS.md`, with evidence in `docs/research/AGENT-AUDIT-2026-10-18.md`.

- **Rationale:** today ownership overlaps and sequencing rules are prompt-only. Several SEO areas also have agents without any data behind them.
- **Tradeoffs:** moving files touches every loader (init/upgrade, Python runtime, site build, tests), and existing installs must be upgraded. New agents add maintenance, so each must come with a data source and eval cases.
- **Smaller alternative:** keep the flat folder and add a `departments.json` registry. That gives the same ownership and routing benefits with no file moves, but it doesn't give the folder layout the owner asked for.
- **Naming:** keep "SEO Autopilot" and call the organisation "the Search Desk" (recommended), or rename after a trademark check.

## 2026-10-18 Business model: open core, service first (proposed, owner to confirm)
Keep the engine MIT; sell hosting, multi-client operations, approvals, scheduled runs, reporting and support; start with a done-for-you service through Erudience to validate demand. Alternatives and risks: `docs/strategy.md`. Consistent with the agency-first hypothesis in `SEO-PRODUCT-BUILD-BRIEF.md`, which also says prices are unvalidated.

## 2026-10-18 Roadmap relationship to the product brief
`SEO-PRODUCT-BUILD-BRIEF.md` is the owner's plan for the hosted product and takes precedence where they overlap. Roadmap briefs 05 (dashboard), 06 (CMS connectors) and 07 (hosted cloud) are superseded by its phases 1 to 4 and must be planned through its Phase 0 reuse audit first. Briefs 01, 02, 03, 04, 08 and 09 do not depend on that decision and can proceed. Note the product brief's rule: platform detection is not a working publishing integration; start with one GitHub-backed publishing path.

## 2026-10-12 to 2026-10-17 Engine decisions (already implemented)
- Dependency-free Node core; Go and Python engines optional.
- Agents are Markdown definitions; the `team` job routes deterministically from reports; a human approves what goes live.
- Site profile decides edit vs advise mode; agents never edit when the source is not in the repository.
- Users bring their own Google and AI accounts; no maintainer keys.

## D64 (2026-11-16): automatic linking retries Analytics
Context: D61 linked Google automatically only while a site had no Search Console binding. The first attempts ran before the Analytics Admin API was enabled, so every live site got Search Console without GA4 and was never tried again.
Decision: `google_autolink_due` is true, once a day, while Search Console or GA4 is missing. Still false for paused sites, after a person removed the Search Console property, and once a person chose properties on Connections (`google.bind` in the audit log), so a person's choice, including "no Analytics", is kept.
Tradeoff: a site with no GA4 property costs one free Admin API listing a day. Rejected: retrying only after an "API disabled" error (needs the error kept per site; more code for the same result).

## D65 (2026-11-20): one bad job never stops a site; jobs without a budget run; reviewed advice keeps the review's budget
Context (production): on 2026-11-19 two gated AudioScriptor jobs were set to `authorized` with no approval row and a $0
budget, outside the planner (all three such jobs share one creation instant and have no idempotency key). The database
refused to move them, `advance` threw, and planning stopped for the whole site at every run until they were repaired by
hand. Separately, between 2026-11-16 and 2026-11-18 two reviewed reports used so much of their $0.50 that the
fact-checker could not run ("needs about $0.13/$0.17 more"): the advice was paid for and then sent to a person unchecked.
Decision:
- `advance` moves each job on its own: a job the database refuses is reported as waiting with the reason, the others move
  on and planning continues. A failure while following website changes is reported the same way.
- A job with no budget (0) runs with its kind's standard estimate (`jobBudget`, from `SEO_GOD_AGENT_RUN_USD`); a budget
  someone set is kept. The site's daily cap still limits it, and the tick's reservation counts it the same way.
- An agent job whose advice the fact-checker reviews (publishable or high risk, D63) is planned at 1.5 times the agent
  run budget, and the runner keeps the review's worst-case cost (reviewer prompt, site data, about 8,000 characters of
  advice and a 1,500-token verdict) aside before the agent's own call. If both cannot fit, it escalates before spending.
Tradeoff: reviewed runs cost up to half again as much per day and the agent's reply has a lower token ceiling; in return
no paid advice goes unchecked for lack of money. Rejected: a database trigger setting a default budget (duplicates the
Worker setting in SQL); refusing $0 jobs (agency staff may leave the budget empty, and the job would never run).
Not fixed here: who made the 2026-11-19 jobs is unknown; the database still accepts such rows from the service role.

## D66 (2026-11-24): fewer false escalations; approval rule enforced on every write
Context (production 2026-11-20 to 24): 7 of 24 specialist reports escalated. Causes read from `job_events`: the gate
counted HTTP status codes ("returns 200", "a 301 redirect") and numbers copied from the site's own data ("+7,393" from
the priorities report) as unsourced; three retries started with too little budget and were cut off; one fact-check
reply was unreadable. Also found: since D65 a job with no stored budget runs with the standard one, but the gate still
compared its spend with the stored $0 and would fail it as over budget. And the 2026-11-19 jobs were inserted and
"authorized" by direct SQL (no "proposed" event, no audit row), which `private.move_job` cannot stop.
Decision:
- Gate: status codes next to "returns", "status", "a/one", or before "redirect", "status", "error", "URLs" are not
  claims. A number that appears in the site data the agent read (`dataNumbersOf`, without ids, dates, URLs and the
  gate's own feedback) counts as grounded. The gate checks spend against the budget the job ran with.
- Retry: only with 1.25 times the first attempt's cost left (`RETRY_HEADROOM`; was 0.8).
- Fact-checker: an unreadable verdict (not a refusal) is asked for once more, within the budget, before a person.
- Database (`20261126000000_job_guards.sql`): a trigger refuses queued/running/authorized/deploying on gated work
  without a latest "approve" row on any insert or status update; a deferred trigger gives a job inserted outside the
  job functions an event and a `job.insert_direct` audit row naming the database role and client.
Tradeoff: a number that happens to appear anywhere in the site data passes even if the agent used it wrongly; the
fact-checker still reviews publishable text, and people approve. Fewer retries mean slightly more reports go to a
person with the first attempt's output instead of a cut-off second one. Rejected: blocking direct inserts entirely
(the owner and the service role can always write; tracing them is what helps).

## D67 (2026-11-24): pilot with 2 to 3 invited clients, advice only, invoiced by hand
Context: the owner asked to start pilot work. Much of what a pilot needs exists already: invite-only sign-up, client
users who see no costs, per-site daily budgets with monthly cost on Operations (D50), alerts, the daily digest, the
monthly work report ("Work in <month>", printable) and the email sender (D40; it waits only for SMTP secrets). Missing
for a paying pilot: search results in the client report, numbers to invoice from, a measure of AI quality, terms and
privacy text, and a runbook.
Decision: no billing system and no self-serve sign-up yet. Add: (1) clicks and impressions from Google to the monthly
report, this month to date against the same days of the month before, from the stored Search Console history; (2)
`agency_usage(month)` and a CSV download on Operations (AI cost and work done per website); (3) `agency_quality(days)`
and an "AI report quality" card (share of AI reports needing a person, this week against the last); (4) draft terms and
privacy notice in `docs/pilot/` with bracketed items only the owner can fill; (5) `docs/pilot/PILOT-RUNBOOK.md`.
Tradeoff: invoicing by hand does not scale, but keeps the pilot free of payment code until the advice is shown to be
worth paying for. Month-to-date against the same days of the month before is fair early in a month but small samples
swing; the report states the days and the source. Rejected: Stripe now (price undecided, no proof yet); publishing the
legal drafts with invented company details.


## D68 (2026-11-26): the market (location and language) comes from the site's config; nothing is assumed
Context: `language_code: "en"` was hard-coded in the DataForSEO requests (also `hl=en` in SerpAPI and autocomplete,
`en-<country>` in Bing, language id 1000 in Keyword Planner, English in YouTube and Wikipedia and Wikidata), and a
missing or unknown country silently meant the United Kingdom. A site in Saudi Arabia (DataForSEO location 2682) in Arabic
got UK English data, and paid for it, with no warning.
Decision: each site has a `market`: `{ location_code | location, language_code | languages, country? }` (the first
language is primary). `src/lib/market.mjs` (pure) parses and validates it; every provider takes a resolved market and
refuses anything else (a bare "GB" included). Missing, unknown location, bad code or unsupported language throws before
any request, naming the config key and giving an example. A site's market is checked when the config loads if present; a
missing one is an error only for the jobs that call a provider (keywords, rank --serp, gap, optimize, citations, entity),
and `doctor` reports it (a failure when a paid key is set). Existing projects: `research.market` and `citations.market`
are no longer read; an error shows the equivalent location code (migration line in CHANGELOG and docs). Several
languages: each query, seed or question is researched in its own language when the site lists it and the text clearly is
in it (detector in `src/analysis/scope.mjs`), else the primary; `--language` or a per-question `language` overrides.
`init --market 2682:ar,en` writes it; without the flag init writes none and says so.
Tradeoff: a breaking change for upstream users of the research jobs (one config block fixes it); language detection is a
heuristic and falls back to the primary language, so a bilingual site should set `language` where it matters. Rejected:
keeping a GB/en default (the bug), a prompt-free default market in init (any default is a guess that costs money), failing
the whole config load when the market is missing (breaks audit-only users who need no market).

## D69 (2026-11-25): content-loss guard in seo-check; watch and revert for refreshes and new pages; the kill switch stops the watch
Context: a refresh drafted by an agent can shrink a page (a 2,000-word post cut to 300 words) and still pass the build,
the facts guard and the reviewer. `seo-watch` only watched the autopilot's own "undo"-level merges, only when
`SEO_AUTOPILOT` was on, and kept opening revert pull requests while the kill switch was on.
Decision:
1. `seo-check` runs a content-loss guard (`src/analysis/content-loss.mjs`, job `content-guard`) on every `seo/*` pull
   request, BEFORE install and build, so no pull-request code has run when it reads git. It fails when a changed page
   loses more than `contentGuard.maxWordDropPercent` (15) of its words, any heading with nothing in its place, any
   internal link, image or structured data, or the page itself. Settings come from the base branch's config. Words are
   counted with Unicode letter, digit and mark classes. A heading whose text changed while another of the same level
   appeared is a warning (rewording), not a failure: failing every reworded heading would block all snippet work.
2. Human-only override: label `allow-content-shrink`, accepted only when the latest "labeled" event for it is by a User
   account that is not the pull request's author; no readable events means no override (fail closed). No workflow adds it.
3. An exact undo passes: on a `seo/revert-<n>` branch, a file equal to its version before its latest change on the base.
   Without this, the undo-level revert of an internal-links change would fail the guard and never merge. The branch name
   is not trusted on its own (anyone who can push can name one): the pull request must be authored by the watch's account
   (`github-actions[bot]`, the workflow token) and its `seo-revert` label last added by that same account
   (`revertTrusted`). When seo-watch calls the check there is no pull_request event, so the step finds the pull request
   by branch. Fails closed: no pull request, no events or another actor means the restore is checked like any change.
   Residual gap: the implementer agent (`seo-implement.yml`) also runs with the workflow token, so it acts as the same
   account; closing that needs the implementer barred from `seo/revert-*` branches and the `seo-revert` label (that file
   has another owner).
4. `seo-watch` also watches every refresh and new page merged from a `seo/*` branch (by a person or the autopilot) for
   `watch.days` (28) after a 3-day lag, whether or not the autopilot is on; the list lives in `watch-content.json` on the
   `seo-data` branch. Refresh: same signals as the undo watch (error, added noindex, clicks against the untouched pages),
   judged daily once 14 days of data exist, the window capped at Search Console's last day with data. New page: the
   existing pages sharing most of its topic words are judged with the same click rule; it is unpublished when they lose
   clearly more clicks than the rest of the site and it did not win them back. Unpublish = the adapter sets `draft: true`
   (configurable, `content.unpublish`) and `hold: true`; never delete, never change the URL.
5. Reverts of refreshes and new pages are pull requests labelled `seo-revert` that always wait for a person; only
   undo-level reverts merge by themselves (unchanged). Alert: a comment on the original pull request.
6. `SEO_AUTOPILOT_PAUSED=true` now stops the whole `seo-watch` workflow and the `watch` job refuses to run. Before, the
   watch still opened revert pull requests while paused (documented behaviour, changed here). Tradeoff: while paused a
   regression is not even reported by the watch; the daily reports still show the click history. Reverts are stopped
   too: they wait for a person to merge anyway. The kill switch also stops `seo-backlinks` (browser, submit and
   screenshot steps, and the job refuses), live or dry; before, only `BACKLINKS_LIVE` controlled real submissions.
Rejected: failing every reworded heading (blocks snippet optimisation); a repository variable as the override (global,
not per pull request); auto-merging content reverts (a person merged the change, a person should undo it); deleting or
renaming a harmful new page (loses the work and breaks links).
Not verified: real GitHub runs of the changed workflows; the override's event read on a private repository (the check's
token has `contents: read` only, so it likely fails closed there); new-page cannibalisation on real Search Console data.
Review R1 (2026-11-25), changes to the above:
7. The guard runs from `$RUNNER_TEMP` with the base branch's config copied there (`--repo` points at the checkout), so no
   file of the pull request (`.npmrc` `node-options`, `package.json`, `node_modules`) is read or run before it. Every input
   (limit, site URL, skipped data/state folders, unpublish field) comes from the base config read through git. File names
   come from git with `core.quotepath=off` and `-z` (Arabic names were quoted and never matched).
8. Harm that keeps the words fails: page-setting keys (draft, published, status, noindex, robots, canonical, permalink,
   slug, url, redirect, sitemap, unlisted, hidden, private, `_build`...) in front matter, the top level of a JSON page and
   the HTML head; hidden and commented-out text is stripped before counting. A gone heading counts as reworded only when
   an added heading of the same level is similar (character-bigram Dice or containment >= 0.5); otherwise removed. The
   word drop is compared unrounded. Rejected for now: a cumulative 30-day budget across pull requests (after an approved
   override it would block every later edit of that page; with automerge off a person merges each change anyway).
9. Override tied to the head: the label event must be later than the head commit's committer time. Residual: committer
   time is set by the client; a person approving should read the final diff.
10. A trusted revert must also be exactly what seo-watch makes: the exact inverse of #n's merge (merge, rebase or squash)
    or exactly the adapter's unpublish of the pages #n added, and #n came from a `seo/*` branch (workflow passes
    `--revert-of`). The unpublish PR had to be accepted explicitly, since it now changes a page setting.
11. Watch: a page must fail on 2 check days in a row (streak saved in state); a new page not live is never unpublished, its
    window starts at max(merge, publishAt, first day seen live after being seen not live). `watch --git-revert` uses
    `-m 1` for merge commits and the whole range for rebase merges. Merged unpublishes are fetched again after 2 days:
    still 200 without noindex -> `revert-failed` and an issue (draft is ignored by some stacks).
12. Not done here: `issues: read` / `pull-requests: read` on the seo-check build job. Both callers (seo-autopilot.yml and
    seo-watch.yml) grant `contents: read` only, and a called workflow's job may not ask for more than its caller, so adding
    them in seo-check alone would make GitHub refuse both nested runs at startup. All three must change together (T7).
    Until then a private repository fails closed: no override, no trusted revert.

## D71 (2026-11-26): every model job on a Claude subscription; drafted pull requests always get check and review
**Decision.** No job needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Drafting, review and the weekly strategist/researcher run through `anthropics/claude-code-action` with `claude_code_oauth_token`. In-process helpers (`src/lib/llm.mjs`: news judging, wording, AI keyword ideas, digest) get a `claude-code` provider that runs the Claude Code CLI headless (`claude -p --output-format json --max-turns 1`, no tools, no MCP, no settings, input on stdin, API key removed from its environment), chosen by `llm.provider` in the config, `SEO_LLM_PROVIDER`, or by the token when no key is set. API-key providers stay. `seo-implement` starts `seo-check` and `seo-review` by `workflow_dispatch` from a separate job with `actions: write`; both post commit statuses (`seo-check`, `seo-review`) on the checked commit; `seo-automerge` reads check runs or those statuses.
**Why.** Anthropic's docs: the action and the CLI accept `CLAUDE_CODE_OAUTH_TOKEN`; the Agent SDK docs say third-party products may not offer claude.ai login without approval, so the Python runtime stays API-key only and the weekly agents moved to the action. A pull request opened with `GITHUB_TOKEN` starts no runnable `pull_request` workflows (observed: they are created as `action_required`). Dispatched and called runs record their check runs where the PR does not list them (observed: dispatched ones on the head commit but missing from the PR rollup; called ones on the caller's commit, which also meant the autopilot's merge step could never find its own check). Commit statuses do show on the PR.
**Tradeoffs.** A dispatched run's completion starts no `workflow_run`, so `SEO_AUTOMERGE` alone does not merge label-started drafts (the autopilot loop merges its own; a GitHub App or fine-grained token restores the normal path, documented). The subscription token is tied to one person's plan and its usage limits. Organisations that disallow "Actions can create pull requests" need that setting or a token.
**Review hardening (R1, same day).** `seo-check` posts its status on the commit its build job recorded (`git rev-parse HEAD`, or the pull request head for a `pull_request` run), also for same-repository `pull_request` runs; every caller grants `statuses: write` (a test compares caller and called permissions, after `seo-watch` was found to lack it, which would have stopped every revert run). `seo-automerge` trusts only the newest `seo-check`/`seo-review` status from `github-actions[bot]`, and refuses when any status with that name or any run of that workflow on the commit failed; check runs named `build` no longer count (`checks: read` replaced by `actions: read`). The CLI child gets an environment allowlist, not the job's environment minus one key. The drafter may create only `seo/issue-<n>` and may not label; a trusted step strips labels and copies the issue's kind. `seo-review` restores `.claude/`, `CLAUDE.md`, `.mcp.json` and the rest of the action's sensitive-path list from the base branch, because the action does that only for `pull_request` events and a dispatched run checks out the drafted branch. Tradeoff: a rerun that passes after a failure on the same commit no longer auto-merges (a person merges, or a new commit is pushed).

## D72 (2026-11-26): a cost guard in front of every DataForSEO call
(First written as D68 on the branch; renumbered because main already has D68-D71.)
Problem: DataForSEO is pay as you go from one account balance that other tools may share. The research jobs could spend without limit if a config listed many queries or a loop misbehaved.
Decision: one module, `src/lib/dataforseo.mjs`, is the only code that talks to `api.dataforseo.com` (a test scans `src/` to keep it so). Before a paid call: refuse when this month's ledger spend plus a deliberately high estimate passes `dataforseo.monthlyCapUsd` (default 8), or when the live balance minus the estimate would fall under `minBalanceUsd` (default 10), or when the balance cannot be read. After a paid call: add the response's own `cost` to `<state>/<site>/dataforseo-ledger.json`. A refusal throws `BudgetError` before any request and sends one alert per day per reason through a generic Telegram notifier (`TELEGRAM_*` env). Parallel calls reserve their estimates, so a burst cannot overshoot the cap.
Tradeoffs: the ledger lives in the state folder, so a run that skips `state restore` forgets the month's spend (the balance floor still holds, because it is read live); the cap is per site while the balance is per account; estimates are a guess (recorded cost is the truth, estimated calls are flagged in the ledger); a transient balance outage blocks paid calls until the next run (chosen over blind spending). Rejected: an unguarded default path for library users (the point is that nothing bypasses it), reading spend from DataForSEO's own usage reports (not a documented free per-month endpoint), failing the whole job on a refusal (rank and keywords keep their Search Console results and report the refusal).
Scope: the cap is per site and per state folder (`<state>/<site>/dataforseo-ledger.json`). Each site gets its own cap, and CI, a laptop and the UI each keep a separate ledger unless they share the state folder through `state restore`/`state save`. **The balance floor is the only account-wide limit.**
Review R3 (2026-11-26), changes to the above, each with a test in `test/dataforseo-guard-r3.test.mjs` that fails at a5d2d1a:
1. A paid request that throws (timeout, dropped connection) after it was sent is recorded at its estimate (`estimated`) and lowers the cached balance. Assumes DataForSEO bills a live call the client aborted (not verified); counting it is the safe side.
2. `state restore` starts fresh only on `git ls-remote` exit 2 (no such ref); any other failure throws. Templates save state on `always() && steps.restore.outcome == 'success'`, so a failed or cancelled run keeps its spend but a failed restore never pushes empty state over good state.
3. An endpoint with no price is refused unless the caller passes `{ estimateUsd }` (for the AEO engine's AI Mode / LLM endpoints); for priced endpoints the higher of table and caller estimate is used. Input lists (`keywords`, `targets`) count as items; `limit`/`depth` of 0 or less is refused; a leading `/` or `/v3/` is normalised. Rejected: a flat fallback price (R3 showed a $0.10 guess for a call that could cost $12.50).
4. Balance cache 60 s (was 10 min). The docs' example `user_data` response shows a limit of 6 calls a minute for it; one read a minute per ledger stays under it.
5. Alert memory moved to its own file (`<ledger>.alerts.json`), re-read after the send and merged; an alert never writes the money ledger, so it cannot overwrite spend recorded while it waited.
6. Reservations live in the ledger itself, changed under an O_EXCL lock file (stale after 10 s, wait up to 15 s, else `ledger-locked` refusal), so guards in one process and separate processes over the same state folder share the cap. A reservation older than 10 minutes (its run died mid-call) becomes estimated spend. Instead of a module-level registry returning one guard instance (each job needs its own name in the ledger), the shared state is the ledger file; balance readings are shared per account in a process (R3b H).
7. `seo-weekly` passes `TELEGRAM_BOT_TOKEN` (secret) and `TELEGRAM_CHAT_ID`/`TELEGRAM_THREAD_ID` (variable or secret) to every DataForSEO step.
8. `createCostGuard` throws `invalid-config` unless the cap and floor are numbers of dollars, 0 or more (no coercion: `"8"` is refused like `"abc"`, as config validation does). Ledger fields are validated: a wrong type, a truncated file, `{}` or `[]` refuse with `ledger-invalid`, alert once a day and leave the file untouched. The balance must be a JSON number. `writeJson` writes a temp file and renames it. Telegram error text has the bot token cut out.
9. The source scan covers every file type under `src`, `bin`, `scripts`, `engines` and `skills`: the API host however it is spelled (`api` + `dataforseo` + `com` in sequence) only in the guard; any file naming DataForSEO must be on a reviewed list; `memoryLedger`/`getBalance` only in tests and the guard. The scan is a heuristic, not a proof: it misses a host split across strings, base64 or reversed text. Review stays the real check; the scan catches the ordinary ways of writing the URL.
Review R3b (2026-11-26), changes after 2e22928, each with a test in `test/dataforseo-guard-r3b.test.mjs` (B in `test/dataforseo-guard.test.mjs`) that fails at 2e22928:
- A. After the `/` or `/v3/` prefix is stripped, an endpoint path must match `^[a-z0-9_]+(/[a-z0-9_]+)*$`; anything else (`..`, `.`, `%2e`, `\`, `?`, `//`, upper case, a trailing `/`) is refused with `bad-path` before any estimate or request. `serp/../on_page/...` no longer gets the SERP price.
- B. A response with no readable cost records the estimate (`estimated`) on every status except 401, 403 and 429 (key refused, rate limited: $0, not a call). A gateway 502/504 with an HTML body may have been billed, so a run of them trips the cap.
- C. A `sent` flag is set before the request. After that the reservation is removed only together with recording the cost; if recording fails, the reservation stays (still counted against the cap, settled as estimated spend after 10 minutes) and the error says so.
- D. The lock file holds a random token. Takeovers of a stale lock go one at a time through a second O_EXCL file (`.lock.takeover`, held for microseconds); under it the lock is looked at again, moved to a name only that process uses only if it is still stale, and removed only if the moved file is still the one that was seen (anything else is put back). While a stale lock exists nobody can create a new one, so a paused process can no longer remove a live lock created after its stat. A holder checks the lock still holds its token right before it writes (else `ledger-locked`, nothing written) and removes the lock only when it holds its token. Residual case: a live holder suspended past 10 s can lose its lock; it then writes nothing. (A first version without the gate lost no update but failed 3 of 6 runs of the six-process test with `ledger-locked`.)
- E. `costOf` accepts only a finite number of 0 or more (top level, or every task that gives one). A negative, `""`, `false`, `[]`, `" "` or any other value records the estimate, flagged.
- F. Estimates round up to the next millionth (a positive one is never $0), so a tiny `estimateUsd` cannot pass a cap of 0 or a full month.
- G. The ledger path is resolved with `realpath` (the file, or its folder when the file does not exist yet), so a ledger reached through a symlink is one ledger with one lock, and the symlink stays a symlink.
- H. Balance readings are per account (`DATAFORSEO_LOGIN`), not per ledger: each account keeps an in-process total of what its calls cost, and a cached reading is lowered by everything spent on the account since it was read, whatever the ledger. Two sites on one login in one process respect the floor.
- I. A ledger folder that cannot be written (EACCES, EPERM, EROFS) refuses with `ledger-unwritable` ("the spend ledger's folder cannot be written"), not `ledger-invalid`. A call marked `estimated` that runs past 10 minutes (a laptop asleep mid-call) is counted twice: once as the settled reservation, once at its real cost. That over-counts, the safe side, and is never reconciled automatically.

## D73 (2026-11-26): AI answer tracking reads Google AI Mode through DataForSEO
**Decision.** The `aeo` job and the `dataforseo` engine in `src/lib/ai-engines.mjs` support three modes; the default is `ai_mode` (`POST /v3/serp/google/ai_mode/live/advanced`, Saudi Arabia 2682, `ar` or `en`). `ai_overview` stays available as a second view; `llm_responses` stays available but is not the default. No model API keys: only DataForSEO credentials, always through the cost guard (D72), one guard per run plus `aeo.maxCostPerRunUsd`.
**Measured** (seo-ops Actions runs 45728916496 and 45729625635, fork 714d8d4, `ecomnemaa.com` Arabic and English buyer prompts, 15 prompts per mode: 10 Arabic, 5 English; total spend $0.3354, balance 36.118 to 35.783):
| | ai_mode | ai_overview | llm_responses (gpt-4.1-mini, web search on) |
|---|---|---|---|
| Arabic prompts answered | 10/10 | 10/10 | 10/10 |
| English prompts answered | 5/5 | 4/5 (one failed twice with task 40101, cost 0) | 5/5 |
| Answers with at least one source | 15/15 | 12/14 | 5/15 (Arabic 2/10, English 3/5) |
| Sources returned / not resolvable | 52 / 4 (93% usable) | 39 / 73 (35% usable: Google redirect links with no real host) | 28 / 0 |
| Cost per prompt | $0.004 | $0.004 | $0.0013 without a search, about $0.03 with one (mean $0.011) |
| Stability (3 prompts asked twice: share of sources in common) | 0.26, answered both times | 0.43, answered both times | 0.35, answered both times |
Our site: 0 mentions and 0 citations in all modes (45 answers, 2 runs). Plausible, not a defect: a separate probe found no ranked Arabic keywords for the domain. The detection itself was checked on the same live answers with another domain (help.salla.sa cited in 12 of 45, "سلة" mentioned in 19 of 45) and in unit tests with Arabic diacritics and prefixes; a positive hit for the tracked site has not been observed live.
**Why `ai_mode`.** Same price as the AI Overview but it returns direct source URLs (AI Overview lost 65% of its references to redirect links), it answered every prompt, and it always had sources; ChatGPT through LLM Responses rarely searched the web for Arabic prompts (2 of 10), so it mostly reports the model's memory, cost varies 25x per prompt and its sources lean to US sites. The AI Overview is what people see on the results page, so it is worth keeping as a second view when its extra reference rows are resolved.
**Estimate.** 25 prompts a week: `ai_mode` or `ai_overview` $0.10 ($0.43 a month); `llm_responses` about $0.27 (up to $0.75 if every answer searched); both Google modes $0.20. All far under the default $8 monthly cap.
**Pricing sources.** DataForSEO LLM Responses pricing page (https://dataforseo.com/pricing/ai-optimization/llm-responses): "The price for setting a task is $0.0006 in the Live mode and $0.0002 in the Standard mode", plus the LLM provider's price for the answer. The AI Mode pricing page (https://dataforseo.com/pricing/serp/google-ai-mode) gives no number in its text and the docs page (https://docs.dataforseo.com/v3/serp/google/ai_mode/live/advanced/) says "Your account will be charged for each request" and "The cost can be calculated on the Pricing page": the $0.004 is measured. Doc lines used: AI Mode "You can send up to 10000 API calls per minute, each Live SERP API call can contain only one task", language list from `/v3/serp/google/ai_mode/languages` (Arabic, `ar`, is listed); LLM Responses `user_prompt` "up to 500 characters", annotations "equals null if the web_search parameter is not set to true" and "may return empty even when web_search is true".
**Tradeoffs.** Samples are small (15 prompts a mode, three repeated); the stability figures are indicative. Google AI Mode is not available in every country (the docs say to check Google's list); an unavailable market returns no answer, which the report counts as "no answer", not as a failure of the site. The 40101 error was seen again (1 of 45 first tries failed twice); the engine retries once.
**Not done.** Resolving Google redirect links in AI Overview references (the opaque token cannot be decoded here); LLM Responses for Claude, Gemini or Perplexity; a scheduled workflow template (`templates/workflows/` belongs to the cost-guard branch).

## D74 (2026-11-26): languages per site, translation pairs, a Search Console country and language filter, an hreflang pair check, a style-guide hook
**Decision.** Three generic pieces for sites that publish in more than one language (first user: Arabic and English), all in the fork, none naming a site.
1. **Languages are the market's.** D68 already has `market.languages` (primary first); it stays the one declaration (no second `languages` key to disagree with it). New per-site keys: `translations` (groups of one page per language), `searchConsole` (`country`, `languagePaths`). Every language code in them must be one of `market.languages`; an unknown or unlisted code is a config error naming the key (`src/lib/languages.mjs`, called from `validate`). `searchAnalytics()` (used by `daily`, `digest`, `research`, `rank`; `gsc` has its own client) adds `dimensionFilterGroups`: the market's country as ISO alpha-3 (`sau`) unless `searchConsole.country` is `false` or another code, and, only when `languagePaths` is set, one language's pages (primary by default, `--language`, `all`). A country breakdown is never filtered by country.
2. **`hreflang` job**, a step in `seo-check` after the build: for each group both pages must link to each other and to themselves (`x-default` when `hreflang.xDefault`); one-way links are named. Warns and exits 0 unless `hreflang.block` is true. With `--base`, `block`, `xDefault` and `buildDir` come from the base branch's config and the groups are base plus head (same reasoning as D69: a pull request cannot loosen its own check; it also cannot drop a pair).
3. **Style guide.** Markdown rules with IDs (`### MSA-3 [blocking] title`, `Avoid:` lines of phrases). Built-in generic guide `knowledge/arabic-msa-style-guide.md`, applied to every site that has `ar` in its languages (off with `styleGuide.builtin: false`); the site adds `styleGuide.files.<lang>`, a path relative to the config; same ID replaces, new ID adds. It reaches the model by instruction, not by text pasted into a prompt: the `seo-implement` and `seo-review` prompts and the writer and editor agent files point at a shared skill (`language-style-guide`), which tells the agent which two files to read; the editor reports each violation with the rule ID. The `style` job prints the rules in force and finds the phrases and Latin punctuation after Arabic words a program can find; `seo-check` runs it on the changed content and only warns.
**Why.** English rows dilute Arabic click and position numbers; one-way hreflang pairs make Google ignore both pages; machine-translated Arabic ("الخاص بك", "تم الحفظ بنجاح") reads as a translation and is what reviewers kept correcting by hand.
**Tradeoffs.**
- The country filter is on by default for any site with a `market`, which changes its Search Console numbers (traffic from other countries drops out). `searchConsole.country: false` restores the old numbers.
- One set of report files: a run with `--language en` overwrites the primary-language run's files. Per-language state files are not built.
- Rules reach the model as "read these files" instructions, so compliance depends on the model following them; the deterministic `style` check and the editor's rule-ID report are the backstop. A rule that needs judgement (calques, register) is only the editor's call.
- The lint is phrase and punctuation level. It misses a calque that is not on a list.
- `hreflang` reads the HTML head from a build folder the site names (`buildDir`) or the live pages. It does not read hreflang in HTTP headers or sitemaps, and it does not guess the build folder (stacks differ).
- Settings come from the base branch, so a pull request that adds the first `hreflang` or `styleGuide` block takes effect after merge, not on itself.
**Not done.** Style guide text in `ask()`-based jobs (`news`, `mentions`, `digest`); per-language report files; hreflang in sitemaps or headers; a guide for languages other than Arabic (the hook supports one per language, only the Arabic one ships).
**Checks.** `npm test`: main 1924190 638 tests, 636 pass, 0 fail, 2 skipped; this branch 689 tests, 687 pass, 0 fail, 2 skipped (+51: `test/languages.test.mjs` 15, `test/hreflang.test.mjs` 16, `test/style-guide.test.mjs` 18, and 2 from `test/jobs-load.test.mjs`, one per new job). The three new test files fail on 1924190 (the modules do not exist there). All with injected fetch and local files; **no live Search Console, GitHub Actions or model run**.

## D76 (2026-11-26): a weekly AEO workflow template, opt-in, forced on schedule, report in the run summary
**Decision.** `templates/workflows/aeo.yml` (workflow `seo-aeo`): Mondays 04:00 UTC plus `workflow_dispatch` (`force`, `limit`). Restore state, run `aeo`, write the report to `$GITHUB_STEP_SUMMARY`, save state (`if: always() && restore succeeded`, as in `seo-weekly`). Only the run step holds the DataForSEO secrets and the `TELEGRAM_*` alert settings. The report is the job's own output (answers with AI content, mentions and citations, measured cost and cost per prompt, stop reason) plus one ledger line (this month's spend, all runs and jobs). No artifacts. It is its own file and not a step of `seo-weekly`, so its cost and failure are visible on their own and a project can adopt it without the rest.
**Why opt-in.** It spends money and needs an `aeo` block; a project that has neither would get a weekly no-op run. The schedule needs the repository variable `SEO_AEO=true` (same pattern as `SEO_RANK_LIVE`); a person can always dispatch it.
**Why the schedule is forced.** The job skips a run when the last one is newer than `aeo.schedule` (weekly = 7 days). Without `--force` a manual test run on a Thursday would make the next Monday (4 days later) skip silently. The workflow's own cron is the weekly period, so scheduled runs pass `--force`; manual runs follow the config unless `force` is ticked. A double run is bounded by `aeo.maxCostPerRunUsd` and the guard's monthly cap.
**Checked.** `test/workflows.test.mjs` (structure, pinned actions, no untrusted text in `run:`, no pull_request trigger, credentials in one step, state order, no artifacts, upgrade adds it). A local simulation of the steps (bare git remote as origin, stubbed DataForSEO host): first run records $0.008, a second run without force prints the skip message, a forced third run restores the ledger and the summary line reads $0.016 in 4 calls. That simulation found the state folder is `.seo-autopilot/<site id>`, not `seo-autopilot/state`, which the first draft of the summary step had wrong. Not run on GitHub Actions from this repository.
**Tradeoffs.** The ledger line reads the default state folder; a project with a custom `stateDir` still gets the report, without that line. The file is named `aeo.yml`, without the `seo-` prefix of the other templates (the brief for this task named it).

## D70 (2026-11-26): posts kept in a CMS are mirrored as Markdown files; merge publishes through the CMS API
Context: a site whose posts live in a CMS database (EmDash 0.1.0 here) has no files for the `markdown` adapter, the
pull-request review, the content-loss guard or `git revert`. Writing to the CMS directly from an agent would skip all of
them (rule 1, D17).
Decision: `seo-autopilot cms` keeps one Markdown file per post (flat JSON front matter, `baseRev`) in a git repository.
A pull request changes the file; merge publishes it (draft revision, publish, then the five SEO fields, then a read-back
that must match the file); revert publishes the previous file. Own Portable Text converter with a per-block round-trip
check and a JSON fence for anything it cannot represent, so export never loses content. Writes to a live post need proof
that the collection keeps revisions (schema, or `--revisions-proven` after `cms preview-check`), because without them a
draft save overwrites the live post. Drift is found by comparing the live post with the previous file, not by the
revision token (our own draft save changes it). Slugs are always explicit; new ones match a Latin pattern by default.
The revisions "restore" endpoint is never used (0.1.0 writes the live row and skips the cache purge).
Tradeoff: a second copy of the content that can go stale (export reports drift; the write refuses it); some blocks stay
as JSON lines; read-only fields (publish date, byline, images, terms) still change in the CMS admin. Rejected: editing
through the CMS admin with no mirror (no review or guard), EmDash's own Markdown converter (lossy), and `_rev` as the
conflict token.

Review R2 (2026-11-26): a write can only reach the file's own post, and only when nothing else is pending.
- A file with an `id` needs a base; the post must have the file's slug, not be trashed (0.1.0 hides trashed rows from
  get, so a 404 is refused, never recreated) and be `published`. A taken-down, scheduled or trashed post is never
  published again, even from an unchanged file.
- A pending draft is the mirror's own only when its whole data, `_slug` included, equals what the mirror would have
  saved (`{...live, ...draftData(version)}`) for the file, its base or one of its last 50 git versions; anything else is
  someone else's and stops the write (0.1.0 publishes `revision.data._slug` as the new slug). A new file reuses a draft
  with its slug only on the same test, and never a row that is scheduled, trashed or was ever published.
- "Live equals the new file except the SEO fields, which still equal the base" is a resumable state, so a failed SEO
  write after the content write is finished by a re-run instead of being reported as drift.
- `revisionsProven` lives in the per-site settings file (`--settings`); when present it overrides the flag and the
  environment, so a workflow cannot pass `--revisions-proven` past a `false`.
- Validate rejects front-matter values that are not JSON, indented or non-object JSON blocks and unclosed code fences;
  duplicate ids and slugs are reported on every file that has them.
- A save keeps the keys and link definitions of unchanged blocks and the post's strike mark name; `blank: false` links
  are plain links. Undoing a new post is an unpublish, not a `git revert` (the revert conflicts with the write-back).

Review R2b (2026-11-26): only the current file goes live; file names and post files are checked.
- A pending draft that equals an older version of the file may be overwritten, never published: when the pending
  draft is not the current file, the current file is saved as the draft first (also for an SEO-only change), and
  publish runs only after our own save or when the pending draft is the current file. The draft is re-read just before
  the publish call. 0.1.0's publish takes no revision token, so one round trip of race remains; the read-back reports it.
- Export skips slugs with path characters or a leading dot (0.1.0 stores explicit slugs as given), slugs used by more
  than one post (UNIQUE(slug, locale) allows the same slug per locale), and never writes through a symbolic link.
  Chosen over `<slug>.<locale>.md` names: it keeps one file name rule (`<slug>.md`) for validate, the URL pattern and
  the content-loss guard; a multi-locale site with shared slugs cannot mirror those posts yet.
- `validate` and `publish` refuse post files that are symbolic links or resolve outside the posts folder, so a merged
  `x.md -> ../../.git/config` is never read or written. `validate` defaults to the files' own folder and rejects an id on
  a file with no previous version. Front matter escapes U+2028 and U+2029.

## D77 (2026-11-26): `cms discard` for closed pull requests; files without an id keep working (review R8 F4, F5)
**Context.** Review R8 of the ops repository's publish-on-merge and preview workflows found two gaps in the mirror. F4: a pull request closed without merging leaves its preview draft on the live post; the next merged edit of that post is refused ("a draft this mirror did not make") and anyone pressing Publish in the admin publishes the closed text. F5: a new post published from a file leaves the file without an id (no write-back to the repository), and then its refresh gets no preview, its merge is refused, adding the id by hand is refused ("id changed") and the next edit is refused as drift.
**Decision 1, discard.** New `cms discard --file <file at the PR head> --base-ref <PR base>`. EmDash 0.1.0 has its own route for this: `POST /_emdash/api/content/{collection}/{id}/discard-draft` (0.1.0 package source: `src/astro/routes/api/content/[collection]/[id]/discard-draft.ts:14-54`, handler `src/api/handlers/content.ts:1070-1111`, repository `src/database/repositories/content.ts:1008-1042`, scope `content:write` from `src/astro/middleware/auth.ts:656`). It only sets `draft_revision_id = NULL` (the content row already holds the published version), keeps the revision row, purges the cache, and takes no `_rev`. The command removes a draft only when: writes are on (`revisionsProven: false` refuses before any request); the post is published (never an unpublished post: that would delete it); the pending draft equals what `draft` would have saved from one of the file's versions (the same `foreignDraft` check publish uses); the live post equals the file's previous version (`--base`/`--base-ref` required); the revisions guard passes. It re-reads the post just before the call and refuses if the draft revision id or the live post moved, then reads it back (exit 2 if the live post moved or a draft is left). Exit 4 when there is no pending draft, so a caller can treat "nothing to do" apart from a refusal. Refusals carry a machine-readable `refusal` code in the report.
**Decision 2, id-less files.** A file without an id may write to the published post that has its slug only when the live post equals one of the file's own committed versions at that path (`git log --format=%H -n 50 -- <file>` plus `git show <sha>:<file>`, compared on slug, title, excerpt, body, and SEO when both sides have it) and no other file in the folder has that slug or the post's id. No `--follow`: a version under another path had another slug. With a base, the usual drift check still applies on top.
**Decision 3, added read-only keys.** `validateFile` lets a read-only key go from absent (missing, null or "") to present and lists it (`addedReadOnly`, a warning). `draft`, `publish` and `discard` check each added key against the CMS post before any write (categories and tags read the way export reads them) and refuse on a mismatch. A key that changes from one value to another is still an error. An export commit after a new post is then a no-op, not red.
**Decision 4, SEO only when the file has it.** `partsFor(a, b)` compares the SEO fields only when both states have them; used by `writePlan` (already-matches, drift, changes) and the id-less match. A file without SEO keys never writes them (publish skips `setSeo`), so the CMS's SEO row is not drift for it. Before, such a file was refused as drifted ("seo") on its first edit.
**Why not write the id back.** The brief asked for no write to the repository from the publish job (a push from a job that holds the CMS token, branch protection unavailable on the plan). The id-less rule keeps the proof in git history, which the job already has.
**Tradeoffs and limits.** Discard and publish both lack a revision token in 0.1.0, so a draft saved between the re-read and the call is discarded (it stays in the revision history) or published (the read-back reports it). A file without an id can claim a published post that has no mirror file if one of its committed versions is an exact copy of that post; every post that converts back has a file after an export, so this concerns posts created in the admin since the last export, and a reviewer sees a new file that duplicates a live page. A file that adds SEO keys for the first time writes them with no drift check on SEO. Discard cannot remove an unpublished post made from a closed pull request's new file; a person deletes it in the admin.
**Checked.** `test/cms-discard-idless.test.mjs` (23 tests, stand-in plus real local git repositories): discard success, foreign draft, an editor's draft over ours, no draft (4), live changed, writes off (0 requests), no base, unpublished post, a draft saved between the re-read and the call, dry run, Arabic slug, id-less closed preview; id-less refresh preview and publish, retried publish, admin edit refused, a post the mirror did not make refused, a second file for the same post refused, id added right and wrong, wrong read-only value, export after a new post, a file renamed in history (edit in the move refused, pure rename accepted), Arabic id-less post, writes off for draft, publish and discard (0 requests). R8's simulation re-run against this branch: see the ops repository evidence `T16`.
**Amended 2026-11-26 after review R10 (verdict: merge after fixes).** The Leader decided each point below; the code change is `fad3e77`.
- **F1, autosave.** The re-read before discard now also compares `_rev`. The admin editor autosaves 2 seconds after typing with `skipRevision: true`, which rewrites the existing draft revision in place under the same id (0.1.0 `src/emdash-runtime.ts:1484-1486`). Every save still bumps the row's version and `updated_at`, so `_rev` changes (`src/database/repositories/content.ts:548-549`, `src/api/rev.ts:19-21`). With no `_rev` on either read, the draft's words are compared again instead.
- **F6/F7, claim gap (replaces decision 2's "any committed version").** An id-less file claims a published post only when the post's words equal the file's version at `--base`/`--base-ref`, or already equal this version. Without a previous version, only an exact match counts, and then nothing is written. History no longer counts:
  - a pull request could supply the proof itself (a first commit copying a live page, then a rewrite; a merge commit then published over the owner's post);
  - a path reused for an unrelated article matched the exported file removed from it.

  The claim is added to the report's `highRisk`. Residual: a copy that reaches the default branch through its own reviewed pull request can be updated by the next one. That first pull request shows a whole new file duplicating a live page.
- **F4.** No pending draft returns exit 4 before the scheduled, base, claim and ownership checks; that path writes nothing.
- **F2.** A published post with `scheduledAt` set is refused (`scheduled`), on the first read and on the re-read. A person's schedule is never dropped (0.1.0 keeps `status = 'published'` and sets `scheduled_at`, `src/database/repositories/content.ts:797`).
- **F5, which pull request made the draft.** A marker is not possible in 0.1.0:
  - A revision stores only `data` and `authorId` (`src/database/repositories/revision.ts:8-15`), and `authorId` would also change the live row's author.
  - A `_`-prefixed data key is accepted (`contentUpdateBody.data` is `z.record`) and skipped on publish (`src/database/repositories/content.ts:1056-1059`) and by the loader (`src/loader.ts:162-169`).
  - But the admin's "restore revision" strips only `_slug` and passes every other key to `contentRepo.update`, which writes each one as a column (`src/api/handlers/revision.ts:112-118`, `src/database/repositories/content.ts:577-582`). Restoring any revision the mirror made would then fail.

  So the fallback applies: discard accepts only a draft equal to the file at the closed pull request's head (or a no-change draft), never an earlier push or older history. That alone does not separate a stacked pull request B from its open parent A when B's head still holds A's file. New `--keep-refs a,b` refuses (`kept-ref`) when the draft equals the file at another ref; the ops job passes the other open pull requests' heads.
- **F8.** A file whose previous version had no SEO keys and that now has them is refused as drift when the CMS's SEO is non-empty and differs (`writePlan`). An empty CMS SEO is set.
- **F9.** Removing every SEO key from a file that had them is a `validate` error with the way to clear them (keys set to null, `noIndex: false`).
- **Decisions 2 to 4 (Leader):**
  - discard keeps refusing never-published posts (`not-published`);
  - the publish/discard one-round-trip race is accepted for explicit saves, now that F1 is fixed;
  - exit 4 means success for the ops job.
- **Checked:**
  - 11 new tests, red on `8b4903d` first (10 failed, 1 stand-in check passed);
  - `npm test` 780/778/0/2;
  - R10's sim adapted to assert each fix: 20/20 on `fad3e77`, 10/20 on `8b4903d`;
  - R8's walk unchanged (31/36, same as round 1).

  Evidence is in the ops repository, `T16/round2`.

**Amended 2026-11-26 after review R8 round 2, item 1 (stuck published point).** Code change `9039b94`.
- **Problem.** A publish run that goes red on one file still publishes the others. The caller's published point (its `--base-ref`) stays behind. The next edit of a file that went out was refused ("the CMS changed outside the mirror"), because live already held the version after the point, and the refusal repeats on every later run until a person works out the right point.
- **Decision.** In the drift check of a file that already owns its post (an id, or an id-less claim that passed), live may also equal the file at a commit in `--base-ref..HEAD` that touches it, on HEAD's first-parent history (`rangeVersionsOf`: `git log --first-parent <base-ref>..HEAD -- <file>`, at most 200). That version then serves as the previous version for the drift, resume and first-time-SEO checks; the report names it (`liveMatchedVersion`).
- **Kept separate from the claim.** `claimProblem` is unchanged: only the `--base-ref` version or this version prove an id-less claim (R10 F6/F7). The window is only consulted after ownership is settled.
- **Why first-parent.** It is what each merge put on the branch being published. A merged branch's intermediate commits were never on the branch, so a live text equal to one of them was not published by the mirror from this branch.
- **Tradeoffs and limits.**
  - Every version in the window was reviewed and merged into the published branch, so accepting live at one of them never overwrites an admin edit. It can overwrite a revert that a person made in the admin back to an earlier version in the window; the mirror would have done the same on a green run.
  - With `--base` (a file) there is no window.
  - A red run that published a file's content but failed its SEO write is not covered: live then equals no single version in the window.
- **Checked.**
  - 4 tests, `test/cms-discard-idless.test.mjs` "R8r2 stuck point": the id case failed before the change; the three guards (admin edit, first-parent and window start, claim) each fail under a matching mutation.
  - `npm test` 784/782/0/2.
  - R8's round-2 sim with the stuck-point scenarios asserting the fix: 35/35 on `9039b94`; the same assertions fail on `53a1026` (32/35).
  - R10's sim 20/20 and R8's walk 31/36, both unchanged. Evidence: ops repository, `T16/round2/r8r2`.
