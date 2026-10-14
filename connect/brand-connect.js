/* brand-connect.js — real backend wiring for the gocolllancer brand app.
 *
 * Design is untouched: this layer overrides the app's global action map (A),
 * data arrays (C, S.posts, S.bookings) and intercepts form submits, feeding
 * real Firestore data through the app's own renderers.
 *
 * Requires (loaded before): firebase compat SDKs + connect/firebase-config.js.
 * Optional (async): connect/ai/index.js as module -> window.CleoAI.
 */
(function () {
'use strict';

/* ---------------- boot ---------------- */
var tries = 0;
function boot() {
  if (!(window.FB && window.S && window.A && window.go && window.render)) {
    if (++tries < 300) return setTimeout(boot, 100);
    return;
  }
  try { init(); } catch (e) { /* never break the UI */ }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* ---------------- utils ---------------- */
function $(s, r) { return (r || document).querySelector(s); }
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function inr(n) { return '\u20B9' + Number(n || 0).toLocaleString('en-IN'); }
function fmtCount(n) {
  n = Number(n || 0);
  if (n >= 10000000) return (n / 10000000).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (n >= 100000) return (n / 100000).toFixed(1).replace(/\.0$/, '') + 'L';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function agoStr(ts) {
  try {
    var t = ts && ts.toDate ? ts.toDate().getTime() : new Date(ts).getTime();
    var m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
  } catch (e) { return ''; }
}
function toast(msg) {
  try {
    if (window.toast) { window.toast(msg); return; }
  } catch (e) {}
  var t = $('#bcon-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'bcon-toast';
    /* 3D black button design, white text, above bottom bar — matches app design. */
    t.style.cssText = 'position:fixed;left:50%;bottom:calc(110px + env(safe-area-inset-bottom,0px));transform:translateX(-50%) translateY(16px);z-index:99999;padding:14px 22px;border-radius:28px;color:#fff;font-weight:800;font-size:15px;text-align:center;background:linear-gradient(180deg,#3a3d44 0,#16181c 46%,#000 100%);border:1px solid #000;box-shadow:0 0 0 1px rgba(255,255,255,.6),0 0 0 2px rgba(0,0,0,.9),0 2px 0 2px #98a1ab,0 12px 18px -8px rgba(0,0,0,.55),inset 0 1.5px 0 rgba(255,255,255,.45),inset 0 -2px 4px rgba(255,255,255,.08);opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;max-width:86vw;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t._tm);
  t._tm = setTimeout(function () {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(16px)';
  }, 3000);
}
/* ---------------- pull to refresh ---------------- */
function initPullToRefresh() {
  var startY = 0, pulling = false, ptrEl = null;
  function ensurePtr() {
    if (ptrEl) return ptrEl;
    ptrEl = document.createElement('div');
    ptrEl.id = 'bcon-ptr';
    ptrEl.style.cssText = 'position:fixed;top:0;left:0;right:0;display:flex;align-items:center;justify-content:center;height:0;overflow:hidden;z-index:99998;transition:height .2s;pointer-events:none;';
    ptrEl.innerHTML = '<div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(180deg,#3a3d44 0,#16181c 46%,#000 100%);border:1px solid #000;box-shadow:0 0 0 1px rgba(255,255,255,.6),0 0 0 2px rgba(0,0,0,.9),inset 0 1.5px 0 rgba(255,255,255,.45);display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg></div>';
    document.body.appendChild(ptrEl);
    return ptrEl;
  }
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    var el = document.scrollingElement || document.documentElement;
    if (el.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!pulling) return;
    var dy = e.touches[0].clientY - startY;
    var el = document.scrollingElement || document.documentElement;
    if (dy > 0 && el.scrollTop <= 0) {
      var p = ensurePtr();
      p.style.height = Math.min(70, dy * 0.5) + 'px';
      p.dataset.armed = dy > 110 ? '1' : '';
    } else if (dy <= 0) {
      pulling = false;
      if (ptrEl) ptrEl.style.height = '0px';
    }
  }, { passive: true });
  document.addEventListener('touchend', function () {
    if (!pulling) return;
    pulling = false;
    var el = ptrEl;
    if (el && el.dataset.armed === '1') {
      el.dataset.armed = '';
      el.style.height = '56px';
      toast('Refreshing…');
      try {
        if (typeof loadBusiness === 'function') loadBusiness();
        if (typeof loadCreators === 'function') loadCreators();
        if (typeof loadBookings === 'function') loadBookings();
        if (typeof loadMarketplace === 'function') loadMarketplace();
      } catch (e) {}
      setTimeout(function () { el.style.height = '0px'; }, 900);
    } else if (el) {
      el.style.height = '0px';
    }
  }, { passive: true });
}
function friendlyAuthError(err) {
  var c = (err && err.code) || '';
  if (/user-not-found|wrong-password|invalid-credential/.test(c)) return 'Wrong email or password.';
  if (/email-already-in-use/.test(c)) return 'This email is already registered. Please log in.';
  if (/invalid-email/.test(c)) return 'Enter a valid email address.';
  if (/weak-password/.test(c)) return 'Password must be at least 6 characters.';
  if (/too-many-requests/.test(c)) return 'Too many attempts. Try again later.';
  return 'Authentication failed. Please try again.';
}

/* ---------------- state ---------------- */
var FB, DB, uid = null, bizDoc = null, unsubs = [];
var origFinish = null, origPpay = null, origLo = null;

function track(u) { if (u) unsubs.push(u); }
function teardown() {
  unsubs.forEach(function (u) { try { u(); } catch (e) {} });
  unsubs = [];
  uid = null; bizDoc = null;
}

/* ---------------- init ---------------- */
function init() {
  FB = window.FB; DB = FB.db;
  origFinish = window.finish; origPpay = A.ppay; origLo = A.lo;
  wireAuth();
  wireActions();
  initPullToRefresh();
  maybeDeepLinkProfile();
  FB.onAuth(function (u) {
    if (!u) { teardown(); return; } // auth gate stays visible
    uid = u.uid;
    afterLogin(u);
  });
  // returning Firebase session: run the app's own post-auth hook so the gate hides
  var n = 0;
  (function waitGate() {
    var fu = FB.user();
    if (fu && window.collancerAuthDone && !window._bconGated) {
      window._bconGated = true;
      var nm = (bizDoc && bizDoc.bizName) || S.name || '';
      window.collancerAuthDone({ email: fu.email || '', biz: nm });
    } else if (!fu && ++n < 100) setTimeout(waitGate, 100);
  })();
}

/* ---------------- auth ---------------- */
function wireAuth() {
  // intercept native form submits (capture) — the demo wire() never fires
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || (f.id !== 'p-login' && f.id !== 'p-reg')) return;
    e.stopPropagation(); e.preventDefault();
    doBrandAuth(f.id === 'p-reg');
  }, true);
  // Google / phone stub buttons -> honest behavior
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var g = t.closest('[data-toast]');
    if (g && /google/i.test(g.getAttribute('data-toast') || '')) {
      e.stopPropagation(); e.preventDefault(); doBrandGoogle();
    }
  }, true);
}
function setAuthMsg(form, msg, bad) {
  var m = form.querySelector('.a-msg');
  if (m) { m.textContent = msg || ''; m.classList.toggle('on', !!msg); }
}
function doBrandAuth(isReg) {
  var form = $('#' + (isReg ? 'p-reg' : 'p-login'));
  var g = function (i) { var el = document.getElementById(i); return el ? el.value.trim() : ''; };
  var email = g(isReg ? 're' : 'le'), pw = g(isReg ? 'rp' : 'lp');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setAuthMsg(form, 'Enter a valid email address.', true); return; }
  if (pw.length < 6) { setAuthMsg(form, 'Password must be at least 6 characters.', true); return; }
  if (isReg && g('rn').length < 2) { setAuthMsg(form, 'Enter your business name.', true); return; }
  var btn = form.querySelector('.black'), span = btn && btn.querySelector('span');
  if (btn) btn.disabled = true;
  if (span) span.textContent = 'Please wait\u2026';
  var bizName = isReg ? g('rn') : '';
  (isReg ? FB.registerEmail(email, pw) : FB.loginEmail(email, pw))
    .then(function (cred) {
      return ensureBusinessDoc(cred.user, email, bizName, isReg ? { whatsapp: g('rw'), industry: g('ri'), address: g('ra') } : null);
    })
    .then(function () {
      if (btn) btn.disabled = false;
      if (window.collancerAuthDone) window.collancerAuthDone({ email: email, biz: bizName });
    })
    .catch(function (err) {
      if (btn) btn.disabled = false;
      if (span) span.textContent = isReg ? 'Create account' : 'Log in';
      setAuthMsg(form, friendlyAuthError(err), true);
    });
}
function doBrandGoogle() {
  FB.loginGoogle()
    .then(function (res) {
      var u = (res && res.user) || FB.user();
      if (!u) throw new Error('no-user');
      /* Sensible default: Google display name -> email prefix -> fallback.
       * Rules require bizName (2-120 chars); passing '' left the doc at the
       * mercy of the fallback and silently failed for short email prefixes. */
      var em = u.email || '';
      var bizName = ((u.displayName || '').trim() || em.split('@')[0] || 'My Business').slice(0, 120);
      return ensureBusinessDoc(u, em, bizName, null).then(function () {
        if (window.collancerAuthDone) window.collancerAuthDone({ email: em, biz: bizName });
      });
    })
    .catch(function (err) { toast(friendlyAuthError(err)); });
}
/* businesses is admin-gated in the current rules (creator-first rollout);
 * attempt the doc write/read but never fail auth on it. */
function ensureBusinessDoc(u, email, bizName, extra) {
  var ref = DB.collection('businesses').doc(u.uid);
  return ref.get().then(function (snap) {
    if (snap.exists) return;
    var doc = {
      bizName: bizName || email.split('@')[0] || 'Business',
      email: email, phone: '', pfp: '', industry: '', address: '',
      walletBalance: 0, isPro: false, proActive: false,
      /* Pro subscription (Cycle 12, Item 21): paid Business Pro. Schema:
       *   proSubscription = { status: 'active'|'cancelled'|'expired',
       *     startedAt: <Date/Timestamp>, expiresAt: <Date/Timestamp>,
       *     amount: 999 }
       * Legacy free Pro (isPro && proActive) is grandfathered; new Pro
       * activations go through the "Go Pro" button (Cashfree order with
       * purpose 'pro_subscription'). Null until the first paid activation. */
      proSubscription: null,
      createdAt: FB.serverStamp(),
    };
    if (extra) {
      if (extra.whatsapp) doc.phone = extra.whatsapp;
      if (extra.industry) doc.industry = extra.industry;
      if (extra.address) doc.address = extra.address;
    }
    return ref.set(doc).catch(function () { /* admin-gated: locked for now */ });
  }).catch(function () { /* admin-gated read: locked for now */ });
}

function afterLogin(u) {
  loadBusiness();
  loadCreators();
  loadBookings();
  loadMarketplace();
  loadSaved();
  loadWalletLedger();
  loadNotifications();
}

/* ---------------- business + wallet ---------------- */
function loadBusiness() {
  track(DB.collection('businesses').doc(uid).onSnapshot(function (snap) {
    bizDoc = snap.exists ? snap.data() : null;
    if (bizDoc) {
      S.name = bizDoc.bizName || S.name;
      S.email = bizDoc.email || S.email;
      S.wallet = Number(bizDoc.walletBalance || 0);
      S.bizVerified = !!bizDoc.verified;
      S.bizGstin = bizDoc.gstin || '';
      if (S.route === 'wallet') { try { render(); } catch (e) {} }
      if (S.route === 'dashboard') { try { render(); } catch (e) {} }
    }
  }, function () { bizDoc = null; }));
}
/* Business Pro gating (Cycle 12, Item 21 — paid Pro, ₹999/month).
 * isProActive() is the single source of truth for the 5% Pro discount:
 *  - paid subscription: proSubscription.status === 'active' && expiresAt > now
 *  - grandfathered: legacy free Pro (isPro && proActive) keeps working.
 * New Pro activations go through the "Go Pro — ₹999/month" button (A.gopro),
 * which creates a Cashfree order with purpose 'pro_subscription'; the
 * Cashfree webhook stamps proSubscription server-side after a verified
 * payment (firestore.rules deny client writes of Pro state). */
var PRO_SUBSCRIPTION_PRICE = 999; // ₹/month (Jainik decision 2026-10-14)
function isProActive() {
  if (!bizDoc) return false;
  var sub = bizDoc.proSubscription;
  if (sub && sub.status === 'active') {
    var exp = sub.expiresAt;
    var expMs = exp && exp.toMillis ? exp.toMillis() : Date.parse(exp);
    if (expMs && expMs > Date.now()) return true;
  }
  // Grandfathered: legacy free Pro keeps its discount.
  return !!(bizDoc.isPro && bizDoc.proActive);
}
function bizIsPro() { return isProActive(); }
try { window.collancerIsPro = bizIsPro; window.collancerIsProActive = isProActive; } catch (e) {}
function pricingFor(creatorPrice) {
  // Canonical rule: 5% Pro discount off the CREATOR PRICE first,
  // then 12% platform fee on the DISCOUNTED price.
  var discount = isProActive() ? Math.round(creatorPrice * 0.05) : 0;
  var discounted = creatorPrice - discount;
  var fee = Math.round(discounted * 0.12);
  return { creatorPrice: creatorPrice, discountedPrice: discounted, fee: fee, discount: discount, total: discounted + fee };
}

/* ---------------- discover: real creators ---------------- */
function mapCreator(doc) {
  var d = doc.data(), ig = d.instagram || {};
  var followers = ig.followersCount != null ? ig.followersCount : (d.followers || 0);
  var ins = ig.insights || {};
  /* Honest pricing: only the creator's real prices are ever shown. When the
   * creator has not set prices, pk stays empty and the UI shows
   * "Custom rates" instead of invented numbers. */
  var pk = [];
  if (d.prices && typeof d.prices === 'object') {
    Object.keys(d.prices).forEach(function (k) {
      pk.push([k, '', Number(d.prices[k]) || 0]);
    });
  }
  var low = pk.length ? Math.min.apply(null, pk.map(function (p) { return p[2]; })) : 0;
  var high = pk.length ? Math.max.apply(null, pk.map(function (p) { return p[2]; })) : 0;
  return {
    id: doc.id,
    name: d.name || 'Creator',
    h: d.handle || '',
    fol: fmtCount(followers),
    rate: (Number(d.rating || 0)).toFixed(1),
    views: fmtCount(ins.avgViews || d.avgViews || 0),
    reach: fmtCount(ins.reach || 0),
    likes: fmtCount(ins.avgLikes || 0),
    conv: pk.length ? (inr(low) + ' \u2013 ' + inr(high)) : '—',
    pk: pk,
    _hasPrices: pk.length > 0,
    _minPrice: low,
    _followers: followers,
    _engagement: Number(ig.engagementRate || d.engagementRate || 0),
    _niche: d.niche || '', _city: d.city || '',
    _platform: d.platform || 'Instagram',
    _pfp: ig.profilePicUrl || d.pfp || '',
    portfolio: Array.isArray(d.portfolioMediaIds) ? d.portfolioMediaIds.filter(function (u) { return typeof u === 'string' && u; }).slice(0, 6) : [],
  };
}
function loadCreators() {
  var col = DB.collection('creators');
  var apply = function (snap) {
    var arr = [];
    snap.forEach(function (doc) {
      var d = doc.data();
      if (d.banned) return;
      arr.push(mapCreator(doc));
    });
    arr.sort(function (a, b) { return (b._followers || 0) - (a._followers || 0); });
    try {
      C.length = 0;
      arr.forEach(function (c) { C.push(c); });
      // keep a deep-linked creator visible even if outside the top-60
      try {
        var dc = window._deepCreator;
        if (dc && !C.some(function (x) { return String(x.id) === String(dc.id); })) C.push(dc);
      } catch (e2) {}
      if (S.route === 'discover' || S.route === 'profile') render();
    } catch (e) {}
  };
  // public read; orderBy may need index -> fallback without
  track(col.orderBy('followers', 'desc').limit(60).onSnapshot(apply, function () {
    track(col.limit(60).onSnapshot(apply, function () {}));
  }));
  // live search filter is already in the app (#q); category filter via data-a="cat"
}

/* ---------------- bookings ---------------- */
function loadBookings() {
  var col = DB.collection('bookings');
  var apply = function (snap) {
    var arr = [];
    snap.forEach(function (doc) {
      var d = doc.data();
      arr.push({
        camp: d.campaignName || '', creator: d.creatorName || '',
        creatorId: d.creatorId || '',
        pkg: d.packageKey || '', type: d.type || 'paid',
        deadline: d.deadline || '', total: Number(d.paidAmount || d.amount || 0),
        price: Number(d.creatorPrice || 0), fee: Number(d.platformFee || 0),
        oid: doc.id, _status: d.status || 'Pending',
        revs: d.revisions || '', revCount: Number(d.revisionCount || 0),
        isCustomOffer: !!d.isCustomOffer, offerStatus: d.offerStatus || '',
        offerPrice: Number(d.offerPrice || 0), reviewed: false,
      });
    });
    try {
      S.bookings = arr;
      markReviewed();
      if (S.route === 'dashboard') render();
    } catch (e) {}
  };
  track(col.where('bizId', '==', uid).onSnapshot(apply, function () {}));
}
function sha256hex(str) {
  if (window.crypto && crypto.subtle) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('').slice(0, 32);
    });
  }
  // fallback: djb2-based 32-hex (idempotency only)
  var h1 = 5381, h2 = 52711;
  for (var i = 0; i < str.length; i++) {
    h1 = ((h1 << 5) + h1 + str.charCodeAt(i)) >>> 0;
    h2 = ((h2 << 5) + h2 + str.charCodeAt(i)) >>> 0;
  }
  var s = '';
  for (var j = 0; j < 8; j++) { s += ('0000000' + ((h1 * (j + 7) + h2 * (j + 3)) >>> 0).toString(16)).slice(-4); }
  return Promise.resolve(s.slice(0, 32));
}
function buildBooking(paymentMethod, paymentReference, demoPayment, cashfreeEnv) {
  var b = S.bk, c = null;
  try { c = cr(S.cid); } catch (e) {}
  if (!b || !c) return null;
  var price = 0;
  try { price = (c.pk[b.pk] || [])[2] || 0; } catch (e) {}
  var pr = pricingFor(b.type === 'paid' ? price : 0);
  var barter = b.type === 'barter';
  var f = b.f || {};
  return {
    creatorId: String(c.id), creatorName: c.name, creatorHandle: c.h || '',
    creatorPlatform: c._platform || '', creatorNiche: c._niche || '', creatorCity: c._city || '',
    creatorPfp: c._pfp || null,
    bizId: uid, bizName: S.name || (bizDoc && bizDoc.bizName) || 'Business',
    bizPfp: (bizDoc && bizDoc.pfp) || null, bizIsPro: bizIsPro(),
    type: b.type, packageKey: b.pk == null ? null : ('pkg_' + b.pk),
    campaignName: f.campaign || '', productName: f.product || '',
    brief: f.brief || '', deliverables: f.deliverables || '',
    platform: f.platform || c._platform || '', deadline: f.deadline || '',
    targetAudience: f.audience || '', category: f.category || '',
    hashtags: f.hashtags || '', websiteLink: f.website || '', cta: f.cta || '',
    usageRights: f.usage || '', revisions: f.revisions || '',
    exclusivity: f.exclusivity || '', requirements: f.other || '',
    contactNumber: f.contact || '', contact: f.contact || '',
    shipping: f.shipping || '', mediaFiles: [],
    amount: pr.total, creatorPrice: pr.creatorPrice,
    escrowAmount: barter ? 0 : pr.total, platformFee: pr.fee, proDiscount: pr.discount,
    paidAmount: barter ? 0 : pr.total,
    paymentMethod: paymentMethod, paymentStatus: barter ? 'not_required' : 'escrow_held',
    escrowStatus: barter ? 'not_required' : 'held',
    paymentReference: paymentReference || null, demoPayment: !!demoPayment,
    cashfreeEnv: cashfreeEnv || null, paymentApproved: false, refundProcessed: false,
    status: 'Pending', seenByCreator: false, seenByBiz: true,
    acceptDeadline: new Date(Date.now() + 72 * 3600 * 1000),
    reviewDeadline: null, autoCancelled: false, autoApproved: false,
    paidAt: barter ? null : FB.serverStamp(), createdAt: FB.serverStamp(),
  };
}
function fingerprintParts() {
  var b = S.bk, c = null;
  try { c = cr(S.cid); } catch (e) {}
  return {
    bizId: uid, creatorId: c ? String(c.id) : '',
    packageKey: b.pk == null ? 'none' : ('pkg_' + b.pk),
    campaignName: (b.f && b.f.campaign) || '', deadline: (b.f && b.f.deadline) || '',
  };
}
function notifyCreator(creatorId, bookingId, title, body) {
  // REMOVED (Cycle 13+14+15, Item 7): firestore.rules creatorNotifs allow
  // create only when creatorId == the caller's own uid, so a brand writing
  // to the creator's notification feed was 100% permission-denied (and
  // swallowed by the .catch anyway). Notifications are server-owned now —
  // booking-create / booking-action / book-with-wallet write them via the
  // Admin SDK. Kept as a no-op so the existing call sites don't break.
  return Promise.resolve(null);
}
function uiBookingDone(realId, methodLabel) {
  try { origFinish(methodLabel); } catch (e) {}
  try {
    if (S.bookings && S.bookings[0]) S.bookings[0].oid = realId;
    S.bk.oid = realId;
    sheet();
  } catch (e) {}
}

/* ---------------- action overrides ---------------- */
function wireActions() {
  /* String-safe id handling: real creator ids are Firestore strings, but the
   * app coerces data-v with + (numeric demo ids). Preserve both. */
  A.open = function (t) {
    var v = t.dataset.v;
    S.cid = (v != null && v !== '' && isNaN(+v)) ? v : +v;
    S.ptab = 'Overview';
    go('profile');
  };
  A.book = function (t) {
    var v = t.dataset.v;
    openBook((v != null && v !== '' && isNaN(+v)) ? v : +v);
  };

  /* Booking payment: wallet -> Firestore transaction; cashfree -> real order */
  A.pay = function () {
    var T = tot();
    if (S.bk.method === 'wallet') return payWithWallet(T);
    return payWithCashfreeBooking(T);
  };

  /* Barter + demo paths keep the original finish, then persist for real */
  var _fin = origFinish;
  window.finish = function (m) {
    if (m === 'BARTER') {
      var booking = buildBooking('barter', null, false, null);
      if (!booking) { _fin(m); return; }
      sha256hex(JSON.stringify(fingerprintParts())).then(function (fp) {
        var id = 'collab_' + fp;
        DB.collection('bookings').doc(id).set(Object.assign({}, booking, { collaborationFingerprint: fp }))
          .then(function () {
            notifyCreator(booking.creatorId, id, 'New barter request', (booking.bizName || 'A brand') + ' sent a barter collaboration request.');
            uiBookingDone(id, m);
          })
          .catch(function (e) {
            if (/DUPLICATE/i.test(e && e.message)) toast('You already have an active request like this.');
            else _fin(m);
          });
      }).catch(function () { _fin(m); });
      return;
    }
    _fin(m);
  };

  /* Cashfree sheet pay button: real order when backend configured, demo otherwise.
   * The button is disabled for the flight; realCashfreePay's in-flight guard
   * additionally blocks a second order from any other entry point. */
  A.ppay = function (t) {
    var p = S.pay;
    if (!p || !p.o) return;
    var btnEl = (t && t.tagName === 'BUTTON') ? t : (t && t.closest ? t.closest('button') : null);
    if (btnEl) btnEl.disabled = true;
    var release = function () { if (btnEl) btnEl.disabled = false; };
    var done = function (id) { release(); try { origPpay(); } catch (e) {} };
    // Wallet top-ups must reach the server with the canonical 'wallet_topup'
    // purpose (the webhook credits walletBalance only for that tag) — derive
    // it from the sheet label instead of passing the display label through.
    var label = p.o.label || 'Collancer payment';
    var purpose = /wallet[\s\-_]*top[\s\-_]*up/i.test(label) ? 'wallet_topup' : label;
    realCashfreePay(p.o.amt, label, function (id, env) {
      if (id === null) { done(); return; } // backend unconfigured -> original demo flow
      try {
        ppClose();
        p.o.after(id);
      } catch (e) { done(); }
      release();
    }, { purpose: purpose });
  };

  /* Paid-but-unsaved retry (one tap): re-call booking-create with the same
   * orderId. The server order registry consumes the existing row instead of
   * 409, so this never double-charges. */
  A.retrybk = function () {
    var st = retryState;
    retryState = null;
    if (!st || !st.orderId) { toast('No pending payment to retry.'); return; }
    var booking = buildBooking('cashfree', st.orderId, true, st.env || 'test');
    if (!booking) { showBookingRetryModal(st.orderId, st.env, st.amount); return; }
    toast('Retrying booking save\u2026');
    // 1b: the retry replays the same booking attempt, so it needs the same
    // 32-hex collaborationFingerprint the server requires.
    sha256hex(JSON.stringify(fingerprintParts())).then(function (fp) {
      booking.collaborationFingerprint = fp;
      return FB.api('booking-create', { orderId: st.orderId, booking: booking });
    })
      .then(function (r) {
        var id = (r && r.bookingId) || null;
        if (!id) { showBookingRetryModal(st.orderId, st.env, st.amount); return; }
        hideBookingRetryModal();
        notifyCreator(booking.creatorId, id, 'New collaboration request',
          (booking.bizName || 'A brand') + ' booked ' + (booking.campaignName || 'a campaign') + '.');
        uiBookingDone(id, 'CF');
        try { S.bk.oid = id; if (S.bookings && S.bookings[0]) S.bookings[0].oid = id; sheet(); } catch (e) {}
        loadBookings();
      })
      .catch(function () { showBookingRetryModal(st.orderId, st.env, st.amount); });
  };
  A.retrybkx = function () { hideBookingRetryModal(); };

  /* Business Pro upgrade (Cycle 12, Item 21): paid subscription ₹999/month.
   * Creates a real Cashfree order with purpose 'pro_subscription'
   * (realCashfreePay passes the canonical purpose to /api/cashfree-order,
   * and already verifies PAID + amount server-side via /api/cashfree-verify
   * before calling back with a non-null orderId).
   * Activation happens SERVER-SIDE: the Cashfree webhook stamps
   * proSubscription on the business doc on PAYMENT_SUCCESS (firestore.rules
   * deny client writes of isPro/proActive/proSubscription). This handler
   * polls the business doc until the webhook activation lands, then
   * announces — no client write of Pro state, so it can never fail or be
   * forged. */
  A.gopro = function (t) {
    if (isProActive()) { toast('Business Pro is already active.'); return; }
    var btnEl = (t && t.tagName === 'BUTTON') ? t : (t && t.closest ? t.closest('button') : null);
    if (btnEl) btnEl.disabled = true;
    var release = function () { if (btnEl) btnEl.disabled = false; };
    toast('Opening secure payment…');
    realCashfreePay(PRO_SUBSCRIPTION_PRICE, 'pro_subscription', function (orderId, env) {
      release();
      if (!orderId) { toast('Payment not completed.'); return; } // unconfigured / cancelled / unverified
      toast('Confirming subscription…');
      // Server-side activation (cashfree-webhook): watch the business doc —
      // loadBusiness's onSnapshot refreshes bizDoc — until isProActive()
      // flips. No client write: rules deny it, so attempting it would only
      // mislead the user with a spurious "activation failed" toast.
      var t0 = Date.now();
      var iv = setInterval(function () {
        var on = false;
        try { on = isProActive(); } catch (e) {}
        if (on) {
          clearInterval(iv);
          toast('Business Pro activated — 5% off every paid booking.');
          try { if (window.render) window.render(); } catch (e) {}
        } else if (Date.now() - t0 > 60000) {
          clearInterval(iv);
          toast('Payment received — Pro is activating. It unlocks shortly; if not, contact support with order ' + orderId + '.');
        }
      }, 2000);
    }, { purpose: 'pro_subscription' });
  };

  /* Marketplace: persist requirement for real */
  var _postgo = A.postgo;
  A.postgo = function () {
    var t = ($('#pt') || {}).value || '', d = ($('#pd') || {}).value || '',
        b = Math.floor(+($('#pb') || {}).value || 0), c = ($('#pc') || {}).value || '';
    if (t.trim().length < 5 || d.trim().length < 10 || b < 500) { _postgo(); return; }
    DB.collection('requirements').add({
      bizId: uid, bizName: S.name || '', title: t.trim(), description: d.trim(),
      budget: b, category: c, platform: '', status: 'open', createdAt: FB.serverStamp(),
    }).then(function () { _postgo(); loadMarketplace(); })
      .catch(function () { toast('Could not post. Please try again.'); });
  };

  /* Logout: the app already does two-tap wipe + gate; add the real sign-out. */
  A.lo = function (t) {
    try { origLo(t); } catch (e) {}
    setTimeout(function () {
      try {
        if (S.email === '') { FB.logout().catch(function () {}); teardown(); }
      } catch (e) {}
    }, 60);
  };

  /* AI overlay send */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('#aiGo')) {
      e.stopPropagation(); e.preventDefault(); brandAiSend();
    }
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.closest && e.target.closest('#aiIn')) {
      e.stopPropagation(); e.preventDefault(); brandAiSend();
    }
  }, true);
}

function payWithWallet(T) {
  if (S.wallet < T.t) { toast('Insufficient wallet balance. Please add money.'); return; }
  var booking = buildBooking('wallet', null, false, null);
  if (!booking) { toast('Could not create booking.'); return; }
  toast('Processing wallet payment\u2026');
  sha256hex(JSON.stringify(fingerprintParts())).then(function (fp) {
    /* Server-side wallet booking: /api/book-with-wallet debits the wallet,
     * writes the booking + ledger row atomically, and notifies the creator.
     * The client must NOT write businesses/{uid}.walletBalance directly
     * (repo firestore.rules deny it -> permission-denied). Amounts are
     * recomputed server-side; the draft is whitelisted fields only. */
    return FB.api('book-with-wallet', { fingerprint: fp, booking: booking });
  }).then(function (r) {
    var bookingId = (r && r.bookingId) || '';
    var charged = Number((r && r.total) || 0);
    // Refresh the client-side balance display from the server-computed total.
    // (loadBusiness's onSnapshot will also correct it when the doc updates.)
    S.wallet = Math.max(0, S.wallet - charged);
    uiBookingDone(bookingId, 'WALLET');
    try { popup({ amt: charged || T.t, sub: 'Paid from Collancer Wallet', oid: bookingId }); } catch (e) {}
    loadBookings();
  }).catch(function (err) {
    var m = (err && err.message) || '';
    if (/duplicate_booking|DUPLICATE/i.test(m)) toast('You already have an active request like this.');
    else if (/insufficient_balance|INSUFFICIENT/i.test(m)) toast('Insufficient wallet balance. Please add money.');
    else if (/permission|denied/i.test(m)) toast('Wallet payments need brand access enabled.');
    else toast('Payment failed. Please try again.');
  });
}

function loadCashfreeSdk() {
  return new Promise(function (res, rej) {
    if (window.Cashfree) return res(window.Cashfree);
    var s = document.createElement('script');
    s.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    s.onload = function () { res(window.Cashfree); };
    s.onerror = rej;
    document.head.appendChild(s);
  });
}
/* In-flight guard: a double-tap on Pay must never create two real Cashfree
 * orders (the second order_id would be lost). Set on entry, cleared exactly
 * once via done() on every completion/error path. */
var cashfreeInFlight = false;
/* Real Cashfree order. cb(orderId|null, env) — null means backend unconfigured.
 * extra (optional): { purpose, creatorId, creatorPrice }. The server
 * normalizes `purpose` and recomputes the charge from the rate card for
 * bookings (client amounts are never trusted) — creatorId + creatorPrice are
 * required for booking orders so the server can verify and price them. */
function realCashfreePay(amount, label, cb, extra) {
  if (cashfreeInFlight) { toast('Payment is already being processed. Please wait.'); return; }
  cashfreeInFlight = true;
  var done = function (orderId, env) { cashfreeInFlight = false; cb(orderId, env); };
  var x = extra || {};
  FB.api('cashfree-order', {
    amount: amount,
    purpose: x.purpose || label || 'Collancer payment',
    label: label || '',
    creatorId: x.creatorId || null,
    creatorPrice: x.creatorPrice != null ? x.creatorPrice : null,
    customer: { customer_id: uid, customer_email: S.email || '', customer_phone: (bizDoc && bizDoc.phone) || '' },
  }).then(function (r) {
    if (!r || r.configured === false) { done(null); return; }
    if (!r.payment_session_id) { done(null); return; }
    loadCashfreeSdk().then(function (Cashfree) {
      var cf = Cashfree({ mode: r.env === 'production' ? 'production' : 'sandbox' });
      return cf.checkout({ paymentSessionId: r.payment_session_id, redirectTarget: '_modal' }).then(function () {
        // expected_amount: verify against the SERVER-COMPUTED order amount
        // (the server ignores client amounts for bookings/Pro) so a PAID
        // order for a different amount is rejected before anything is written.
        var charged = (r && r.order_amount != null) ? r.order_amount : amount;
        return FB.api('cashfree-verify', { order_id: r.order_id, expected_amount: charged }).then(function (v) {
          if (v && v.order_status === 'PAID' && v.amount_matches !== false) done(r.order_id, r.env || 'test');
          else { toast('Payment not confirmed. Please try again.'); done(null); }
        });
      });
    }).catch(function () { toast('Could not open payment gateway.'); done(null); });
  }).catch(function () { done(null); });
}

/* Paid-but-unsaved retry: if /api/booking-create fails after a successful
 * Cashfree payment, show a modal with a one-tap Retry that re-calls
 * booking-create with the SAME orderId. The server-side order registry
 * makes this idempotent: it consumes the existing order row instead of
 * returning 409, so the user is never charged twice. */
var retryState = null;
function showBookingRetryModal(orderId, env, amount) {
  retryState = { orderId: orderId, env: env, amount: amount };
  var cf = document.getElementById('cf');
  if (!cf) { toast('Payment succeeded but booking save failed. Contact support.'); return; }
  cf.className = 'ov on';
  cf.innerHTML = '<div class="dim" style="background:rgba(11,18,23,.55)"></div>' +
    '<div class="w"><div class="glass sh" style="padding:26px 22px">' +
    '<h2 style="font-size:20px;font-weight:800;margin:0 0 8px">Payment received</h2>' +
    '<p class="sub" style="margin:0 0 4px">Your payment of ' + inr(amount) + ' went through, but the booking could not be saved. Tap Retry to finish \u2014 you will <b>not</b> be charged again.</p>' +
    '<div style="padding:10px 12px;border-radius:16px;background:rgba(15,40,60,.05);font-size:12.5px;color:#55616d;margin-top:10px">Order ID <b style="color:#0b1217;margin-left:6px">' + esc(String(orderId || '')) + '</b></div>' +
    '<div style="display:flex;gap:10px;margin-top:18px">' +
    '<div style="flex:1">' + '<button type="button" class="black" data-a="retrybk" style="width:100%;height:48px;border-radius:24px">Retry</button>' + '</div>' +
    '<div style="flex:1">' + '<button type="button" class="glass" data-a="retrybkx" style="width:100%;height:48px;border-radius:24px;font-weight:800;font-size:15px;cursor:pointer">Dismiss</button>' + '</div>' +
    '</div></div></div>';
}
function hideBookingRetryModal() {
  var cf = document.getElementById('cf');
  if (cf) cf.className = 'ov';
  retryState = null;
}

function payWithCashfreeBooking(T) {
  toast('Opening secure payment\u2026');
  // The server recomputes the booking charge from the creator's rate card
  // (/api/cashfree-order ignores the client amount) — build the draft first
  // so creatorId + creatorPrice travel with the order request, and abort
  // before any money moves if the draft cannot be built.
  var draft0 = buildBooking('cashfree', null, true, 'test');
  if (!draft0) { toast('Could not start booking. Please try again.'); return; }
  var extra = { purpose: 'booking_payment', creatorId: draft0.creatorId, creatorPrice: draft0.creatorPrice };
  realCashfreePay(T.t, 'Booking \u00B7 ' + ((S.bk.f && S.bk.f.campaign) || ''), function (orderId, env) {
    if (!orderId) return; // demo fallback already handled by A.ppay path
    var booking = buildBooking('cashfree', orderId, true, env || 'test');
    if (!booking) return;
    toast('Confirming payment\u2026');
    // B-C1: booking + all money fields are written SERVER-SIDE via
    // /api/booking-create (payment verified, amount recomputed, order
    // registry prevents reuse). Never write the booking doc from the client.
    // 1b: the server requires a 32-hex collaborationFingerprint on the draft —
    // compute it exactly like the wallet/barter paths do and include it in
    // the booking draft sent to /api/booking-create.
    sha256hex(JSON.stringify(fingerprintParts())).then(function (fp) {
      booking.collaborationFingerprint = fp;
      return FB.api('booking-create', { orderId: orderId, booking: booking });
    })
      .then(function (r) {
        var id = (r && r.bookingId) || null;
        if (!id) { showBookingRetryModal(orderId, env, T.t); return; }
        notifyCreator(booking.creatorId, id, 'New collaboration request',
          (booking.bizName || 'A brand') + ' booked ' + (booking.campaignName || 'a campaign') + '.');
        uiBookingDone(id, 'CF');
        try { S.bk.oid = id; if (S.bookings && S.bookings[0]) S.bookings[0].oid = id; sheet(); } catch (e) {}
        loadBookings();
      })
      .catch(function (e) {
        var m = (e && e.message) || '';
        if (/already[ _-]?used|reused|order_reused/i.test(m)) toast('This payment was already used for a booking.');
        else if (/bad_fingerprint|fingerprint/i.test(m)) toast('Booking fingerprint error. Please try again.');
        else if (/amount_mismatch|amount/i.test(m)) toast('Payment amount did not match the booking total. Contact support.');
        else showBookingRetryModal(orderId, env, T.t);
      });
  }, extra);
}

/* Brand review of delivered work. Exposed as a global for the booking sheet:
 *   window.collancerReviewBooking(bookingId, 'approve')
 *   window.collancerReviewBooking(bookingId, 'revision', note)
 *   window.collancerReviewBooking(bookingId, 'dispute', reason, evidenceUrls)
 * evidenceUrls: optional array of evidence link strings (Item 19) — stored
 * as disputeEvidence on the booking (rules allow the key on dispute).
 * Verifies the booking belongs to this brand (bizId === uid) before writing.
 * All update shapes match firestore.rules exactly (rule-safe field lists).
 * Approve is a money-moving action: it shows an explicit confirm and an
 * in-flight guard so a double-tap can never fire two server approves. */
var reviewInFlight = {};
function reviewBooking(bookingId, decision, note, evidence) {
  bookingId = String(bookingId || '');
  var key = bookingId + ':' + String(decision || '');
  if (reviewInFlight[key]) { toast('This action is already being processed.'); return undefined; }
  if (decision === 'approve') {
    var ok = false;
    try { ok = confirm('Approve this work? This completes the booking and the creator can then request their payout.'); } catch (e) {}
    if (!ok) return undefined;
  }
  reviewInFlight[key] = true;
  var release = function () { try { delete reviewInFlight[key]; } catch (e) {} };
  var ref = DB.collection('bookings').doc(bookingId);
  toast('Updating booking\u2026');
  return ref.get().then(function (snap) {
    if (!snap.exists) throw new Error('not_found');
    var d = snap.data() || {};
    if (String(d.bizId) !== String(uid)) throw new Error('not_your_booking');
    if (d.status !== 'PendingCompletion') throw new Error('wrong_status');
    if (decision === 'approve') {
      // Escrow auto-release (Item 15): the approve runs server-side via
      // /api/booking-action — it verifies the brand owns the booking, sets
      // status Completed, and creates the payoutRequests doc (canonical 95%
      // creator share) atomically. The client never writes Completed or
      // payout rows directly.
      return FB.api('booking-action', { action: 'approve', bookingId: String(bookingId) })
        .then(function (r) {
          if (!r || r.ok !== true) throw new Error('approve_failed');
        });
    }
    if (decision === 'revision') {
      // Revision-cap enforcement: the booking's `revisions` text (e.g.
      // "2 rounds included") sets the cap; revisionCount is tracked on every
      // revision. No parseable number -> no cap.
      var capM = /(\d+)/.exec(String(d.revisions || ''));
      var cap = capM ? parseInt(capM[1], 10) : 0;
      if (cap > 0 && Number(d.revisionCount || 0) >= cap) throw new Error('revision_limit');
      return ref.update({
        status: 'Active',
        revisionNote: String(note || '').slice(0, 1000),
        revisionCount: firebase.firestore.FieldValue.increment(1),
        revisionRequestedAt: FB.serverStamp(),
        updatedAt: FB.serverStamp(),
        seenByBiz: true,
      });
    }
    if (decision === 'dispute') {
      // Rule-safe: BUSINESS dispute allows status/disputeReason/
      // disputeEvidence/disputeOpenedAt/disputeOpenedBy/updatedAt/seenByBiz.
      // Item 19: evidence links are stored as disputeEvidence entries.
      var evDocs = (Array.isArray(evidence) ? evidence : [])
        .map(function (u) { return { url: String(u || '').slice(0, 500), at: new Date().toISOString(), by: uid }; })
        .filter(function (x) { return x.url; })
        .slice(0, 3);
      var patch = {
        status: 'Disputed',
        disputeReason: String(note || '').slice(0, 1000),
        disputeOpenedAt: FB.serverStamp(),
        disputeOpenedBy: uid,
        updatedAt: FB.serverStamp(),
        seenByBiz: true,
      };
      if (evDocs.length) patch.disputeEvidence = evDocs;
      return ref.update(patch);
    }
    throw new Error('bad_decision');
  }).then(function () {
    if (decision === 'approve') toast('Booking completed. The creator can now request their payout.');
    else if (decision === 'dispute') toast('Dispute opened. Our team will review this booking.');
    else toast('Revision requested. The creator has been notified.');
    try { loadBookings(); } catch (e) {}
  }).catch(function (e) {
    var m = (e && e.message) || '';
    if (m === 'not_your_booking') toast('This booking does not belong to your account.');
    else if (m === 'wrong_status') toast('This booking is not awaiting review.');
    else if (m === 'revision_limit') toast('This booking has no revisions left.');
    else if (m === 'bad_decision') toast('Invalid review decision.');
    else toast('Could not update booking. Please try again.');
  }).then(function () { release(); }, function () { release(); });
}
try { window.collancerReviewBooking = reviewBooking; } catch (e) {}

/* Brand cancels a booking: Pending/Active -> Cancelled.
 * Item 24 (brand-cancel refund policy): attaches the refund INTENT to the
 * booking doc (rule-safe fields only — firestore.rules BUSINESS cancel).
 *   Pending -> Cancelled : refundRequested=true, refundAmount=paidAmount (full)
 *   Active  -> Cancelled : refundRequested=true, refundAmount=paidAmount-platformFee
 * Barter/legacy bookings (no numeric paidAmount) cancel without refund fields.
 * The refund cron executes the actual wallet credit server-side and never
 * trusts these client-set fields — it uses server-truth paidAmount/platformFee.
 * For Active cancels it also queues the 10% creator kill-fee from the
 * retained fee portion (Cycle 13+14+15). */
function cancelRefundFields(d) {
  // Mirror firestore.rules exactly: the refund branch requires paidAmount to
  // be a NUMBER on the existing doc (brandCancelRefundOk). A legacy string
  // paidAmount falls through to the barter branch (cancel without refund).
  if (typeof d.paidAmount !== 'number' || !(d.paidAmount > 0) || d.barter === true) return null;
  var paid = d.paidAmount;
  var fee = (typeof d.platformFee === 'number' ? d.platformFee : 0);
  // Pending -> FULL refund; Active -> refund minus the platform fee.
  var refund = d.status === 'Pending' ? paid : paid - fee;
  if (!(isFinite(refund) && refund >= 0)) return null;
  return {
    refundRequested: true,
    refundAmount: refund,
    refundStatus: 'pending',
  };
}
function cancelBooking(bookingId, reason) {
  var ref = DB.collection('bookings').doc(String(bookingId || ''));
  toast('Cancelling booking\u2026');
  return ref.get().then(function (snap) {
    if (!snap.exists) throw new Error('not_found');
    var d = snap.data() || {};
    if (String(d.bizId) !== String(uid)) throw new Error('not_your_booking');
    if (d.status !== 'Pending' && d.status !== 'Active') throw new Error('wrong_status');
    var patch = {
      status: 'Cancelled',
      statusBeforeCancel: d.status, // Cycle 13+14+15: lets the refund cron apply the Active-cancel kill-fee
      cancelledAt: FB.serverStamp(),
      cancelledByBiz: true,
      cancelReason: String(reason || '').slice(0, 500),
      seenByBiz: true,
    };
    var rf = cancelRefundFields(d);
    if (rf) {
      patch.refundRequested = rf.refundRequested; patch.refundAmount = rf.refundAmount; patch.refundStatus = rf.refundStatus;
      // Cycle 13+14+15: the cron uses statusBeforeCancel to tell an Active
      // cancel (partial refund + creator kill-fee) from a Pending one.
      if (d.status === 'Active') patch.statusBeforeCancel = 'Active';
    }
    return ref.update(patch);
  }).then(function () {
    toast('Booking cancelled.');
    try { loadBookings(); } catch (e) {}
  }).catch(function (e) {
    var m = (e && e.message) || '';
    if (m === 'not_your_booking') toast('This booking does not belong to your account.');
    else if (m === 'wrong_status') toast('Only pending or active bookings can be cancelled.');
    else toast('Could not cancel the booking. Please try again.');
  });
}
try { window.collancerCancelBooking = cancelBooking; } catch (e) {}

/* Cancel dialog with exact refund math (Item 24 copy): reads the booking to
 * show the precise refund before the brand confirms. Falls back to a generic
 * confirm when the booking cannot be read. Native confirm/prompt follow the
 * existing dialog pattern. */
function cancelBookingDialog(bookingId) {
  var id = String(bookingId || '');
  var proceed = function () {
    var rs = '';
    try { rs = prompt('Reason for cancellation (optional)', '') || ''; } catch (e) {}
    if (window.collancerCancelBooking) window.collancerCancelBooking(id, rs);
    else toast('Cancel service is loading. Please try again.');
  };
  var ask = function (msg) {
    var ok = false;
    try { ok = confirm(msg); } catch (e) {}
    if (ok) proceed();
  };
  DB.collection('bookings').doc(id).get().then(function (snap) {
    if (!snap.exists) { toast('Booking not found.'); return; }
    var d = snap.data() || {};
    if (d.status !== 'Pending' && d.status !== 'Active') {
      toast('Only pending or active bookings can be cancelled.');
      return;
    }
    var rf = cancelRefundFields(d);
    if (rf) {
      var fee = Math.max(0, Number(d.paidAmount || 0) - rf.refundAmount);
      ask(d.status === 'Pending'
        ? 'Cancel this booking?\n\nYou will be refunded ' + inr(rf.refundAmount) + ' (full amount).'
        : 'Cancel this booking?\n\nYou will be refunded ' + inr(rf.refundAmount) + ' (' + inr(fee) + ' platform fee retained).');
    } else {
      ask('Cancel this booking?\n\nNo payment to refund (barter or unpaid booking).');
    }
  }).catch(function () { ask('Cancel this booking?'); });
}
try { window.collancerCancelBookingDialog = cancelBookingDialog; } catch (e) {}

/* ---------------- marketplace ---------------- */
function loadMarketplace() {
  var col = DB.collection('requirements');
  var apply = function (snap) {
    var arr = [];
    snap.forEach(function (doc) {
      var d = doc.data();
      var nm = d.bizName || 'Brand';
      arr.push({
        id: doc.id, brand: nm, verified: !!d.bizVerified,
        ini: nm.split(' ').map(function (x) { return x.charAt(0); }).join('').slice(0, 2).toUpperCase(),
        ago: agoStr(d.createdAt), status: (d.status || 'open').toUpperCase(),
        title: d.title || '', desc: d.description || '',
        budget: d.budget || 0, cat: d.category || '',
        mine: d.bizId === uid,
      });
    });
    try {
      S.posts = arr;
      if (S.route === 'shop') render();
    } catch (e) {}
  };
  track(col.where('bizId', '==', uid).onSnapshot(apply, function () {
    track(col.limit(40).onSnapshot(function (snap) {
      var arr = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        if (d.bizId !== uid) return;
        var nm = d.bizName || 'Brand';
        arr.push({
          id: doc.id, brand: nm, verified: !!d.bizVerified,
          ini: nm.split(' ').map(function (x) { return x.charAt(0); }).join('').slice(0, 2).toUpperCase(),
          ago: agoStr(d.createdAt), status: (d.status || 'open').toUpperCase(),
          title: d.title || '', desc: d.description || '',
          budget: d.budget || 0, cat: d.category || '', mine: true,
        });
      });
      try { S.posts = arr; if (S.route === 'shop') render(); } catch (e) {}
    }, function () {}));
  }));
}

/* ---------------- wallet ledger ---------------- */
function loadWalletLedger() {
  track(DB.collection('walletTransactions').where('bizId', '==', uid).orderBy('createdAt', 'desc').limit(30)
    .onSnapshot(function (snap) {
      var tx = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        tx.push({ t: d.type === 'booking_deduction' ? 'Booking payment' : (d.type || 'Transaction'), amt: Math.abs(Number(d.amount || 0)), s: Number(d.amount || 0) < 0 ? '-' : '+', date: agoStr(d.createdAt) });
      });
      try {
        if (tx.length) {
          // merge with in-memory demo entries, real first
          var seen = {};
          S.tx = tx.concat(S.tx.filter(function (x) { var k = x.t + x.amt; if (seen[k]) return false; seen[k] = 1; return true; }));
          if (S.route === 'wallet') render();
        }
      } catch (e) {}
    }, function () {}));
  track(DB.collection('walletDeposits').where('bizId', '==', uid).orderBy('createdAt', 'desc').limit(20)
    .onSnapshot(function (snap) {
      var dep = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        dep.push({ amt: Number(d.amount || 0), id: doc.id, date: agoStr(d.createdAt) + ' \u00B7 ' + (d.status || 'pending') });
      });
      try {
        if (dep.length) {
          S.dep = dep;
          if (S.route === 'wallet') render();
        }
      } catch (e) {}
    }, function () {}));
}

/* ---------------- deep link (/c/<handle>) ---------------- */
/* Shared creator profile links: the outer page stores the handle in
 * sessionStorage and opens the brand app. Route straight to the public
 * creator profile view instead of the auth gate. creators read is public. */
function maybeDeepLinkProfile() {
  var handle = null;
  try { handle = sessionStorage.getItem('collancer_deep_handle'); } catch (e) {}
  if (!handle) return;
  try { sessionStorage.removeItem('collancer_deep_handle'); } catch (e) {}
  DB.collection('creators').where('handleLower', '==', String(handle).toLowerCase()).limit(1).get()
    .then(function (snap) {
      var doc = null;
      snap.forEach(function (d) { if (!doc) doc = d; });
      if (!doc) { toast('Creator not found.'); return; }
      var c = mapCreator(doc);
      // profile() view reads demo-shaped fields plat/niche/city
      c.plat = c._platform || 'Instagram';
      c.niche = c._niche || '';
      c.city = c._city || '';
      try { window._deepCreator = c; } catch (e) {}
      try {
        var i = -1;
        for (var k = 0; k < C.length; k++) { if (String(C[k].id) === String(c.id)) { i = k; break; } }
        if (i >= 0) C[i] = c; else C.push(c);
      } catch (e) {}
      try {
        var g = document.getElementById('authGate');
        if (g) { g.style.display = 'none'; document.body.style.overflow = ''; }
      } catch (e) {}
      try { S.cid = c.id; S.ptab = 'Overview'; go('profile'); } catch (e) {}
    })
    .catch(function () { toast('Could not open this creator profile.'); });
}

/* ---------------- notifications ---------------- */
function loadNotifications() {
  track(DB.collection('bizNotifs').where('bizId', '==', uid).orderBy('createdAt', 'desc').limit(1)
    .onSnapshot(function (snap) {
      snap.docChanges().forEach(function (ch) {
        if (ch.type === 'added') {
          var d = ch.doc.data();
          if (!d.read) toast(d.title + (d.body ? ': ' + d.body : ''));
        }
      });
    }, function () {}));
}

/* ---------------- brand AI ---------------- */
function cleoReady() {
  return new Promise(function (res) {
    var n = 0;
    (function poll() {
      if (window.CleoAI) return res(window.CleoAI);
      if (++n > 100) return res(null);
      setTimeout(poll, 100);
    })();
  });
}
function brandAiSend() {
  var IN = $('#aiIn'), MS = $('#aiMsgs');
  var t = IN ? IN.value : '';
  if (!t || !t.trim() || !MS) return;
  IN.value = '';
  var u = document.createElement('div');
  u.className = 'ai-u';
  u.textContent = t.trim();
  MS.appendChild(u); MS.scrollTop = MS.scrollHeight;
  var typing = document.createElement('div');
  typing.className = 'ai-a';
  typing.innerHTML = '<div class="dots"><i></i><i></i><i></i></div>';
  MS.appendChild(typing); MS.scrollTop = MS.scrollHeight;
  var creators = [];
  try {
    creators = C.map(function (c) {
      return { id: c.id, name: c.name, handle: c.h, followers: c._followers, niche: c._niche, city: c._city, platform: c._platform };
    });
  } catch (e) {}
  cleoReady().then(function (CleoAI) {
    if (!CleoAI) { typing.remove(); return; }
    return CleoAI.ask(t, {
      isCreator: false,
      context: { user: { name: S.name, email: S.email }, creators: creators, convo: null, live: true },
    }).then(function (r) {
      typing.remove();
      var a = document.createElement('div');
      a.className = 'ai-a';
      a.textContent = (r && r.answer) || 'Sorry, I could not answer that.';
      MS.appendChild(a); MS.scrollTop = MS.scrollHeight;
    });
  }).catch(function () { typing.remove(); });
}

  /* ---------------- Cycle 12 Worker D: discovery shortlist, chat, custom offers, reviews, invoice, dispute evidence ---------------- */

/* Item 10 — shortlist: savedCreators/{bizUid}/creators/{creatorId} */
function loadSaved() {
  if (!uid) return;
  try { S.saved = S.saved || {}; } catch (e) {}
  track(DB.collection('savedCreators').doc(uid).collection('creators').onSnapshot(function (snap) {
    var m = {};
    snap.forEach(function (doc) { m[doc.id] = true; });
    try {
      S.saved = m;
      if (S.route === 'discover') { var l = document.getElementById('list'); if (l && window.listHTML) l.innerHTML = window.listHTML(); }
    } catch (e) {}
  }, function () {}));
}
function toggleSave(creatorId) {
  var id = String(creatorId || '');
  if (!id) return;
  if (!uid) { toast('Log in to save creators to your shortlist.'); return; }
  var ref = DB.collection('savedCreators').doc(uid).collection('creators').doc(id);
  var was = !!((function () { try { return S.saved; } catch (e) { return {}; } })() || {})[id];
  toast(was ? 'Removed from shortlist.' : 'Saved to your shortlist.');
  (was ? ref.delete() : ref.set({ creatorId: id, savedAt: FB.serverStamp() }))
    .catch(function () { toast('Could not update shortlist. Please try again.'); });
}
try { window.collancerToggleSave = toggleSave; } catch (e) {}

/* Item 13 — custom offer: brand proposes a price; the booking is created
 * unpaid (money-safe client write, same shape as the barter path). Payment
 * is collected later via collancerPayOffer once the creator accepts. */
function sendCustomOffer(draft) {
  var b = null;
  try { b = S.bk; } catch (e) {}
  if (!b || !uid) { toast('Offer service is loading. Please try again.'); return; }
  var price = Math.floor(Number(draft.offerPrice) || 0);
  if (!(price >= 100)) { toast('Enter an offer of at least \u20B9100.'); return; }
  toast('Sending your offer\u2026');
  var fpInput = JSON.stringify({ bizId: uid, creatorId: draft.creatorId, packageKey: 'offer', campaignName: draft.campaignName || '', deadline: draft.deadline || '', offerPrice: price });
  sha256hex(fpInput).then(function (fp) {
    var id = 'collab_' + fp;
    var bizName = 'Business';
    try { bizName = (S.name || (bizDoc && bizDoc.bizName) || 'Business').slice(0, 120); } catch (e) {}
    var doc = {
      creatorId: String(draft.creatorId || ''), creatorName: String(draft.creatorName || 'Creator').slice(0, 120),
      creatorHandle: String(draft.creatorHandle || '').slice(0, 120),
      creatorPlatform: String(draft.creatorPlatform || '').slice(0, 60),
      creatorNiche: String(draft.creatorNiche || '').slice(0, 80),
      creatorCity: String(draft.creatorCity || '').slice(0, 80),
      bizId: uid, bizName: bizName,
      bizPfp: (bizDoc && bizDoc.pfp) || null,
      type: 'paid', packageKey: null,
      campaignName: String(draft.campaignName || '').slice(0, 160),
      productName: String(draft.productName || '').slice(0, 160),
      brief: String(draft.brief || '').slice(0, 4000),
      deliverables: String(draft.deliverables || '').slice(0, 2000),
      platform: String(draft.platform || '').slice(0, 60),
      deadline: String(draft.deadline || '').slice(0, 40),
      targetAudience: String(draft.targetAudience || '').slice(0, 400),
      category: String(draft.category || '').slice(0, 80),
      hashtags: String(draft.hashtags || '').slice(0, 400),
      websiteLink: String(draft.websiteLink || '').slice(0, 500),
      cta: String(draft.cta || '').slice(0, 200),
      usageRights: String(draft.usageRights || '').slice(0, 800),
      revisions: String(draft.revisions || '').slice(0, 80),
      exclusivity: String(draft.exclusivity || '').slice(0, 200),
      requirements: String(draft.requirements || '').slice(0, 2000),
      contactNumber: String(draft.contactNumber || '').slice(0, 40),
      contact: String(draft.contact || '').slice(0, 40),
      shipping: String(draft.shipping || '').slice(0, 400),
      mediaFiles: [],
      amount: 0, creatorPrice: 0, escrowAmount: 0, platformFee: 0, proDiscount: 0,
      paidAmount: 0, paymentMethod: null, paymentStatus: 'not_required',
      escrowStatus: 'not_required', paymentReference: null, demoPayment: false,
      paymentApproved: false, refundProcessed: false, refundStatus: null,
      isCustomOffer: true, offerStatus: 'pending', offerPrice: price,
      status: 'Pending', seenByCreator: false, seenByBiz: true,
      collaborationFingerprint: fp,
      acceptDeadline: new Date(Date.now() + 72 * 3600 * 1000),
      reviewDeadline: null, autoCancelled: false, autoApproved: false,
      paidAt: null, createdAt: FB.serverStamp(), updatedAt: FB.serverStamp(),
    };
    return DB.collection('bookings').doc(id).set(doc).then(function () { return id; });
  }).then(function (id) {
    notifyCreator(draft.creatorId, id, 'New custom offer',
      (S.name || 'A brand') + ' offered \u20B9' + price.toLocaleString('en-IN') + ' for ' + (draft.campaignName || 'a campaign') + '.');
    try {
      S.bk.oid = id; S.bk.sentOffer = true; S.bk.offerPrice = price;
      S.bookings.unshift({ camp: draft.campaignName || '', creator: draft.creatorName || '', creatorId: String(draft.creatorId || ''), pkg: 'Custom offer', type: 'paid', deadline: draft.deadline || '', total: 0, price: 0, fee: 0, oid: id, _status: 'Pending', revs: '', revCount: 0, isCustomOffer: true, offerStatus: 'pending', offerPrice: price, reviewed: false });
      S.bk.step = 6; sheet();
    } catch (e) {}
    toast('Offer sent.');
  }).catch(function (e) {
    var m = (e && e.message) || '';
    if (/permission|denied/i.test(m)) toast('Could not send the offer (permission).');
    else toast('Could not send the offer. Please try again.');
  });
}
try { window.collancerSendCustomOffer = sendCustomOffer; } catch (e) {}

/* Item 13 — pay for an accepted custom offer: creates a fresh paid booking
 * through the server-side wallet lane at the agreed price, then retires the
 * original offer booking (rule-safe: moneyless Pending/Active brand cancel). */
function payOffer(oid, price) {
  oid = String(oid || ''); price = Math.floor(Number(price) || 0);
  if (!oid || !(price >= 100) || !uid) { toast('Invalid offer.'); return; }
  toast('Preparing payment\u2026');
  DB.collection('bookings').doc(oid).get().then(function (snap) {
    if (!snap.exists) throw new Error('not_found');
    var d = snap.data() || {};
    if (String(d.bizId) !== String(uid)) throw new Error('not_yours');
    if (!d.isCustomOffer) throw new Error('not_an_offer');
    var bizName = 'Business';
    try { bizName = (S.name || (bizDoc && bizDoc.bizName) || 'Business').slice(0, 120); } catch (e) {}
    var draft = {
      creatorId: String(d.creatorId || ''), creatorName: String(d.creatorName || 'Creator').slice(0, 120),
      creatorHandle: String(d.creatorHandle || '').slice(0, 120),
      creatorPlatform: String(d.creatorPlatform || '').slice(0, 60),
      creatorNiche: String(d.creatorNiche || '').slice(0, 80),
      creatorCity: String(d.creatorCity || '').slice(0, 80),
      bizId: uid, bizName: bizName,
      bizPfp: (bizDoc && bizDoc.pfp) || null, bizIsPro: bizIsPro(),
      type: 'paid', packageKey: null,
      campaignName: String(d.campaignName || '').slice(0, 160),
      productName: String(d.productName || '').slice(0, 160),
      brief: String(d.brief || '').slice(0, 4000),
      deliverables: String(d.deliverables || '').slice(0, 2000),
      platform: String(d.platform || '').slice(0, 60),
      deadline: String(d.deadline || '').slice(0, 40),
      targetAudience: String(d.targetAudience || '').slice(0, 400),
      category: String(d.category || '').slice(0, 80),
      hashtags: String(d.hashtags || '').slice(0, 400),
      websiteLink: String(d.websiteLink || '').slice(0, 500),
      cta: String(d.cta || '').slice(0, 200),
      usageRights: String(d.usageRights || '').slice(0, 800),
      revisions: String(d.revisions || '').slice(0, 80),
      exclusivity: String(d.exclusivity || '').slice(0, 200),
      requirements: String(d.requirements || '').slice(0, 2000),
      contactNumber: String(d.contactNumber || '').slice(0, 40),
      contact: String(d.contact || '').slice(0, 40),
      shipping: String(d.shipping || '').slice(0, 400),
      mediaFiles: [],
      creatorPrice: price,
    };
    return sha256hex(JSON.stringify({ offerPay: oid, bizId: uid, price: price })).then(function (fp) {
      return FB.api('book-with-wallet', { fingerprint: fp, booking: draft }).then(function (r) { return { r: r, fp: fp }; });
    });
  }).then(function (out) {
    var bookingId = (out.r && out.r.bookingId) || '';
    var charged = Number((out.r && out.r.total) || 0);
    try { S.wallet = Math.max(0, S.wallet - charged); } catch (e) {}
    return DB.collection('bookings').doc(oid).update({
      status: 'Cancelled', cancelledAt: FB.serverStamp(), cancelledByBiz: true,
      cancelReason: 'Superseded by paid booking ' + bookingId, seenByBiz: true,
    }).catch(function () {}).then(function () { return { bookingId: bookingId, charged: charged }; });
  }).then(function (out) {
    toast('Payment complete. Booking is active.');
    try { if (window.popup) window.popup({ amt: out.charged, sub: 'Paid from Collancer Wallet', oid: out.bookingId }); } catch (e) {}
    loadBookings();
  }).catch(function (e) {
    var m = (e && e.message) || '';
    if (/insufficient_balance|INSUFFICIENT/i.test(m)) toast('Insufficient wallet balance. Please add money.');
    else if (m === 'not_yours') toast('This booking does not belong to your account.');
    else toast('Payment failed. Please try again.');
  });
}
try { window.collancerPayOffer = payOffer; } catch (e) {}

/* Item 11 — in-booking chat (brand side). booking_messages rules allow the
 * brand/creator of the booking to read + create messages. */
var chatUnsub = null;
function chatSub(oid) {
  oid = String(oid || '');
  chatClose();
  if (!oid || !uid) return;
  var paint = function (snap) {
    var arr = [];
    snap.forEach(function (doc) { var d = doc.data(); arr.push({ senderType: d.senderType || '', text: d.text || '' }); });
    try { if (S.chat && String(S.chat.oid) === oid) { S.chat.msgs = arr; renderChat(); } } catch (e) {}
  };
  var q = DB.collection('booking_messages').where('bookingId', '==', oid).orderBy('createdAt', 'asc').limit(100);
  chatUnsub = q.onSnapshot(paint, function () {
    // orderBy may need a composite index -> fall back to unordered
    chatUnsub = DB.collection('booking_messages').where('bookingId', '==', oid).limit(100).onSnapshot(function (snap) {
      var arr = [];
      snap.forEach(function (doc) { var d = doc.data(); arr.push({ senderType: d.senderType || '', text: d.text || '', at: d.createdAt }); });
      arr.sort(function (a, b) {
        var ta = a.at && a.at.toMillis ? a.at.toMillis() : 0, tb = b.at && b.at.toMillis ? b.at.toMillis() : 0;
        return ta - tb;
      });
      try { if (S.chat && String(S.chat.oid) === oid) { S.chat.msgs = arr; renderChat(); } } catch (e) {}
    }, function () {});
  });
  try { track(chatUnsub); } catch (e) {}
}
function chatSend(oid, text) {
  oid = String(oid || ''); text = String(text || '').slice(0, 2000).trim();
  if (!oid || !text || !uid) return;
  DB.collection('booking_messages').add({
    bookingId: oid, text: text, senderType: 'brand', senderId: uid,
    createdAt: FB.serverStamp(),
  }).then(function () {
    // rule-safe chat metadata stamp on the booking
    DB.collection('bookings').doc(oid).update({ lastMessageAt: FB.serverStamp(), lastMessageFrom: 'brand' }).catch(function () {});
  }).catch(function () { toast('Message could not be sent.'); });
}
function chatClose() { if (chatUnsub) { try { chatUnsub(); } catch (e) {} chatUnsub = null; } }
try { window.collancerChatSub = chatSub; window.collancerChatSend = chatSend; window.collancerChatClose = chatClose; } catch (e) {}

/* Item 16 — review submit. The rules gate creation to brands holding a
 * COMPLETED booking carrying this bookingId for this creator. */
function submitReview(bookingId, creatorId, stars, text) {
  bookingId = String(bookingId || ''); creatorId = String(creatorId || '');
  stars = Math.max(1, Math.min(5, Math.floor(Number(stars) || 0)));
  text = String(text || '').slice(0, 1000);
  if (!bookingId || !creatorId || !uid) { toast('Review service is loading. Please try again.'); return; }
  toast('Submitting review\u2026');
  var bizName = 'Business';
  try { bizName = (S.name || (bizDoc && bizDoc.bizName) || 'Business').slice(0, 120); } catch (e) {}
  DB.collection('reviews').add({
    bookingId: bookingId, creatorId: creatorId, bizId: uid, bizName: bizName,
    stars: stars, text: text, createdAt: FB.serverStamp(),
  }).then(function () {
    toast('Review submitted. Thank you!');
    try {
      (S.bookings || []).forEach(function (k) { if (String(k.oid) === bookingId) k.reviewed = true; });
      if (S.route === 'dashboard') render();
    } catch (e) {}
  }).catch(function () { toast('Could not submit the review. Only completed bookings can be reviewed.'); });
}
try { window.collancerSubmitReview = submitReview; } catch (e) {}

function loadReviews(creatorId) {
  creatorId = String(creatorId || '');
  if (!creatorId || !uid) return;
  var done = function (snap) {
    var arr = [];
    snap.forEach(function (doc) {
      var d = doc.data();
      arr.push({ stars: Math.max(1, Math.min(5, Number(d.stars) || 5)), text: d.text || '', biz: d.bizName || 'Verified booking' });
    });
    try { S.reviews[creatorId] = arr; if (S.route === 'profile') render(); } catch (e) {}
  };
  DB.collection('reviews').where('creatorId', '==', creatorId).orderBy('createdAt', 'desc').limit(10).get()
    .then(done)
    .catch(function () {
      DB.collection('reviews').where('creatorId', '==', creatorId).limit(10).get().then(done).catch(function () {});
    });
}
try { window.collancerLoadReviews = loadReviews; } catch (e) {}

/* Hide the Rate button on bookings this brand already reviewed. */
function markReviewed() {
  if (!uid) return;
  DB.collection('reviews').where('bizId', '==', uid).get().then(function (snap) {
    var ids = {};
    snap.forEach(function (doc) { ids[String(doc.data().bookingId || '')] = true; });
    var changed = false;
    try {
      (S.bookings || []).forEach(function (k) { if (ids[String(k.oid)] && !k.reviewed) { k.reviewed = true; changed = true; } });
      if (changed && S.route === 'dashboard') render();
    } catch (e) {}
  }).catch(function () {});
}

/* Item 19 — fraud signal: count this brand's own prior disputes (rule-safe:
 * the brand can only read its own bookings). Shown in the dispute form. */
function disputeFraud() {
  var el = document.getElementById('dfraud');
  if (!uid) { if (el) el.textContent = ''; return; }
  DB.collection('bookings').where('bizId', '==', uid).where('status', '==', 'Disputed').get()
    .then(function (snap) {
      var n = snap.size;
      if (el) el.textContent = n > 0
        ? 'Fraud check: this account has opened ' + n + ' dispute' + (n === 1 ? '' : 's') + ' before. Our team reviews repeat disputes closely.'
        : 'Fraud check: no prior disputes on this account.';
    })
    .catch(function () { if (el) el.textContent = ''; });
}
try { window.collancerDisputeFraud = disputeFraud; } catch (e) {}

})();
