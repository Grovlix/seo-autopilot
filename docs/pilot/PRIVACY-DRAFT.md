# Privacy notice (DRAFT, not legal advice, not published)

> **History:** this document describes the hosted stack (Supabase portal, Cloudflare Worker, hosted SEO God) that was removed from this fork in the strip commit. Nothing it names under `cloud/`, `src/god/` or `src/hosted/` exists any more; the content is kept as history.

Status: draft for the owner and a legal reviewer. Every `[BRACKETED]` item must be filled in by the owner. Nothing here
is published until the owner approves it. The facts below describe what the system does today (checked against the code
on 2026-11-24); if the system changes, this draft must change with it.

## Who we are
SEO Autopilot is operated by [LEGAL ENTITY NAME], [REGISTERED ADDRESS], [COMPANY NUMBER IF ANY].
Contact for privacy questions: [CONTACT EMAIL].

## What we collect, and why
| Data | Where it comes from | Why |
|---|---|---|
| Your name and email address, and your agency's name | You, when you request an invite or create an account | To let you sign in and to contact you about your account |
| The address of each website you add, and its public pages | You add the address; our crawler reads the public pages | To check the website for technical and content problems |
| Answers in the business brief (what the business does, who it serves, its goals) | You | So the advice fits the business |
| Search data: clicks, impressions, positions and index status per page and search term | Google Search Console, read-only, only after you give our Google service account access | To measure results and find what to improve |
| Visits per landing page | Google Analytics 4, read-only, only after you give access | Same |
| Requests and messages you send in the portal | You | To answer them |
| Records of what the system did and who approved what | The system | So every change and decision can be traced |

We do not collect payment card details in the portal. [IF BILLING IS ADDED, DESCRIBE IT HERE.]

## Who processes it for us
- **Supabase** (database and sign-in), region [SUPABASE PROJECT REGION].
- **Cloudflare** (runs the scheduled engine).
- **Hostinger** (hosts the portal page).
- **Anthropic** (the AI model that writes the advice). It receives the website data needed for a task: public page
  content, search data and the business brief. [CHECK AND STATE ANTHROPIC'S DATA RETENTION TERMS FOR THE API ACCOUNT USED.]
- **Google** (Search Console and Analytics, read-only, using the access you grant).
- [EMAIL PROVIDER, ONCE EMAIL IS SWITCHED ON.]

## How long we keep it
[RETENTION PERIOD, e.g. while the account is active and N months after it closes.] You can ask us to delete your
account and its data at [CONTACT EMAIL].

## Your rights
[LIST THE RIGHTS THAT APPLY UNDER THE GOVERNING LAW, e.g. UK GDPR: access, correction, deletion, objection, complaint
to the ICO.]

## Cookies and storage
The portal keeps you signed in using your browser's local storage. It sets no advertising or tracking cookies.
[CONFIRM BEFORE PUBLISHING; UPDATE IF ANALYTICS IS ADDED TO THE PORTAL.]

## Changes
We will post changes here and tell account owners by email. Last updated: [DATE].
