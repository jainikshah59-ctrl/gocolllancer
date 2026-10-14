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
- [ ] (f) **Connection flows tested end-to-end before deploy.** For any change
      touching creator-side or brand-side connections (Instagram connect/sync,
      profile linking, booking/chat connections): test connect → sync → data
      appears correctly; confirm syncing is perfect (real data, no errors, no
      stale/missing fields). Never deploy connection changes blind.

## Environment
- [ ] (d) **`CRON_SECRET` set in Vercel env.** `api/booking-deadlines` is
      fail-closed: unset secret = 401 on every cron invocation = no auto-refunds,
      no auto-approvals. ⚠️ NOTE (verified Cycle 6): setting it is not enough yet —
      the code must also accept Vercel's `x-vercel-cron: 1` header, or the
      scheduled cron 401s regardless.
- [ ] (d2) **`CRON_SECRET` status: ON HOLD.** Do not set/enable the cron until
      Jainik explicitly approves. The booking-deadlines cron is currently a
      standing hold item.
- [ ] (h) **Cashfree env vars set on the gocolllancer Vercel project:**
      `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV` (keep `test`/
      sandbox — do NOT switch to production without explicit approval). ⚠️ The
      test keys live on the **collancer-app** Vercel project, NOT gocolllancer —
      set them separately on gocolllancer (new keys or re-entered ones).

## Firestore
- [ ] (e) **`firestore.rules` MANUALLY published in the Firebase console.**
      Deploys do NOT auto-publish rules. Code in `firestore.rules` means nothing
      until pasted + Published in console. Same for `firestore.indexes.json`.
- [ ] (e2) **Indexes deployed:** run `firebase deploy --only firestore:indexes`
      against the project before any deploy that needs new composite indexes
      (check `firestore.indexes.json` for changes since the last deploy).
- [ ] Live-console rules compared against repo rules (known unconfirmed step —
      repo rules and live rules can drift; wallet-debit permission depends on this).
- [ ] Live-console rules compared against repo rules (known unconfirmed step —
      repo rules and live rules can drift; wallet-debit permission depends on this).

## Push hygiene
- [ ] (g) **Sync remote `main` before pushing.** Fetch remote, compare against
      local HEAD, merge and preserve newer remote work. Only push from a clean,
      known state. (No git credentials exist in the shell — do this from a machine
      that has them, and verify remote == expected commit.)
- [ ] (g2) **Verify GitHub remote `main` == local tree before any push/deploy.**
      `git fetch origin` then `git diff origin/main..HEAD` must show ONLY the
      intended changes. Another session may have pushed newer work in parallel —
      never wipe or force-push over it; merge and preserve, ask if unsure.

## Design boundary
- [ ] Design untouched. Missing items added exactly following the current app
      design (standing rule). Exceptions: CTA button heights enforced 44px via
      `btn()` helper only; chips/tags/close buttons stay as designed.
- [ ] Connection popups render ABOVE the bottom nav, 3D black-button style, white
      text, per the app design.

## Quick sanity before any deploy
- [ ] `node --check` passes on all touched JS files.
- [ ] No secrets in git (API keys only via Vercel env vars, never committed).
- [ ] CHANGELOG.md updated with the new commit's entry.
- [ ] Standing manual blockers still tracked: Cashfree VCIP video-KYC,
      `noreply@collancer.in` email fallback + collancer.in brand-domain decision
      (Jainik's — return_url default already moved to
      gocolllancer.vercel.app in code, 2026-10-14).
