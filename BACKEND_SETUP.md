# Collancer backend setup

This repository targets the existing Firebase project `collancer-8fd62`. The redesigned UI is served by Vercel; Firestore rules are **not** published by a Vercel deployment.

## Vercel environment variables

Already configured on the `gocolllancer` Vercel project:
- `APP_URL=https://gocolllancer.vercel.app`
- `INSTAGRAM_REDIRECT_URI=https://gocolllancer.vercel.app/api/instagram-callback`
- `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` copied from the existing Collancer project, scoped to Production and Preview
- `CASHFREE_ENV=test` (sandbox; not live payments)
- `INSTAGRAM_APP_ID` copied from the existing Collancer project

Still required:
- `FIREBASE_SERVICE_ACCOUNT_JSON`: valid service-account JSON for Firebase project `collancer-8fd62`. Store it as a sensitive Vercel environment variable. Do not commit it to Git.
- `INSTAGRAM_APP_SECRET`: the Meta app secret. Store it as a sensitive Vercel environment variable. Do not commit it to Git.

After adding or changing Vercel environment variables, redeploy the project so the new deployment receives them.

## Meta Developer settings

Add this exact OAuth redirect URI to the Instagram/Meta app's allowed OAuth redirect URIs:

`https://gocolllancer.vercel.app/api/instagram-callback`

Instagram OAuth will not work until `INSTAGRAM_APP_SECRET` is configured and Meta accepts the redirect URI.

## Publish Firestore rules

Review `firestore.rules`, then from a trusted machine with Firebase CLI access run:

```sh
firebase login
firebase use collancer-8fd62
firebase deploy --only firestore:rules
```

Alternatively, open Firebase Console → project `collancer-8fd62` → Firestore Database → Rules, review the rules from this repository, and publish them. Publishing rules affects the shared Firebase project and should be done only after review.

The business-profile rules allow an authenticated brand to read and manage only its own non-financial profile fields. Wallet balances and Pro entitlements remain admin-controlled.

## Payment environment

Cashfree is intentionally in sandbox mode to match the existing app. Before accepting real money, configure production Cashfree credentials in Vercel, set `CASHFREE_ENV=production`, and verify a full payment + server-side verification flow in production.

## Smoke-test checklist

- Creator email signup/login; creator profile creation and restoration.
- Brand email signup/login; own business profile creation and read.
- Verify a brand cannot read another brand's profile or write wallet/Pro fields.
- Create and update a requirement, submit an offer, and verify booking status transitions for both participants.
- Ask Collancer AI a known knowledge-base question and repeat with the provider pool unavailable.
- Verify Cashfree sandbox order creation and that only a `PAID` status is treated as paid.
- Verify Instagram OAuth only after adding the server secrets and Meta callback allow-list.
