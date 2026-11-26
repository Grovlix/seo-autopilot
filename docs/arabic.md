# Arabic and other languages: languages per site, translation pairs, hreflang check, style guide

Generic: nothing here assumes a script, a country or a stack. Arabic is the worked example because the built-in style guide is Arabic.

## 1. Languages, translation pairs and the Search Console filter

The languages a site publishes in are the market's: `"market": { "location_code": 2682, "language_code": "ar", "languages": ["ar", "en"] }`. The first is the default (see [configuration.md](configuration.md#market)). Every language code anywhere in the config must be one of them; an unknown or unlisted code is a config error that names the key.

```json
{
  "market": { "location_code": 2682, "languages": ["ar", "en"] },
  "translations": [
    { "ar": "/ar/store/", "en": "/en/store/" },
    { "ar": "https://example.com/ar/pricing/", "en": "/en/pricing/" }
  ],
  "searchConsole": {
    "country": true,
    "languagePaths": { "ar": "/ar/", "en": "/en/" }
  }
}
```

- `translations`: one group per page, each language mapped to its page (a path starting with `/`, or a URL of this site). A group has at least two languages; a page is in one group only. The hreflang check below reads these groups.
- `searchConsole.country`: Search Console queries are filtered to the market's country (`true`, the default when the site has a `market`), to another country (a two-letter code, for example `"AE"`), or not at all (`false`). The `gsc` job's own country breakdown is never filtered to one country.
- `searchConsole.languagePaths`: where each language lives. When it is set, queries are also filtered to the pages of one language: the primary language by default, `--language en` for another, `--language all` for every page. A language at `"/"` means "every page outside the other languages' folders". A language you ask for that has no path is an error, not a silent no-filter.
- The filter applies to every Search Console query: `daily`, `digest`, `research`, `rank` and `gsc`. A site with no `market` and no `searchConsole` block queries as before.

**Limit.** The jobs write to one set of report files (`daily-summary.md`, `gsc-rows.json`, `query-daily.json` ...). Running a job once with `--language ar` and once with `--language en` overwrites the first run's files with the second's. Use `--language` for a one-off look, and let the scheduled runs use the primary language.

## 2. The hreflang pair check (`run hreflang`)

`seo-check` runs it after the build. For each translation group, every page must carry `<link rel="alternate" hreflang="..." href="...">` for itself and for each other language's page, and the other pages must link back. A link only one side has is reported as `link-one-way` on the page that lacks the return link.

| Finding | Meaning |
|---|---|
| `page-missing` | the page is not in the build folder (or did not answer 200 with `--live`) |
| `link-missing` | neither page links to the other |
| `link-one-way` | one page links, the other does not link back |
| `link-wrong-target` | the page has an hreflang for that language but it points somewhere else |
| `no-self` | the page does not list itself |
| `x-default-missing`, `x-default-wrong` | only when `hreflang.xDefault` is set |

```json
"hreflang": { "buildDir": "dist", "xDefault": "ar", "block": false }
```

- `buildDir`: the folder the build writes the pages to. Pages are found by path: `/ar/store/` is `dist/ar/store/index.html`, `/en/store` is `dist/en/store`, `dist/en/store.html` or `dist/en/store/index.html`. Without it pass `--dir <folder>`, or `--live` to read the published pages. With neither the check says so and skips (and fails if `block` is true).
- `xDefault`: `true` (every page needs `hreflang="x-default"` pointing at the primary language's page), a language code (point at that language's page) or `false` (default, not required).
- `block`: `false` (default) warns and exits 0; `true` exits 1 on any problem.
- A region code such as `ar-SA` counts as the language `ar`. A trailing slash or `index.html` difference is the same page.
- The check reads the HTML head only. hreflang in HTTP headers or in the sitemap is not read (the audit's `hreflang-*` rules cover what a crawl finds).
- In `seo-check` it runs with `--base origin/<base branch>`: `block`, `xDefault` and `buildDir` come from the base branch's config, and the groups are the base branch's plus the pull request's, so a pull request cannot loosen the check or drop a pair to dodge it.

## 3. Style guide in the writer and reviewer prompts

A style guide is a Markdown file of rules. Each rule is `### <ID> [blocking] <title>` with an explanation; a line `Avoid: ` lists exact phrases in backticks that a program can find.

- **Built-in:** [`knowledge/arabic-msa-style-guide.md`](../knowledge/arabic-msa-style-guide.md): formal Modern Standard Arabic, no dialect, no machine-translation calques (`الخاص بك`, `قم بـ`), no stock interface phrases (`تم الحفظ بنجاح`), consistent terms, Arabic punctuation `،` `؛` `؟`, short direct sentences. It applies to every site that publishes in Arabic. `"styleGuide": { "builtin": false }` turns it off.
- **The site's own file:** `"styleGuide": { "files": { "ar": "style/ar.md" } }`, a path relative to the config file, added after the built-in guide. A rule with the same ID replaces the built-in one; a new ID adds one. Brand spelling, the reader, the quotation style, glossary terms: put them there.
- **Writers** (`seo-drafter`, `seo-refresher`, `seo-snippet-optimizer`, `seo-local-content-writer`) and the **editor** read the guide through the shared skill `language-style-guide`; the `seo-implement` and `seo-review` prompts tell them to. The editor reports each violation with the quoted text and the **rule ID it broke**; a violation of a `[blocking]` rule blocks the review, any other is a non-blocking suggestion. A changed guide file counts as a non-content change and blocks (the agents never edit the rules).
- `npx seo-autopilot run style [--language ar]` prints the rules in force (and writes `<state>/style-ar.md`). `run style --files a.md,b.json [--language ar|all] [--strict]` checks files for the `Avoid:` phrases and for a Latin `,` `;` `?` right after Arabic words (rule `MSA-5`), skipping URLs, code spans and code blocks; JSON pages are checked on their string values. It exits 1 only with `--strict` when a `[blocking]` rule is broken. `seo-check` runs it on the changed content and only warns.
- The program finds phrases and punctuation. Register, calques that are not on a list, and terminology need a reader: that is the editor's part, and why every violation carries a rule ID.

**Not covered:** a model-written text that does not go through `seo-implement` and `seo-review` (the `ask()` helpers of `news`, `mentions`, `digest`) is not given the guide; text in a language other than Arabic has a guide only if the site names a file for it.
