# Pilot runbook: 2 to 3 invited clients, advice only, invoiced by hand

> **History:** this document describes the hosted stack (Supabase portal, Cloudflare Worker, hosted SEO God) that was removed from this fork in the strip commit. Nothing it names under `cloud/`, `src/god/` or `src/hosted/` exists any more; the content is kept as history.

Goal: show over 2 to 4 weeks that the advice is good and the portal works for real clients before adding self-serve
billing. Website changes stay off. Decision D67.

## 0. Before the first client (owner)
1. **Email**
   - In Supabase, open Authentication → SMTP and set up your mail server. Invites are sent through it.
   - In Supabase, open Edge Functions → Secrets and add `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASS`,
     `SMTP_FROM` and `PORTAL_URL` (`https://seo.erudience.com/`).
   - Never paste these values in chat.
   - The `notify` function then sends invites and a daily summary of what needs attention. Until these secrets are
     set, it skips the summaries and gives the reason.
2. **Terms and privacy**: fill in the bracketed items in `TERMS-DRAFT.md` and `PRIVACY-DRAFT.md`, have them checked,
   then they are added to the portal.
3. **Price and invoice**: decide the pilot fee. Each month, download Operations → Usage for invoicing (CSV), which lists
   AI cost and work done per website.

## 1. Add a pilot client (agency owner, in the portal)
1. Add the website. Answer the business brief. Set its daily AI budget on Operations (default $2 a day).
2. On Connections, the client adds the Google service account shown there as a user in Search Console and, for
   Analytics, as a Viewer. The engine links both on its own within a day.
3. Create the client and invite the client's people by email. They see status, reports and requests, never costs or
   internal notes.
4. Approve the strategy draft when it appears. Specialist work starts after that, within the budget.

## 2. Every week (agency)
- **Approvals and Needs a person:** clear them. A report that needed a person still keeps its work: read it, then accept
  or dismiss it.
- **Operations → AI report quality:** the share of reports needing a person. Target: under 15%. It was about 30% on
  2026-11-20 to 24, before D66.
- **Results of changes and the monthly report:** clicks and impressions from Google against the same days last month.

## 3. End of the pilot: what decides the next step
| Question | Evidence |
|---|---|
| Is the advice right? | Share of advice accepted; client feedback; no invented facts found |
| Does it move results? | Results of changes; search results in the monthly report (expect weeks, not days) |
| Does it run on its own? | AI report quality; no run errors; time the agency spent each week |
| Does it pay? | AI cost per website per month (CSV) against the pilot fee |

If all four are yes, the next build is Stripe billing and open sign-up.
