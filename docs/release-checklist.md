# Release checklist

Use for every engine release. Tick each line in the PR description.

## Engine release (vX.Y.Z)
- [ ] `npm test` green on the release commit (also on CI: Node 20 and 22, Go, Python)
- [ ] `node scripts/build-registry.mjs` leaves no diff
- [ ] `CHANGELOG.md` has `## X.Y.Z` on top; `package.json` version matches
- [ ] `node scripts/build-site.mjs` regenerated `site/`
- [ ] Docs match the code: `docs/jobs.md`, `docs/registry.md`, `docs/deployment-status.md`
- [ ] Merged by the owner; tags through Actions > tag-release (`v2`, `v2-stable` moved only for a stable release)
- [ ] One real site upgraded (`seo-autopilot upgrade --diff`, then `--apply`) and its next scheduled run checked green

