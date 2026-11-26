# Arabic style guide (Modern Standard Arabic)

A generic house style for Arabic text on any site: formal Modern Standard Arabic (الفصحى), no dialect, no machine-translation calques. It is a convention, not a search-engine rule. Drafting agents follow it, the editor checks against it, and `run style` lists the rules in force and checks files against them. A site adds its own rules (brand spelling, terms, tone, reader) in a file named in `seo-autopilot.config.json` under `styleGuide.files.ar`; see [docs/arabic.md](../docs/arabic.md).

## How the rules are written
- Each rule has an ID, a title and a short explanation. A violation is always reported with the ID of the rule it broke, for example "MSA-3 at line 12: `تم الحفظ بنجاح`".
- A rule marked `[blocking]` blocks a review. The others are listed as non-blocking suggestions.
- A line starting with `Avoid:` lists exact phrases in backticks. `run style --files` finds them (diacritics ignored, a one-letter prefix such as و or ب allowed). The editor also looks for the same idea in other words.
- A site file may use the same ID to replace a rule, or a new ID to add one.

## Rules

### MSA-1 Formal Modern Standard Arabic, no dialect
Write in formal Modern Standard Arabic. No dialect words, spellings or sentence shapes, even when the reader speaks that dialect. The register is that of a clear, courteous article, not of a chat message or a legal text.
Avoid: `ايش`, `إيش`, `ليش`, `عشان`, `لسه`, `دحين`, `وايد`

### MSA-2 [blocking] No machine-translation calques
Write the sentence the way a native writer would, not the English sentence in Arabic words. Typical calques: a possessive with "الخاص بك" or "الخاصة بك" where the suffix ـك is enough (حسابك, not الحساب الخاص بك); "قم بـ" + a verbal noun where a plain verb works (أضف المنتج, not قم بإضافة المنتج); "يقوم بـ" + a verbal noun for any action ("يضيف" is shorter); "في نهاية اليوم", "على أساس يومي", "بالنسبة لـ" as filler; English word order in headings. If a sentence reads like a translation, rewrite it from the meaning.
Avoid: `الخاص بك`, `الخاصة بك`, `الخاص بكم`, `الخاصة بكم`, `في نهاية اليوم`, `على أساس يومي`

### MSA-3 No stock interface phrases
Say what actually happened, specifically, instead of a template message. Not "تم الحفظ بنجاح" but what was saved ("حُفظت التغييرات"). No success or failure boilerplate that fits any screen.
Avoid: `تم الحفظ بنجاح`, `تمت العملية بنجاح`, `تم التنفيذ بنجاح`, `تم بنجاح`

### MSA-4 Consistent terms
One Arabic term for one concept across the whole site. Do not alternate between near synonyms for the same thing (متجر / محل, تاجر / بائع) from one page to the next. Use the term the neighbouring pages and the site's glossary already use. A foreign term gets its Arabic equivalent first, with the original in parentheses once, only when readers may search for the original.

### MSA-5 Arabic punctuation in Arabic text
Use the Arabic comma "،", semicolon "؛" and question mark "؟" in Arabic sentences, never the Latin `,` `;` `?` directly after Arabic words. Punctuation marks that belong to a URL, code or an English phrase stay as they are. Keep one digit style (0-9 or ٠-٩) across the site.

### MSA-6 Short, direct sentences
One idea per sentence, usually under 25 words. Active voice, the doer named. Put the answer first and the condition after it. No stacked genitive chains (إضافة، إدارة، تحسين، ...) that hide the verb.

### MSA-7 One way of addressing the reader
Address the reader the same way across a page, in the singular or the plural, and do not switch halfway. Do not use slash forms for gender (ـ/ـة) or parenthetical plurals.

### MSA-8 Correct spelling
Spell hamza correctly (أ إ ء ؤ ئ), ta marbuta against ha, and ya against alef maqsura. Add diacritics only where they prevent a wrong reading, and in a brand name only when the site's own guide says so.

### MSA-9 Names and quotation marks
Brand and product names are written exactly as their owner writes them, in the script they use. Use one quotation style across the site (the site's guide says which). Titles of pages and buttons are quoted the same way each time.

### MSA-10 Native headings
Headings and titles are written natively, not translated from an English template. A question heading is a question a reader would type, in natural Arabic word order.
