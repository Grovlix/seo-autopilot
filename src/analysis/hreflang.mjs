// The hreflang check for declared translation groups (D74). Pure: no network, no files. The job reads the pages.
// A group is one page in each language: { ar: "https://s.test/ar/x/", en: "https://s.test/en/x/" }. For every ordered pair
// (page, other language's page) the page must carry an alternate link to the other page. A link that only one side has is
// reported as one-way, on the page that lacks the return link (Google ignores a pair whose links are not reciprocal).
// This checks the pages the site declares, in the HTML head. The audit's `hreflang-*` rules check whatever a crawl finds.

/** One URL, compared without the fragment, the host's case, a trailing slash or a trailing index.html. */
export function urlKey(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/index\.html?$/i, "/").replace(/\/+$/, "") || ""}${x.search}`;
  } catch { return String(u || ""); }
}

const langOf = (code) => String(code || "").toLowerCase().split("-")[0];
const FIX = {
  "page-missing": "Build the page, or fix the path in translations.",
  "link-missing": "Add <link rel=\"alternate\" hreflang=\"{lang}\" href=\"{target}\"> to the page's head.",
  "link-one-way": "Add the return link <link rel=\"alternate\" hreflang=\"{lang}\" href=\"{target}\"> to this page: Google ignores pairs whose links are not reciprocal.",
  "link-wrong-target": "Point the hreflang=\"{lang}\" link at {target}.",
  "no-self": "Add a self-referencing hreflang link: each page lists itself and its alternates.",
  "x-default-missing": "Add <link rel=\"alternate\" hreflang=\"x-default\" href=\"{target}\"> to the page's head.",
  "x-default-wrong": "Point hreflang=\"x-default\" at {target} (the {lang} page), the page for visitors in no listed language.",
};
const finding = (id, page, lang, target, detail, group) => ({ id, group, page, lang, target, detail, fix: FIX[id].replace("{lang}", lang).replace("{target}", target || "") });

/**
 * groups: [{ <lang>: url }]; pages: { [url]: { found, alternates: [{ hreflang, href }], error? } }.
 * xDefault: false (not required), or the language code whose page x-default must point at.
 * Returns { checked, findings: [{ id, group, page, lang, target, detail, fix }] }. checked = pages looked at.
 */
export function checkHreflang({ groups, pages, xDefault = false }) {
  const findings = [];
  let checked = 0;
  groups.forEach((g, gi) => {
    const entries = Object.entries(g);
    const links = (url) => pages[url]?.alternates || [];
    const points = (url, lang, to) => links(url).some((a) => a.hreflang.toLowerCase() !== "x-default" && langOf(a.hreflang) === lang && urlKey(a.href) === urlKey(to));
    for (const [lang, url] of entries) {
      const p = pages[url];
      checked++;
      if (!p?.found) { findings.push(finding("page-missing", url, lang, null, p?.error || `${url} could not be read`, gi)); continue; }
      if (!points(url, lang, url)) findings.push(finding("no-self", url, lang, url, `${url} does not list itself`, gi));
      for (const [other, target] of entries) {
        if (other === lang || !pages[target]?.found || points(url, other, target)) continue;
        const to = links(url).find((a) => a.hreflang.toLowerCase() !== "x-default" && langOf(a.hreflang) === other);
        if (to) { findings.push(finding("link-wrong-target", url, other, target, `${url} has hreflang="${to.hreflang}" pointing at ${to.href}, not at ${target}`, gi)); continue; }
        const back = points(target, lang, url);
        findings.push(finding(back ? "link-one-way" : "link-missing", url, other, target, back ? `${target} links to ${url} but ${url} does not link back` : `${url} has no hreflang link to ${target} (and it has none to ${url})`, gi));
      }
      if (xDefault) {
        const want = g[xDefault];
        const x = links(url).find((a) => a.hreflang.toLowerCase() === "x-default");
        if (!x) findings.push(finding("x-default-missing", url, xDefault, want, `${url} has no x-default link`, gi));
        else if (want && urlKey(x.href) !== urlKey(want)) findings.push(finding("x-default-wrong", url, xDefault, want, `${url} has x-default pointing at ${x.href}, not at ${want}`, gi));
      }
    }
  });
  return { checked, findings };
}

/** File names a page can be built to under the build folder, in order: "/ar/x/" -> /ar/x/index.html. Never leaves the folder. */
export function pagePathCandidates(url) {
  let path;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return []; }
  path = path.split("/").reduce((out, seg) => { if (seg === "..") out.pop(); else if (seg !== "." && seg !== "") out.push(seg); return out; }, []).join("/");
  const slash = /\/$/.test(new URL(url).pathname);
  const abs = `/${path}`;
  return slash || !path ? [`${abs}${path ? "/" : ""}index.html`] : [abs, `${abs}.html`, `${abs}/index.html`];
}

/** Plain-English Markdown report of a check result. */
export function hreflangMarkdown({ date, groups, result, blocking, source, notes = [] }) {
  const lines = [`# hreflang pairs (${date})`, "", `Checked ${result.checked} page(s) in ${groups.length} translation group(s), read from ${source}. ${result.findings.length} problem(s)${result.findings.length ? (blocking ? "; they block the check" : "; they warn only (hreflang.block is false)") : ""}.`, ...notes.map((n) => `\n${n}`)];
  if (result.findings.length) {
    lines.push("", "| Problem | Page | Detail | Fix |", "|---|---|---|---|");
    for (const f of result.findings) lines.push(`| ${f.id} | ${f.page} | ${f.detail} | ${f.fix} |`);
  }
  return lines.join("\n") + "\n";
}
