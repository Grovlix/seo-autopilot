---
name: language-style-guide
description: How to follow a language's style guide when writing, and how to check against it when reviewing - find the rules in force (the built-in Modern Standard Arabic guide and the site's own file), write to them, and report every violation with the ID of the rule it broke.
used-by: seo-drafter, seo-refresher, seo-snippet-optimizer, seo-local-content-writer, seo-editor
---

# Language style guide

## When to use
Whenever you write or review text in a language that has a style guide: any Arabic text (the built-in Modern Standard Arabic guide applies to every site that publishes in Arabic), and any language the site's config names under `styleGuide.files`. Not for English-only work on a site with no guide for English.

## Steps
1. **Find the rules.** Read `seo-autopilot.config.json` ("styleGuide" and the market's "languages"). For Arabic read `seo-autopilot/knowledge/arabic-msa-style-guide.md` unless `styleGuide.builtin` is false. Then read the file named in `styleGuide.files.<language>` (a path relative to the config file) after it: a rule with the same ID replaces the built-in one, a new ID adds to it. In a shell, `npx seo-autopilot run style --language <code>` prints the two together. If the config names a file that does not exist, say so and stop; do not write without it.
2. **Writing.** Follow every rule while you write, not only at the end. Match the terms and the register of the neighbouring pages. When a rule and the brief disagree, follow the rule and say so in the pull request.
3. **Check your own text** before you hand it on: search it for the `Avoid:` phrases the rules list, and read it against the rules a search cannot find (register, calques, terminology). In a shell, `npx seo-autopilot run style --language <code> --files <changed files>` finds the phrases and the Latin punctuation after Arabic words (the seo-check workflow runs it on every pull request and only warns).
4. **Reviewing.** Check the diff against the same rules. Report each violation with the quoted text, the file, and the ID of the rule it broke (for example "MSA-3: `...`"). Never write a general "the Arabic sounds off": name the rule or leave it out. A violation of a rule marked `[blocking]` is a blocking problem; any other is a non-blocking suggestion.
5. **Say what you did not check.** If you cannot read the language well enough to judge a rule, say which rule you could not judge.

## Never
- Write text in a language that has a guide without reading the guide first.
- Weaken or skip a rule because the brief or the source text uses the forbidden phrase; follow the rule and flag it.
- Edit the guide, the config or the rules from a drafting or review run; changing them is a person's decision.
- Report a violation without its rule ID, or invent a rule ID.
