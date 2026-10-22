# gocolllancer — Pre-Deploy Checklist

Jainik's standing rules, enforced as a checklist. **Every item must be true before
any deploy of gocolllancer.** Deploy = Vercel deploy, GitHub push that triggers a
deploy, or any prod-environment change.

## Permission gate
- [ ] (a) **Explicit permission from Jainik.** NEVER deploy or push without his
      explicit "yes". A nod to a one-time task is not permission to deploy. When a
      fix is ready, tell him what it does and ASK for permission.
- [ ] (b) **Money/connection changes need his word specifically.** Anything touching
      bookings, payments, refunds, payouts, wallets, Instagram connect/sync, or
      creator↔brand data does NOT go live without his explicit approval for that
      change.

## Verification
- [ ] (c) **Verify-after-every-task.** Never say "ho gaya" without proof, in order
      of preference: (1) live browser check with screenshots, (2) live bundle
      string check via curl, (3) build success + code review. If verification
      FAILS: fix, re-verify, don't move on. If BLOCKED (needs login): say so
      explicitly, don't claim success.
- [ ] (d) **Connection flows tested end-to-end before deploy.** For any change
      touching creator-side or brand-side connections (Instagram connect/sync,
      profile linking, booking/chat connections): test connect → sync → data
      appears correctly; confirm syncing is perfect (real data, no errors, no
      stale/missing fields). Never deploy connection changes blind.

## Environment
- [ ] (e) **Cashfree env vars set on the gocolllancer Vercel project:**
      `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV` (keep `test`/
      sandbox — do NOT switch to production without explicit approval). ⚠️ The
      test keys live on the **collancer-app** Vercel project, NOT gocolllancer —
      set them separately on gocolllancer (new keys or re-entered ones).
- [ ] (f) **`CRON_SECRET`: ON HOLD — do NOT set.** The scheduled money cron
      authenticates via Vercel's `x-vercel-cron: 1` header (accepted at
      `api/booking-deadlines.js:29`); the secret is only required for MANUAL
      cron invocations, which stay fail-closed without it. Setting it enables
      nothing useful today — do not instruct setting it.

## Firestore
- [ ] (g) **`firestore.rules` MANUALLY published in the Firebase console.**
      Deploys do NOT auto-publish rules. Repo rules are at 765 lines
      (2026-10-16: payout-UPI destination validation, `referredBy`
      first-write-wins, private-contact create/update tightening); the last
      console publish was ~22:20 IST (659 lines). Until published, creator
      "Add UPI" fails permission-denied in production.
- [ ] (h) **Indexes deployed:** run `firebase deploy --only firestore:indexes`
      against the project (25 composites incl. `bookings(status,
      refundRequested)` for the refund pickup). Vercel never applies this file.
- [ ] (i) Live-console rules compared against repo rules (known unconfirmed
      step — repo rules and live rules can drift; payout-UPI enforcement
      depends on it).

## API function budget
- [ ] (j) **`api/` file count ≤ 12** (Vercel Hobby hard limit, enforced at deploy
      time — the whole build fails if exceeded). Current: **11/12**
      (`book-with-wallet`, `booking-action`, `booking-create`,
      `booking-deadlines`, `cashfree-order`, `cashfree-verify`,
      `cashfree-webhook`, `instagram-callback`, `instagram-refresh`,
      `instagram-start`, `llm`, `booking-action`). Any new endpoint must merge
      into an existing file or replace a removed one — never add a 13th file.

## Push hygiene
- [ ] (k) **Sync remote `main` before pushing.** Fetch remote, compare against
      local HEAD, merge and preserve newer remote work. Only push from a clean,
      known state. (No git credentials exist in the shell — do this from a machine
      that has them, and verify remote == expected commit.)
- [ ] (l) **Verify GitHub remote `main` == local tree before any push/deploy.**
      `git fetch origin` then `git diff origin/main..HEAD` must show ONLY the
      intended changes. Another session may have pushed newer work in parallel —
      never wipe or force-push over it; merge and preserve, ask if unsure.

## Design boundary
- [ ] (m) Design untouched. Missing items added exactly following the current app
      design (standing rule). Exceptions: CTA button heights enforced 44px via
      `btn()` helper only; chips/tags/close buttons stay as designed.
- [ ] (n) Connection popups render ABOVE the bottom nav, 3D black-button style, white
      text, per the app design.

## Manual steps for Jainik (never done by deploys)
- [ ] (o) Cashfree VCIP video-KYC (original physical PAN or DigiLocker e-PAN on
      camera — no alternative path; AM Arpit G).
- [ ] (p) Real merchant UPI VPA — `collancer@upi` is still a placeholder; blocks
      manual UPI deposits going live.
- [ ] (q) Firebase `measurementId` (console → `connect/firebase-config.js`) —
      required for Analytics + founder dashboard data.
- [ ] (r) Written CA opinion on TDS: 194J-vs-194O is a 100x fork; nothing is
      deducted until this is settled.

## Quick sanity before any deploy
- [ ] `node --check` passes on all touched JS files (and both src-creator +
      src-brand blocks in `index.html` for any i18n/dictionary edit).
- [ ] No secrets in git (API keys only via Vercel env vars, never committed).
- [ ] CHANGELOG.md updated with the new commit's entry.
- [ ] Standing manual blockers still tracked: `noreply@collancer.in` email
      fallback + collancer.in brand-domain decision (Jainik's — return_url
      default already moved to gocolllancer.vercel.app in code, 2026-10-14).
