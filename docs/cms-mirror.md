# CMS mirror (EmDash)

Some sites keep their posts in a CMS database instead of files in git. The `markdown` adapter and the pull-request flow (review, the content-loss guard, `git revert`) need files. The CMS mirror bridges the two: each post is kept as one Markdown file in a git repository, a pull request changes the file, and merging publishes it through the CMS API. The CMS stays the place the site reads from.

Supported CMS: [EmDash](https://github.com/emdash-cms/emdash) 0.1.0 (REST content API, Portable Text bodies). Code: `src/cms/` (client `emdash.mjs`, converter `portable-text.mjs`, file format and checks `mirror.mjs`, commands `commands.mjs`). No dependencies.

## File format

`<dir>/<slug>.md`, flat front matter with JSON values (strings in double quotes, `null`, `true`/`false`, `["a","b"]`), then the body in Markdown. A value that is not JSON (a single-quoted or bare string) is an error in `validate`, so a title is never published with its quote marks.

| Key | Editable | Notes |
|---|---|---|
| `id` | no | CMS id. Empty for a post that does not exist yet. |
| `slug` | new posts only | Never changed for an existing post: a URL change needs a person and a redirect. New slugs must match `--slug-pattern` (default lowercase Latin, digits and hyphens), because the CMS keeps explicit slugs as given and its automatic slug drops non-Latin letters. |
| `title`, `excerpt` | yes | Title up to 200 characters. |
| `seoTitle`, `seoDescription`, `seoImage`, `canonical`, `noIndex` | yes | Sent to the CMS only at publish (they go live at once on any write). `canonical` must be an http(s) URL. |
| `status`, `publishedAt`, `categories`, `tags`, `image`, `imageAlt`, `byline`, `locale` | no | Read-only copies of the CMS, for review and for the content-loss guard. |
| `baseRev` | no | The CMS revision token at the last export or publish. Informational: conflicts are found by comparing content (below). |

Body: headings, paragraphs, bold, italic, inline code, strike-through, links, bullet and numbered lists (two spaces per level), block quotes, fenced code, images, hard line breaks (`\` at the end of a line). Every block is checked on export: it is rendered, parsed back and compared. A block that would not come back identical (an empty paragraph, a custom block type, an unusual mark) is kept as one line of JSON, `<!--ec:block {...} -->`. Leave those lines alone or delete them whole. `validate` rejects a broken one, one that is not a JSON object with a `_type`, one that does not start at the beginning of its line (it would publish as text), and a code fence that is never closed (it would swallow the rest of the post).

## Commands

All print a JSON report on stdout. Connection: `EMDASH_URL` (or `--url`) and `EMDASH_TOKEN` (environment only). The token needs the `content:read` scope, and `content:write` for `draft`, `publish` and `preview-check`. https is required except for localhost.

| Command | What it does | Writes to the CMS |
|---|---|---|
| `cms export --dir posts [--sitemap /sitemap.xml] [--status published\|all]` | One file per post. A post whose body would not convert back unchanged is skipped and listed, and so are posts whose slug cannot be a file name (path characters, a leading dot) and slugs used by more than one post (the same slug in two locales); export then exits 1. Export never writes through a symbolic link. Reports pending drafts, posts missing from the sitemap, and files for posts the CMS no longer lists (never deleted). | no |
| `cms validate --dir posts [--files a.md,b.md] [--base-ref origin/main]` | Checks the files (slug, file name, lengths, types, broken JSON blocks, empty body, symbolic links, duplicate ids and slugs across `--dir` or else the files' own folder, an `id` on a file that has no previous version; a duplicate is reported on every file that has it, so `--files` sees it too). With a base: read-only keys and slugs of existing posts must not change; `noIndex` turned on and `canonical` changes are listed as high risk. No network. | no |
| `cms schema` | Can the token read the collection settings; are revisions and SEO on. | no |
| `cms preview-check --title "..." --slug throwaway-slug` | Creates one throwaway draft (or reuses it), proves that a draft save leaves the row alone (revisions), asks for a preview link and opens it, checks the public URL is 404, the draft is not in the sitemap or RSS, and a few published pages keep their status and word count. | one draft, never published |
| `cms draft --file posts/x.md --base-ref origin/main` | Saves the file as a draft revision and asks for a preview link. The live page does not change. | draft only |
| `cms publish --file posts/x.md --base-ref <commit before the change> [--write-back]` | Saves the draft, publishes it, sets the five SEO fields if they differ, then reads the post back and compares it with the file. If the SEO write fails after the content went live, run the same command again: it sees that only the SEO fields are missing and finishes. `--write-back` refreshes `id`, `status`, `publishedAt` and `baseRev` in the file. | yes |

Common options: `--settings site.json` (a JSON file with any of `collection`, `fields`, `urlPattern`, `taxonomies`, `sitemap`, `rss`, `revisionsProven`; flags override it, except `revisionsProven`, below), `--collection posts`, `--fields title=title,excerpt=excerpt,body=content,image=featured_image` (field names in the collection), `--url-pattern /posts/{slug}` (public URL of a post), `--taxonomies category,tag`, `--dry`.

Exit codes: 0 ok, 1 error or invalid files, 2 published but the CMS does not match the file afterwards, 3 refused for safety.

## Safety rules

- **Revisions must be proven before any write to a live post.** On a collection without revisions, EmDash 0.1.0 writes a draft save straight to the live post. `draft` and `publish` read the collection settings first; a content-only token cannot (403), so they refuse (exit 3) unless revisions are marked as proven. Keep that in the settings file (`"revisionsProven": true`), set only after `preview-check` reported `"revisions": true` on that site. When the settings file has `revisionsProven`, it decides: `--revisions-proven` or `EMDASH_REVISIONS_PROVEN=true` cannot turn a `false` into a write. A `false` in the settings file refuses every `draft` and `publish` (exit 3), also an SEO-only edit and also when the schema shows revisions, so writes stay off until a person commits `true`. With `--dry`, nothing is written and the report says `"writesOff": true`. Without a settings file, the flag or the variable is used. `preview-check` is not covered by this setting: it creates or reuses one throwaway draft (never published) to prove revisions. It is a write, so run it only when the site's owner has agreed.
- **A file only writes to its own post.** A file with an `id` needs `--base` or `--base-ref`; the post with that id must have the file's slug, must not be in the trash, and must be published. A post an editor took down, scheduled or trashed is never published again by the mirror, even from an unchanged file.
- **Drift stops the write.** The live post must still match the previous version of the file. If someone edited the post in the CMS admin after the export, the write is refused: export again first. Re-running a publish that already landed is a no-op, not drift.
- **Only the current file goes live.** A pending draft equal to an older version of the file (a publish that failed before a revert, say) is replaced by the current file before anything is published, also for an SEO-only change. Just before the publish call the draft is read again; if someone saved over it, nothing is published (exit 3).
- **The mirror folder is a plain folder inside the repository.** It must sit inside the git repository that holds it (outside any repository: inside the working folder), with no symbolic link in its path below that point. `export`, `validate`, `draft` and `publish` refuse (exit 3) otherwise, so a linked `posts/` cannot make them read or write elsewhere.
- **Post files are plain files inside the posts folder** (`--dir`, or else the file's own folder). `validate` and `publish` refuse symbolic links and anything that resolves elsewhere, and never read them.
- **Someone else's unpublished draft stops the write.** Publishing would publish their draft too, including a pending slug (URL) change. A pending draft counts as the mirror's own only when its whole data, slug included, equals what the mirror would have saved from this file, its base, or one of its last 50 git versions.
- **After a draft save**, the live post is read again: if it moved, the command stops with exit 2 and says so.
- **Revert = publish the previous file.** `git revert` the change, then `cms publish` with `--base-ref` set to the reverted commit. If the publish being undone stopped halfway (content live, SEO write failed), first finish it by running that publish again; a revert of a half-done publish is refused as drift. The revisions "restore" endpoint is never used (in 0.1.0 it writes the live row and skips the cache purge).
- **New posts** need an explicit slug. A re-run reuses the draft with that slug only when the draft was made from this file (same check as above); a slug that belongs to a published, scheduled or trashed post, or to someone else's draft, is refused.
- The token is never printed. Reports list each call as method, path and status only. A CMS URL with a user name or password in it is refused.

## In a pull-request workflow

1. A change to `posts/*.md` opens a pull request. CI runs `cms validate --dir posts --files <changed> --base-ref origin/<default>` and the content-loss guard (below). Optional: `cms draft` per changed file and post the preview link in the pull request.
2. A person (or the autopilot policy, for routine changes) merges.
3. On the default branch, a job runs `cms publish --file <changed> --base-ref HEAD^1 --settings site.json --write-back` per changed file and commits the write-back. High-risk changes (`noIndex`, `canonical`) and new posts should keep needing a person, as in decision D17.
4. To undo a change to an existing post: revert the merge commit; the same job publishes the old file. To undo a new post, unpublish it in the CMS (or with a separate unpublish step); reverting its merge commit conflicts with the write-back commit that added its `id`.

The content-loss guard (`src/analysis/content-loss.mjs`, `textFacts`) reads mirror files directly: ATX headings, `[text](url)` links, `![alt](src)` images and the front-matter `image`. Mirror files also expose the same facts through `fileFacts()` in `src/cms/mirror.mjs` (words, headings, links, images, opaque blocks) and `validate` reports `before.words` when given a base. Note: CMS media URLs such as `/_emdash/api/media/file/<key>` may have no file extension, so a guard that counts images by extension will not see them.

## Known limits

- Written against EmDash 0.1.0. Other versions are not tested.
- A draft saved by someone else in the last moment before the publish call (after the re-read) is still published with ours: 0.1.0's publish takes no revision token. The read-back after publish then reports the difference (exit 2).
- A site with the same slug in two locales cannot mirror those posts (one file per slug); they are skipped and listed.
- The preview link needs `EMDASH_PREVIEW_SECRET` set on the site. Without it `draft` reports `previewError: NOT_CONFIGURED` and `preview-check` reports the preview as not ok; everything else still works.
- EmDash 0.1.0's content loader (`getEmDashEntry`) does not read the SEO table, so a template that calls `getSeoMeta(entry)` falls back to the title and excerpt. SEO fields written by `publish` are stored and returned by the API, but such a template does not show them. Check the template before relying on `seoTitle` or `seoDescription`.
- `publishedAt`, bylines, featured images and taxonomy terms are read-only here; change them in the CMS admin and export again.
- A save rebuilds the body from the Markdown. Blocks whose content did not change keep their original keys and link definitions; changed and new blocks get new keys. The strike mark keeps the name the post already uses (`strikethrough` or `strike-through`). Links with `blank: false` are plain links; links with other extra settings (new tab) stay as JSON blocks.
- Tested end to end against a local EmDash 0.1.0 with a local database (export, edit, draft, preview, publish, re-run, revert). Unit tests use an in-memory stand-in of the API.
