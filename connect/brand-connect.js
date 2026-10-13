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
      return ensureBusinessDoc(u, u.email || '', '', null).then(function () {
        if (window.collancerAuthDone) window.collancerAuthDone({ email: u.email || '', biz: '' });
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
      if (S.route === 'wallet') { try { render(); } catch (e) {} }
    }
  }, function () { bizDoc = null; }));
}
function bizIsPro() { return !!(bizDoc && bizDoc.isPro && bizDoc.proActive); }
function pricingFor(creatorPrice) {
  var fee = Math.round(creatorPrice * 0.12);
  var discount = bizIsPro() ? Math.round(creatorPrice * 0.05) : 0;
  return { creatorPrice: creatorPrice, fee: fee, discount: discount, total: creatorPrice + fee - discount };
}

/* ---------------- discover: real creators ---------------- */
function mapCreator(doc) {
  var d = doc.data(), ig = d.instagram || {};
  var followers = ig.followersCount != null ? ig.followersCount : (d.followers || 0);
  var ins = ig.insights || {};
  var pk = [];
  if (d.prices && typeof d.prices === 'object') {
    Object.keys(d.prices).forEach(function (k) {
      pk.push([k, '', Number(d.prices[k]) || 0]);
    });
  }
  if (!pk.length) {
    var base = Math.max(500, Math.round(followers * 0.15));
    pk = [
      ['Instagram Story', '24-hr story with swipe-up/link', base],
      ['Instagram Reel', '30-60s reel with caption + hashtags', Math.round(base * 2.2)],
      ['Instagram Post', 'In-feed static/carousel post', Math.round(base * 1.4)],
    ];
  }
  var low = Math.min.apply(null, pk.map(function (p) { return p[2]; }));
  var high = Math.max.apply(null, pk.map(function (p) { return p[2]; }));
  return {
    id: doc.id,
    name: d.name || 'Creator',
    h: d.handle || '',
    fol: fmtCount(followers),
    rate: (Number(d.rating || 0)).toFixed(1),
    views: fmtCount(ins.avgViews || d.avgViews || 0),
    reach: fmtCount(ins.reach || 0),
    likes: fmtCount(ins.avgLikes || 0),
    conv: inr(low) + ' \u2013 ' + inr(high),
    pk: pk,
    _followers: followers,
    _niche: d.niche || '', _city: d.city || '',
    _platform: d.platform || 'Instagram',
    _pfp: ig.profilePicUrl || d.pfp || '',
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
        pkg: d.packageKey || '', type: d.type || 'paid',
        deadline: d.deadline || '', total: Number(d.paidAmount || d.amount || 0),
        oid: doc.id, _status: d.status || 'Pending',
      });
    });
    try {
      S.bookings = arr;
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
  return DB.collection('creatorNotifs').add({
    creatorId: creatorId, type: 'booking_received', title: title, body: body,
    bookingId: bookingId, read: false, createdAt: FB.serverStamp(),
  }).catch(function () {});
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

  /* Cashfree sheet pay button: real order when backend configured, demo otherwise */
  A.ppay = function () {
    var p = S.pay;
    if (!p || !p.o) return;
    var done = function (id) { try { origPpay(); } catch (e) {} };
    realCashfreePay(p.o.amt, p.o.label || 'Collancer payment', function (id, env) {
      if (id === null) { done(); return; } // backend unconfigured -> original demo flow
      try {
        ppClose();
        p.o.after(id);
      } catch (e) { done(); }
    });
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
    var bookingId = 'collab_' + fp;
    var bizRef = DB.collection('businesses').doc(uid);
    var bookRef = DB.collection('bookings').doc(bookingId);
    var ledgerRef = DB.collection('walletTransactions').doc('booking_' + fp);
    return DB.runTransaction(function (tx) {
      return tx.get(bookRef).then(function (ex) {
        if (ex.exists && ex.data().status !== 'Cancelled') throw new Error('DUPLICATE_BOOKING');
        return tx.get(bizRef).then(function (bs) {
          var bal = Number((bs.data() || {}).walletBalance || 0);
          if (bal < T.t) throw new Error('INSUFFICIENT_BALANCE');
          tx.update(bizRef, { walletBalance: firebase.firestore.FieldValue.increment(-T.t) });
          tx.set(bookRef, Object.assign({}, booking, { collaborationFingerprint: fp }));
          tx.set(ledgerRef, {
            id: 'booking_' + fp, bizId: uid, type: 'booking_deduction',
            amount: -T.t, bookingId: bookingId, creatorId: booking.creatorId,
            creatorName: booking.creatorName, createdAt: FB.serverStamp(),
          });
          return { bookingId: bookingId };
        });
      });
    });
  }).then(function (out) {
    S.wallet = Math.max(0, S.wallet - T.t);
    notifyCreator(booking.creatorId, out.bookingId, 'New collaboration request',
      (booking.bizName || 'A brand') + ' booked ' + (booking.campaignName || 'a campaign') + '.');
    uiBookingDone(out.bookingId, 'WALLET');
    try { popup({ amt: T.t, sub: 'Paid from Collancer Wallet', oid: out.bookingId }); } catch (e) {}
    loadBookings();
  }).catch(function (err) {
    var m = (err && err.message) || '';
    if (m === 'DUPLICATE_BOOKING') toast('You already have an active request like this.');
    else if (m === 'INSUFFICIENT_BALANCE') toast('Insufficient wallet balance. Please add money.');
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
/* Real Cashfree order. cb(orderId|null, env) — null means backend unconfigured. */
function realCashfreePay(amount, label, cb) {
  FB.api('cashfree-order', {
    amount: amount, purpose: label || 'Collancer payment',
    customer: { customer_id: uid, customer_email: S.email || '', customer_phone: (bizDoc && bizDoc.phone) || '' },
  }).then(function (r) {
    if (!r || r.configured === false) { cb(null); return; }
    if (!r.payment_session_id) { cb(null); return; }
    loadCashfreeSdk().then(function (Cashfree) {
      var cf = Cashfree({ mode: r.env === 'production' ? 'production' : 'sandbox' });
      return cf.checkout({ paymentSessionId: r.payment_session_id, redirectTarget: '_modal' }).then(function () {
        return FB.api('cashfree-verify', { order_id: r.order_id }).then(function (v) {
          if (v && v.order_status === 'PAID') cb(r.order_id, r.env || 'test');
          else { toast('Payment not confirmed. Please try again.'); cb(null); }
        });
      });
    }).catch(function () { toast('Could not open payment gateway.'); cb(null); });
  }).catch(function () { cb(null); });
}

function payWithCashfreeBooking(T) {
  toast('Opening secure payment\u2026');
  realCashfreePay(T.t, 'Booking \u00B7 ' + ((S.bk.f && S.bk.f.campaign) || ''), function (orderId, env) {
    if (!orderId) return; // demo fallback already handled by A.ppay path
    var booking = buildBooking('cashfree', orderId, true, env || 'test');
    if (!booking) return;
    sha256hex(JSON.stringify(fingerprintParts())).then(function (fp) {
      var id = 'collab_' + fp;
      DB.collection('bookings').doc(id).set(Object.assign({}, booking, { collaborationFingerprint: fp }), { merge: true })
        .then(function () {
          notifyCreator(booking.creatorId, id, 'New collaboration request',
            (booking.bizName || 'A brand') + ' booked ' + (booking.campaignName || 'a campaign') + '.');
          uiBookingDone(id, 'CF');
          try { S.bk.oid = id; if (S.bookings[0]) S.bookings[0].oid = id; sheet(); } catch (e) {}
          loadBookings();
        })
        .catch(function () { toast('Payment succeeded but booking save failed. Contact support.'); });
    });
  });
}

/* ---------------- marketplace ---------------- */
function loadMarketplace() {
  var col = DB.collection('requirements');
  var apply = function (snap) {
    var arr = [];
    snap.forEach(function (doc) {
      var d = doc.data();
      var nm = d.bizName || 'Brand';
      arr.push({
        id: doc.id, brand: nm,
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
          id: doc.id, brand: nm,
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

})();
