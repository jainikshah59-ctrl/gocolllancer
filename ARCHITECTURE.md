# gocolllancer — Architecture note (Item 20, Cycle 12)

Written 2026-10-14. Documentation only — no code was refactored.

## How the app is assembled

`index.html` is a **role-picker shell**, not the app itself:

1. **Landing + role picker** (top of file): marketing hero, creator/brand role
   cards, hidden iframes `#f-creator` / `#f-brand`, and the shell bootstrap JS.
2. **Creator SPA source**, embedded as raw text in
   `<script type="text/plain" id="src-creator">` — a *complete standalone
   HTML document*: its own `<head>`/CSS, SVG `<symbol>` icon defs, body
   markup, inline app JS, then Firebase compat SDKs +
   `connect/firebase-config.js` + `connect/ai/index.js` +
   `connect/creator-connect.js`.
3. **Brand SPA source**, embedded the same way in
   `<script type="text/plain" id="src-brand">` — same pattern, loading
   `connect/brand-connect.js` instead.
4. **Shell bootstrap** (`load(role)`): reads `src-<role>` textContent,
   un-escapes `<!--` / `</script`, and injects it as the iframe's `srcdoc`.
   `/c/<handle>` deep links skip the picker and open the brand app with the
   handle passed via `sessionStorage`.
5. **Backend wiring layer**: `connect/creator-connect.js`,
   `connect/brand-connect.js`, `connect/shell-connect.js`. These IIFEs
   override the embedded SPAs' globals (`A` action map, `C`, `S`,
   `window.finish`, …) to swap demo state for real Firestore/API behavior.
   Shared domain constants/pricing live in `connect/lib/constants.js` and
   `connect/lib/format.js`. Server APIs live in `api/` (Vercel functions).

## The duplication problem

Each embedded SPA is a full copy of the app's presentation layer, so
**features are built twice**:

- **Inline helpers duplicated per SPA**: `inr()`, `esc()`, `toast()`,
  `ic()`, `btn()`, `ghost()`, `rows()`, `stat()`, `empty()`, `wrow()`,
  `fmtCount()`, `agoStr()` exist in the creator SPA source, the brand SPA
  source, *and* again in the `-connect.js` wiring files.
- **SVG icon sets duplicated**: both SPAs carry full `<defs>` blocks and
  `P = {...}` icon tables with overlapping icon names.
- **Pricing math expressed 3+ ways**: `priceBreakup()` in
  `connect/lib/constants.js`, `pricingFor()` in `connect/brand-connect.js`,
  and `tot()` inline in the brand SPA — all encoding the same canonical
  rule (5% Pro discount off the creator price first, then 12% fee on the
  discounted price). A rule change must be applied in every copy.
- **Discovery card renderers duplicated**: `card(b,i)` (creator SPA) and
  `card(c)` (brand SPA) are near-identical markup maintained separately.
- **Real behavior lives in the override layer**: the embedded sources are
  demo-first; the `-connect.js` files monkey-patch them at boot. Two
  sources of truth for every screen: the inline demo implementation and
  its real-data override.

This is how pricing-label drift ("Contact for rates" vs "Custom rates"),
fee-math drift, and icon/markup drift happen — a fix applied to one copy
silently misses the others.

## Recommendation: unify to a single source of truth

*(Not implemented — requires Jainik's explicit approval; listed here so the
decision is on record.)*

1. **Extract shared presentation helpers** (`inr`, `esc`, `toast`, `ic`,
   `btn`, the icon defs/table, tab bar, glass-card primitives) into one
   shared JS module that both embedded SPAs load instead of inlining.
2. **One pricing module**: `connect/lib/constants.js` (`priceBreakup`,
   `creatorShareOf`) becomes the *only* place booking math lives; the
   inline `pricingFor`/`tot()` copies are deleted and import it.
3. **Converge the two inline app bundles** into one parameterized SPA
   (`role = creator | brand`) — one `card()` renderer, one booking sheet,
   one wallet — with role-specific views as thin branches, not full copies.
4. **Long-term: stop embedding SPAs as `text/plain` + `srcdoc`.** Build two
   proper entry points (`/creator`, `/brand`) served as real pages; the
   shell becomes a plain landing page with links. This removes the
   double-escaping hazard (`<\\/script` un-escaping) and lets each page be
   cached, indexed, and debugged independently.

**Do not refactor yet.** The standing design boundary ("do not touch the
app's design") plus the deploy-permission rule mean any unification work
needs Jainik's explicit go-ahead and a dedicated, verified workstream.
