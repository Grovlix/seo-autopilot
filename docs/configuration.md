<!-- Editors can validate and autocomplete the config with schema/seo-autopilot.config.schema.json: add "$schema": "https://raw.githubusercontent.com/bishal-paul-git/seo-autopilot/main/schema/seo-autopilot.config.schema.json" to the file. -->
# Configuration reference

One file, `seo-autopilot.config.json`, in the root of your repository. Paths are relative to it.

```json
{
  "stateDir": ".seo-autopilot",
  "dataDir": "seo-autopilot",
  "stateBranch": "seo-data",
  "sites": [
    {
      "id": "example",
      "name": "Example",
      "url": "https://example.com/",
      "searchConsoleProperty": "https://example.com/",
      "sitemap": "https://example.com/sitemap.xml",
      "indexNow": { "keyEnv": "INDEXNOW_KEY" },
      "inspectPerDay": 60,
      "indexNowPerDay": 10,
      "ga4PropertyId": null,
      "market": { "location_code": 2840, "language_code": "en" },
      "ignoreQueries": ["example"],
      "brandTerms": ["Example"],
      "content": { "type": "sitemap" },
      "schedule": { "perDay": 3 },
      "release": { "deployHookEnv": "DEPLOY_HOOK_URL" },
      "labels": { "proposal": "seo-proposal", "topic": "seo-topic", "approved": "approved", "digest": "seo-digest", "backlink": "seo-backlink", "indexing": "seo-indexing" },
      "limits": { "proposalsPerRun": 3, "topicsPerWeek": 2, "newsTopicsPerRun": 1 },
      "ingest": { "urlEnv": "SEO_INGEST_URL", "tokenEnv": "SEO_INGEST_TOKEN" }
    }
  ]
}
```

## Top level

| Key | Default | Meaning |
|---|---|---|
| `stateDir` | `.seo-autopilot` | where each run keeps its memory (one folder per site). Saved to the state branch by the workflows |
| `dataDir` | `seo-autopilot` | the files you edit: `feeds.json`, `topics.json`, `backlinks/` |
| `stateBranch` | `seo-data` | git branch holding the saved state (one force-pushed orphan commit, reports only, never secrets) |
| `llm` | none | optional AI step for judging, wording and ideas: `{ "provider": "claude-code" \| "anthropic" \| "openai" \| "none", "model": "sonnet" }`. `claude-code` runs the Claude Code CLI on your Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`, no API key). Without `provider`, whichever login is set is used (an API key first). `SEO_LLM_PROVIDER` and `SEO_MODEL` override it. See [jobs.md](jobs.md#run-everything-on-a-claude-subscription) |

## Site

| Key | Meaning |
|---|---|
| `id` | lowercase letters, digits, dashes. Unique |
| `url` | must be `https://` and end with `/` |
| `searchConsoleProperty` | the property exactly as in Search Console: the URL with trailing slash, or `sc-domain:example.com` |
| `sitemap` | full URL of the sitemap (index files are not followed; use the page sitemap) |
| `indexNow.keyEnv` | name of the env var/secret holding your IndexNow key |
| `ga4PropertyId` | numeric GA4 property id, or `null` |
| `ignoreQueries`, `brandTerms` | brand queries are never turned into topic proposals |
| `feeds`, `topicsConfig`, `backlinksDir` | override the default file locations under `dataDir` |
| `limits` | caps on proposals and topics, plus the content-pace limits `pagesPerDay` (2), `pagesPerWeek` (8) and `perTemplatePerDay` (off) |
| `review` | sensitive-topic gate: `topics` (keyword lists) and `requireFields` (default `author`, `reviewedBy`) |
| `thinIgnore` | URL path patterns (`*` wildcard) of pages that are meant to be short; the thin-content rule skips them. Example: `["/contact", "/book", "/tools/*"]` |
| `retired` | URL path patterns of pages removed or redirected on purpose; left out of not-indexed counts and request lists |
| `business` | the name, phone and address you confirm, for example `{ "name": "Example Dental", "phone": "+44 20 7946 0000", "address": "1 High Street, Leeds LS1 1AA" }`. The `local` job flags pages that disagree |
| `verticals` | specialist packs for this kind of business: `["local"]`, `["ecommerce"]`, both, or `[]` for none. Without it, packs are detected from the site profile (business or product markup, the shop platform, `local: true`). It also decides which pack agents `init` and `upgrade` install. See `departments/verticals/packs.json` |
| `language` | language the site publishes in (`en`, `en-GB`, `es`...); queries clearly in another language are not proposed as topics |
| `market` | **where and in which language the site is researched.** Required by every job that calls a search or keyword provider; see [Market](#market) below. There is no default |
| `translations` | the same page in each language, one group per page: `[{ "ar": "/ar/store/", "en": "/en/store/" }]`; language codes must be in `market.languages`. Read by the hreflang check. See [arabic.md](arabic.md) |
| `searchConsole` | `{ "country": true, "languagePaths": { "ar": "/ar/", "en": "/en/" } }`: Search Console queries are filtered to the market's country (default) and, with `languagePaths`, to one language's pages (the primary one unless `--language`). See [arabic.md](arabic.md#1-languages-translation-pairs-and-the-search-console-filter) |
| `hreflang` | `{ "buildDir": "dist", "xDefault": false, "block": false }`: settings of the hreflang pair check in `seo-check` |
| `styleGuide` | `{ "files": { "ar": "style/ar.md" }, "builtin": true }`: the site's own writing rules per language, added to the built-in Arabic guide, read by the writer and reviewer prompts |
| `dataforseo` | cost guard for paid DataForSEO calls: `monthlyCapUsd` (default 8) and `minBalanceUsd` (default 10); see [DataForSEO cost guard](#dataforseo-cost-guard) |
| `citations` | `market` is no longer read: use the site's `market` (see the migration note below) |
| `ingest` | optional dashboard sync, see [dashboard.md](dashboard.md) |

## Market

Every provider call (live search results, keyword ideas and volumes, a competitor's ranked keywords, autocomplete, Keyword Planner, YouTube, Wikipedia, the entity lookup) takes its location and language from the site's `market`. Nothing is assumed: a missing, unknown or misspelt market stops the job with an error before any request is sent, so no paid search is bought for the wrong country or language.

```json
"market": { "location_code": 2682, "language_code": "ar", "languages": ["ar", "en"] }
```

| Key | Meaning |
|---|---|
| `location_code` | the DataForSEO location code (the same number is the Google Ads geo target id). Example: `2682` Saudi Arabia, `2840` United States, `2826` United Kingdom |
| `location` | instead of `location_code`: a country name from the table below, or its two-letter code (`"Saudi Arabia"`, `"SA"`, `"UK"`). Give one of the two, not both |
| `language_code` | the primary language, an ISO 639-1 code from the list below (`"ar"`, `"en"`) |
| `languages` | optional, for a site that publishes in several languages; the first is the primary one (and must equal `language_code` when both are given). With only `languages`, `language_code` is its first entry |
| `country` | optional two-letter country code, needed only when `location_code` is not in the table (a city or region): `{ "location_code": 1006886, "country": "SA", ... }`. Several providers want a country, not a location code |

**Several languages.** A request uses one language. Each query, seed or question is researched in the language it is written in when the site has that language and the text clearly is in it (Arabic script, or a clear run of English, Spanish, French and so on words); otherwise in the primary language. Set `--language ar` on `keywords`, `rank`, `gap`, `optimize`, `citations` or `entity` to force one language for the run, or `"language": "en"` on a question in `questions.json` to force it for that question (also `"market": "AE"` to research that one question in another country). A language the site does not list is an error. `gap` uses the primary language unless you pass `--language`.

**Errors you may see** (all name the config key and give an example): `market: missing`, `unknown location "Atlantis"`, `not a valid location code`, `location 123 is not in the built-in table, so name its two-letter country code`, `language "xx" is not supported`, `language_code "en" is not the first of languages`, `language: "fr" is not one of this site's languages`. `seo-autopilot doctor` reports the market of each site (a warning when it is missing, a failure when a key that spends money, such as `DATAFORSEO_LOGIN` or `BRAVE_API_KEY`, is set).

**Setting it.** `init --market "2682:ar,en"` (location, then languages; the location may be a code, a name or a two-letter code) writes the block. Without `--market` init writes none and says so; add it by hand later.

**Migrating an existing project.** Earlier versions read a two-letter country from `research.market` or `citations.market` and fell back to the United Kingdom and English when neither was set. Both keys are now ignored (`doctor` warns), and a research job in a project without `market` stops with a message that includes your old value converted to a location code. Add the block above; use the language your site is researched in, which the old code always assumed to be English. Audit, daily and other jobs that call no research provider need no market.

**Supported locations** (name, code, country code): United States 2840 US, United Kingdom 2826 GB, Canada 2124 CA, Australia 2036 AU, New Zealand 2554 NZ, Ireland 2372 IE, South Africa 2710 ZA, Saudi Arabia 2682 SA, United Arab Emirates 2784 AE, Egypt 2818 EG, Kuwait 2414 KW, Qatar 2634 QA, Bahrain 2048 BH, Oman 2512 OM, Jordan 2400 JO, Lebanon 2422 LB, Iraq 2368 IQ, Morocco 2504 MA, Algeria 2012 DZ, Tunisia 2788 TN, Germany 2276 DE, France 2250 FR, Spain 2724 ES, Italy 2380 IT, Netherlands 2528 NL, Belgium 2056 BE, Switzerland 2756 CH, Austria 2040 AT, Portugal 2620 PT, Poland 2616 PL, Sweden 2752 SE, Norway 2578 NO, Denmark 2208 DK, Finland 2246 FI, Greece 2300 GR, Czechia 2203 CZ, Romania 2642 RO, Hungary 2348 HU, Turkey 2792 TR, Russia 2643 RU, Ukraine 2804 UA, Israel 2376 IL, India 2356 IN, Pakistan 2586 PK, Japan 2392 JP, South Korea 2410 KR, Singapore 2702 SG, Malaysia 2458 MY, Indonesia 2360 ID, Philippines 2608 PH, Thailand 2764 TH, Vietnam 2704 VN, Hong Kong 2344 HK, Taiwan 2158 TW, Brazil 2076 BR, Mexico 2484 MX, Argentina 2032 AR, Colombia 2170 CO, Chile 2152 CL, Nigeria 2566 NG, Kenya 2404 KE. Aliases: `UK`, `USA`, `UAE`, `KSA`. Any other DataForSEO location code works with a `country`.

**Supported languages:** en, de, fr, es, it, ja, da, nl, fi, ko, no, pt, sv, ar, cs, el, hi, hu, id, he, pl, ru, ro, uk, tr, vi, ur, th (ISO 639-1; the Keyword Planner language ids are built in). Provider coverage differs: a provider may not offer every language in every location, and it then answers with its own error, which the job reports. Checked against Google's published lists (geotargets of 2026-10-06 and the language codes table): every location id, name and country matches except that Google writes Turkey as "Turkiye" (accepted as an alias), Hong Kong 2344 and Taiwan 2158 appear only as the parent ids of their regions, and Hebrew is `iw` in Google's list but `he` here. Not checked against a live DataForSEO or Brave account.

## Content adapters (`content`)

The adapter tells the autopilot what pages exist, so it never proposes a duplicate and can schedule and count pages.

```jsonc
{ "type": "sitemap" }                       // zero config, read-only: coverage check only, no scheduling
{ "type": "json", "include": ["src/content/**/*.json"],      // arrays of page objects
  "routes": [{ "match": "guides.json", "urlPattern": "/blog/{slug}" }] }
{ "type": "markdown", "dir": "content/blog", "ext": [".md", ".mdx"], "urlPattern": "/blog/{slug}" }
```

An entry can state its own address with `"path": "/partners/agencies"`; that wins over `urlPattern`. Use it for hubs and nested pages that a `/{section}/{slug}` pattern cannot describe.

Page fields it understands: `slug`/`id`, a title (`h1`, `title`, `name`, `term` or `metaTitle`), `primaryKeyword`/`keyword`, `faqs` (`q` or `question`), and the drip fields `publishAt` (YYYY-MM-DD), `queued` (approved, not dated) and `hold` (never schedule). Scheduling and release need `json` or `markdown`.

### Unpublishing (`content.unpublish`)

When `seo-watch` finds that a new page is taking clicks from the pages around it, it takes the page off the site without deleting it: it sets `"draft": true` (and `"hold": true`) on the page. Set `"unpublish": { "field": "published", "value": false }` inside `content` if your site uses another field. Your build must leave such pages out (see [content-automation.md](content-automation.md#making-your-site-respect-publishat)); not every stack does by default. Two days after the unpublish is merged the watch checks that the page is gone (an error status or a noindex); if it still answers 200, the entry is marked `revert-failed` and an issue is opened. The content-loss guard reads this setting from the base branch, to recognise the watch's own unpublish pull requests.

## Content-loss guard (`contentGuard`) and watch (`watch`)

| Key | Default | Meaning |
|---|---|---|
| `contentGuard.maxWordDropPercent` | `15` | most words a changed page may lose in a `seo/*` pull request before `seo-check` fails. Removing any heading, internal link, image or structured data always fails. Read from the base branch's config, so a pull request cannot change its own limit |
| `watch.content` | `true` | watch every refresh and new page merged from a `seo/*` branch and open a revert pull request when it does harm (`false` turns it off) |
| `watch.days` | `28` | days each change is watched after the lag |
| `watch.lag` | `3` | days skipped after the merge while search engines pick the change up |
| `watch.minSpan` | `14` | days of Search Console data needed after the lag before clicks are compared |

See [content-automation.md](content-automation.md#watch-and-revert-after-merging-seo-watch) for the rules.

## Data files you edit (in `dataDir`)

- `feeds.json`: `[{ "id", "name", "url", "category": "regulator|platform|industry", "region" }]`
- `topics.json`: `keywords` (term to weight 1-3), `minScore`, `maxItemAgeDays`, `proposeCategories`, `proposeFeedIds`, `minScoreWithoutAi`, `draftRules` (appended to topic issues)
- `backlinks/`: see [backlinks.md](backlinks.md)

## Environment variables and secrets

See [jobs.md](jobs.md). To run every AI job on a Claude subscription with the one secret `CLAUDE_CODE_OAUTH_TOKEN`, see [Run everything on a Claude subscription](jobs.md#run-everything-on-a-claude-subscription).

## DataForSEO cost guard

DataForSEO is pay as you go from one account balance, so every call to it (live search results, keyword ideas, ranked keywords and the competitor gap, referring domains) goes through a guard in `src/lib/dataforseo.mjs`. Nothing calls `api.dataforseo.com` without it.

```json
"dataforseo": { "monthlyCapUsd": 8, "minBalanceUsd": 10 }
```

- `monthlyCapUsd` (default 8): the most this site's jobs may spend in one calendar month (UTC). The guard adds a generous estimate for the call it is about to make to the month's recorded spend; if the sum would pass the cap, the call is refused.
- `minBalanceUsd` (default 10): the guard reads the live balance from the free `GET /v3/appendix/user_data` (cached for 60 seconds, so another program spending from the same account is seen within a minute; the docs' example response lists `user_data` at 6 calls a minute). If the balance minus the estimates of this call and the calls in flight would fall under this, the call is refused. If the balance cannot be read (or is not a JSON number), the call is refused too: no blind spending.
- **Scope.** The cap counts one ledger: one site in one state folder. Each site has its own cap, and a laptop, the UI and CI each keep their own ledger unless they share the state folder (`state restore` / `state save`). **The balance floor is the only limit for the whole account**, so set it with every site and every other tool on the account in mind. Within one process, every guard on the same login sees what the others spent since the last balance reading.
- A refusal is a `BudgetError` thrown before any request. The job records it as a note (rank and keywords keep their Search Console results) and the next calls in the same run are refused without a request as well. `err.reason` says why: `monthly-cap`, `min-balance`, `balance-unavailable`, `no-estimate`, `bad-path` (an endpoint path with anything but lowercase letters, digits and `_` joined by single `/`), `ledger-invalid`, `ledger-locked`, `ledger-unwritable` (the ledger's folder cannot be written), `invalid-config` or `no-guard`.
- Estimates: a deliberately high price per call from a table (SERP, Labs, backlinks, keywords data), counting `limit`/`depth` or the size of an input list (`keywords`, `targets`), whichever is larger. A `limit` or `depth` of 0 or less is refused. An endpoint with no price in the table is refused unless the caller gives its own estimate: `guard.post(path, tasks, { estimateUsd: 0.5 })` or `guard.task(path, task, { estimateUsd: 0.5 })`, a positive number of US dollars for the whole call (for a priced endpoint the higher of the two is used). Paths may start with `/` or `/v3/`.
- Ledger: after each paid call the response's own `cost` is added to `<state>/<site>/dataforseo-ledger.json`, per month, per job and per endpoint (`months["2026-11"].jobs.rank.endpoints["serp/google/organic/live/advanced"] = { usd, calls }`). Only a finite number of 0 or more counts as a cost. When a response carries no such cost (on success or on any error other than 401, 403 or 429), or the request timed out or dropped after it was sent (it may have been charged), the estimate is recorded and counted in `estimatedCalls`. Before a call starts, its estimate is reserved in the ledger (`reserved`), so parallel jobs and parallel processes on the same state folder see each other; changes are made under a lock file (`dataforseo-ledger.json.lock`, holding a random token of the run that holds it). A symlinked ledger is followed to its real file. If a call was sent but its cost cannot be recorded, its reservation stays and counts. A reservation left by a run that died mid-call is counted as spent after 10 minutes. A ledger that is not valid JSON or has the wrong shape refuses every call and is left as it is for a person to check (with an alert).
- State: the state folder is what `seo-autopilot state save` keeps on the `seo-data` branch. `state restore` starts fresh only when that branch does not exist; when origin cannot be reached it fails, so a run never starts the month's spend again from zero by accident. The shipped workflows save state after failed or cancelled steps too (`if: always() && steps.restore.outcome == 'success'`), so a run's spend is kept, but never after a failed restore, which would push empty state over the good one.
- Alert: when the guard refuses, one message per day per reason is sent through Telegram if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set (`TELEGRAM_THREAD_ID` selects a forum topic). The text is HTML-escaped and contains no secrets. Without those variables nothing is sent and the refusal is still reported in the job output. The "once per day" memory is a separate file next to the ledger (`dataforseo-ledger.alerts.json`). The shipped `seo-weekly` workflow passes them to every DataForSEO step: the bot token from the secret `TELEGRAM_BOT_TOKEN`, the chat and topic from the repository variables (or secrets) `TELEGRAM_CHAT_ID` and `TELEGRAM_THREAD_ID`.
