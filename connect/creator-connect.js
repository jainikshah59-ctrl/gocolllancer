/* creator-connect.js — real backend wiring for the gocolllancer creator app.
 *
 * Design is untouched: this layer only intercepts UI events (capture phase) and
 * feeds real Firestore data through the app's own exposed bridges
 * (window.Collancer, window.CollancerBookings) and DOM.
 *
 * Requires (loaded before): firebase compat SDKs + connect/firebase-config.js.
 * Optional (async): connect/ai/index.js as module -> window.CleoAI.
 */
(function () {
'use strict';

/* ---------------- boot ---------------- */
var tries = 0;
function boot() {
  if (!(window.FB && window.Collancer && window.CollancerBookings)) {
    if (++tries < 300) return setTimeout(boot, 100);
    return;
  }
  try { init(); } catch (e) { /* never break the UI */ }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* ---------------- utils ---------------- */
function $(s, r) { return (r || document).querySelector(s); }
function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
/* inr() is defined top-level in the creator template document (Item 1, Cycle 34) — srcdoc iframes do not share the shell's scope. */
function fmtCount(n) {
  n = Number(n || 0);
  if (n >= 10000000) return (n / 10000000).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (n >= 100000) return (n / 100000).toFixed(1).replace(/\.0$/, '') + 'L';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function fmtDate(v) {
  try {
    if (!v) return '';
    var d = v.toDate ? v.toDate() : new Date(v);
    return d.toISOString().slice(0, 10);
  } catch (e) { return ''; }
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
  if (typeof toastDedupe === 'function' && toastDedupe(msg)) return;
  var t = $('#ccon-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'ccon-toast';
    t.setAttribute('role', 'status');
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
function friendlyAuthError(err) {
  var c = (err && err.code) || '';
  if (/user-not-found|wrong-password|invalid-credential/.test(c)) return 'Wrong email or password.';
  if (/email-already-in-use/.test(c)) return 'This email is already registered. Switch to Log in.';
  if (/invalid-email/.test(c)) return 'Enter a valid email address.';
  if (/weak-password/.test(c)) return 'Password must be at least 6 characters.';
  if (/too-many-requests/.test(c)) return 'Too many attempts. Try again later.';
  if (/network/.test(c)) return 'Network error. Check your connection.';
  return 'Authentication failed. Please try again.';
}

/* ---------------- state ---------------- */
var FB, DB, uid = null, creatorDoc = null, creatorBookings = [], unsubs = [];
var requirementsCache = [], selectedReq = null, myOffers = [];

function trackUnsub(u) { if (u) unsubs.push(u); }
function teardown() {
  unsubs.forEach(function (u) { try { u(); } catch (e) {} });
  unsubs = [];
  uid = null; creatorDoc = null; creatorBookings = [];
}

/* ---------------- init ---------------- */
function init() {
  FB = window.FB; DB = FB.db;
  wireEvents();
  initPullToRefresh();
  initMoneyLangToggle();
  FB.onAuth(function (u) {
    if (!u) { teardown(); if (!window.COLLANCER_LOGIN_DISABLED_TEMPORARILY) { try { Collancer.go('login'); } catch (e) {} } return; }
    uid = u.uid;
    try { Collancer.go('home'); } catch (e) {}
    afterLogin(u);
  });
}

function afterLogin(u) {
  /* Instagram OAuth return: show success/failure toast from sessionStorage. */
  var igJustConnected = false;
  try {
    var igRes = sessionStorage.getItem('collancer_ig_result');
    if (igRes) {
      sessionStorage.removeItem('collancer_ig_result');
      if (igRes === 'connected') {
        toast('Instagram connected successfully.');
        igJustConnected = true;
      } else if (igRes.indexOf('error=') === 0) {
        var em = decodeURIComponent(igRes.slice(6)).replace(/[-_]/g, ' ');
        toast('Instagram connect failed: ' + em + '.');
      } else {
        toast('Instagram connect finished: ' + igRes.replace(/[-_]/g, ' ') + '.');
      }
    }
  } catch (e) {}
  loadCreatorDoc();
  /* After Instagram connect, force a server refresh to bypass any stale cache,
   * then re-paint. This ensures the freshly synced data appears immediately. */
  if (igJustConnected) {
    setTimeout(function () {
      try {
        DB.collection('creators').doc(uid).get({ source: 'server' }).then(function (snap) {
          if (snap.exists) {
            creatorDoc = snap.data(); creatorDoc.id = uid;
            paintProfile();
          }
        }).catch(function () {});
      } catch (e) {}
    }, 1500);
  }
  loadBookings();
  loadMarket();
  loadPortfolio();
  loadCreatorNotifications();
  loadQuestionInbox(); /* Item 26 (Cycle 21): pre-booking questions inbox */
  try { window.CollancerToast = toast; } catch (e) {}
}

/* ---------------- notifications ---------------- */
/* Mirror of the brand side's bizNotifs listener (brand-connect.js
 * loadNotifications): toast unread creatorNotifs as they arrive.
 * The bell icons in the creator app were decorative until now. */
function loadCreatorNotifications() {
  trackUnsub(DB.collection('creatorNotifs').where('creatorId', '==', uid).orderBy('createdAt', 'desc').limit(1)
    .onSnapshot(function (snap) {
      snap.docChanges().forEach(function (ch) {
        if (ch.type === 'added') {
          var d = ch.doc.data();
          if (!d.read) toast(d.title + (d.body ? ': ' + d.body : ''));
        }
      });
    }, function () {}));
}

/* ---------------- bell & menu (Item 9, Cycle 18) ---------------- */
/* Bottom sheet helper — 3D black-button design language, no new design. */
function cconSheet(title, sub, bodyHtml) {
  var old = $('#ccon-sheet');
  if (old) old.remove();
  var ov = document.createElement('div');
  ov.id = 'ccon-sheet';
  ov.style.cssText = 'position:fixed;inset:0;z-index:99998;display:flex;align-items:flex-end;justify-content:center;';
  ov.innerHTML =
    '<div data-ccon-close style="position:absolute;inset:0;background:rgba(11,18,23,.45)"></div>'
    + '<div style="position:relative;width:100%;max-width:390px;max-height:82vh;overflow-y:auto;background:#fff;border-radius:28px 28px 0 0;padding:14px 20px calc(28px + env(safe-area-inset-bottom,0px));box-shadow:0 -12px 40px rgba(0,0,0,.18)">'
    + '<div style="width:36px;height:4.5px;border-radius:2.5px;background:rgba(15,40,60,.18);margin:0 auto 12px"></div>'
    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="flex:1">'
    + '<div style="font-size:21px;font-weight:800;letter-spacing:-.3px">' + esc(title) + '</div>'
    + (sub ? '<div style="font-size:13px;color:#55616d;margin-top:2px">' + esc(sub) + '</div>' : '')
    + '</div><button type="button" data-ccon-close aria-label="Close" style="width:38px;height:38px;flex:none;border-radius:50%;border:1px solid rgba(15,40,60,.12);background:rgba(255,255,255,.7);font-size:18px;font-weight:800;cursor:pointer;color:#0b1217">✕</button></div>'
    + '<div id="ccon-sheet-body" style="margin-top:12px">' + bodyHtml + '</div></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', function (e) {
    if (e.target.closest('[data-ccon-close]')) { ov.remove(); }
  });
}
function cconCloseSheet() { var ov = $('#ccon-sheet'); if (ov) ov.remove(); }

/* Bell: notification history from creatorNotifs. */
function showCreatorNotifHistory() {
  cconSheet('Notifications', 'Your latest updates from Collancer.',
    '<div style="text-align:center;padding:20px 0;font-size:13.5px;color:#8a94a0">Loading…</div>');
  DB.collection('creatorNotifs').where('creatorId', '==', uid)
    .orderBy('createdAt', 'desc').limit(20).get()
    .then(function (snap) {
      var html = '';
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        html += '<div style="border:1px solid rgba(15,40,60,.1);border-radius:16px;padding:12px 16px;margin-bottom:10px;background:#fff">'
          + '<div style="font-size:14.5px;font-weight:800">' + esc(d.title || 'Notification') + '</div>'
          + (d.body ? '<div style="font-size:13.5px;color:#55616d;margin-top:4px;line-height:1.45">' + esc(d.body) + '</div>' : '')
          + '</div>';
      });
      if (!html) html = '<div style="text-align:center;padding:20px 0;font-size:13.5px;color:#8a94a0">No notifications yet.<br>Booking updates will appear here.</div>';
      /* 6f (Cycle 21): stable id instead of the fragile inline-style selector. */
      var ov = $('#ccon-sheet');
      if (ov) { var body = ov.querySelector('#ccon-sheet-body'); if (body) body.innerHTML = html; }
    })
    .catch(function () {
      var ov = $('#ccon-sheet');
      if (ov) { var body = ov.querySelector('#ccon-sheet-body'); if (body) body.innerHTML = '<div style="text-align:center;padding:20px 0;font-size:13.5px;color:#8a94a0">Could not load notifications.</div>'; }
    });
}

/* Menu: quick navigation + help + logout. */
function showCreatorMenu() {
  var btn3d = 'display:block;width:100%;height:44px;border-radius:22px;font-size:14.5px;font-weight:800;cursor:pointer;margin-bottom:10px;border:1px solid #000;color:#fff;background:linear-gradient(180deg,#3a3d44 0,#16181c 46%,#000 100%);box-shadow:0 0 0 1px rgba(255,255,255,.6),0 2px 0 1px #98a1ab;';
  cconSheet('Menu', '',
    '<button type="button" data-cm="home" style="' + btn3d + '">Home</button>'
    + '<button type="button" data-cm="earnings" style="' + btn3d + '">Earnings</button>'
    + '<button type="button" data-cm="profile" style="' + btn3d + '">Edit profile</button>'
    + '<button type="button" data-cm="help" style="' + btn3d + '">Help &amp; support</button>'
    + '<button type="button" data-cm="logout" style="' + btn3d + 'background:#dc2626;">Log out</button>');
  var ov = $('#ccon-sheet');
  if (!ov) return;
  ov.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cm]');
    if (!b) return;
    var k = b.getAttribute('data-cm');
    cconCloseSheet();
    if (k === 'logout') {
      FB.logout().then(function () { try { Collancer.go(window.COLLANCER_LOGIN_DISABLED_TEMPORARILY ? 'home' : 'login'); } catch (x) {} });
    } else if (k === 'help') {
      toast('Need help? Email support@collancer.in — we reply within 24 hours.');
    } else {
      try { Collancer.go(k); } catch (x) {}
    }
  });
}

/* ---------------- auth ---------------- */
function isRegisterMode() {
  var seg = $('#s-login #seg');
  var on = seg && seg.querySelector('div.on');
  return !!(on && /register/i.test(on.textContent));
}
function prettyName(local) {
  return local.replace(/[._]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim() || 'Creator';
}
function reserveHandle(base, n) {
  var h = (n ? base + n : base).toLowerCase();
  var ref = DB.collection('creatorHandles').doc(h);
  return ref.get().then(function (s) {
    if (!s.exists) {
      return ref.set({ creatorId: uid, createdAt: FB.serverStamp() }).then(function () { return h; });
    }
    return reserveHandle(base, (n || 0) + 1);
  });
}
function ensureCreatorDoc(u, email) {
  var ref = DB.collection('creators').doc(u.uid);
  return ref.get().then(function (snap) {
    if (snap.exists) return;
    var local = (email.split('@')[0] || 'creator').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 24) || 'creator';
    return reserveHandle(local, 0).then(function (handle) {
      // Item 14 (Cycle 16): email/phone NEVER on the public creators doc
      // (rules deny it) — they live in creators/{uid}/private/contact.
      return ref.set({
        name: prettyName(local),
        handle: handle, handleLower: handle.toLowerCase(),
        pfp: '', bio: '', niche: '', city: '', platform: 'Instagram',
        prices: {}, followers: 0, engagement: 0,
        verified: false, addedToCollancer: false, banned: false,
        rating: 0, profileComplete: false,
        createdAt: FB.serverStamp(),
      }).then(function () {
        return DB.collection('creators').doc(u.uid).collection('private').doc('contact').set({
          email: email, phone: '', updatedAt: FB.serverStamp(),
        }).then(function () {
          /* INSIGHT-1: analytics — new creator signup completed */
          try { if (typeof track === 'function') track('signup_completed', { role: 'creator' }); } catch (e) {}
        });
      });
    });
  });
}
function doEmailAuth() {
  var em = $('#s-login #em'), pw = $('#s-login #pw'), note = $('#s-login #note');
  if (!em || !pw) return;
  var email = (em.value || '').trim(), pass = pw.value || '';
  var reg = isRegisterMode();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (note) note.textContent = 'Enter a valid email address.'; return; }
  if (pass.length < 6) { if (note) note.textContent = 'Password must be at least 6 characters.'; return; }
  if (note) note.textContent = reg ? 'Creating your creator account\u2026' : 'Logging you in\u2026';
  (reg ? FB.registerEmail(email, pass) : FB.loginEmail(email, pass))
    .then(function (cred) {
      if (reg) return ensureCreatorDoc(cred.user, email).then(function () { storeReferral(); });
    })
    .then(function () { if (note) note.textContent = ''; })
    .catch(function (err) { if (note) note.textContent = friendlyAuthError(err); });
}
function doGoogle() {
  var note = $('#s-login #note');
  if (note) note.textContent = 'Opening Google sign-in\u2026';
  FB.loginGoogle()
    .then(function (res) {
      var u = res && res.user ? res.user : FB.user();
      if (!u) throw new Error('no-user');
      return ensureCreatorDoc(u, u.email || '').then(function () {
        storeReferral();
        if (note) note.textContent = '';
      });
    })
    .catch(function (err) { if (note) note.textContent = friendlyAuthError(err); });
}

/* Money-screen EN/Hindi toggle on the creator Earnings screen. The label
 * switching + localStorage persistence live in index.html (moneyLang /
 * applyMoneyLang, shared); this only places the toggle button. */
function initMoneyLangToggle() {
  try {
    var bh = document.querySelector('#s-earnings .bh');
    if (!bh || bh.querySelector('[data-langtoggle]')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag glass';
    b.setAttribute('data-langtoggle', '');
    b.style.cssText = 'position:absolute;right:18px;top:calc(18px + env(safe-area-inset-top,0px));height:32px;font-size:12.5px;font-weight:800;cursor:pointer;flex:none';
    b.setAttribute('aria-label', 'Switch money-screen language');
    b.textContent = (window.moneyLang && window.moneyLang() === 'hi') ? 'हिं · EN' : 'EN · हिं';
    /* The creator app has no global data-a dispatcher, so wire directly. */
    b.addEventListener('click', function () {
      try {
        var nl = (window.moneyLang && window.moneyLang() === 'hi') ? 'en' : 'hi';
        if (window.setMoneyLang) window.setMoneyLang(nl);
        if (window.applyMoneyLang) window.applyMoneyLang();
        /* Repaint dynamic money copy (payout history pills, FY/TDS line)
         * so it follows the new language immediately. */
        try { if (typeof paintEarnings === 'function') paintEarnings(); } catch (e2) {}
      } catch (e) {}
    });
    bh.appendChild(b);
    if (window.applyMoneyLang) window.applyMoneyLang();
  } catch (e) {}
}

/* ---------------- pull to refresh ---------------- */
function initPullToRefresh() {
  var startY = 0, pulling = false, ptrEl = null;
  function ensurePtr() {
    if (ptrEl) return ptrEl;
    ptrEl = document.createElement('div');
    ptrEl.id = 'ccon-ptr';
    ptrEl.style.cssText = 'position:fixed;top:0;left:0;right:0;display:flex;align-items:center;justify-content:center;height:0;overflow:hidden;z-index:99998;transition:height .2s;pointer-events:none;';
    ptrEl.innerHTML = '<div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(180deg,#3a3d44 0,#16181c 46%,#000 100%);border:1px solid #000;box-shadow:0 0 0 1px rgba(255,255,255,.6),0 0 0 2px rgba(0,0,0,.9),inset 0 1.5px 0 rgba(255,255,255,.45);display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg></div>';
    document.body.appendChild(ptrEl);
    return ptrEl;
  }
  function isAtTop() {
    /* Check if any scrollable ancestor is at top; default to document. */
    var el = document.scrollingElement || document.documentElement;
    if (el.scrollTop > 0) return false;
    return true;
  }
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    if (!isAtTop()) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!pulling) return;
    var dy = e.touches[0].clientY - startY;
    if (dy > 0 && isAtTop()) {
      var el = ensurePtr();
      var h = Math.min(70, dy * 0.5);
      el.style.height = h + 'px';
      if (dy > 110) el.dataset.armed = '1'; else el.dataset.armed = '';
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
      /* Refresh all data. */
      try {
        if (uid) {
          loadCreatorDoc();
          if (typeof loadBookings === 'function') loadBookings();
          if (typeof loadMarket === 'function') loadMarket();
        }
      } catch (e) {}
      setTimeout(function () { el.style.height = '0px'; }, 900);
    } else if (el) {
      el.style.height = '0px';
    }
  }, { passive: true });
}

/* ---------------- event interception (capture phase; originals never fire) ---------------- */
function wireEvents() {
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var q = function (s) { return t.closest(s); };
    /* Item 10 (Cycle 16): honest feedback for stub buttons — the login screen's
     * "Continue with Phone" carries data-toast but had no handler in this SPA,
     * so it was a silent dead button. Show the message instead of nothing. */
    var dt = t.closest('[data-toast]');
    if (dt) { e.stopPropagation(); e.preventDefault(); toast(dt.getAttribute('data-toast')); return; }
    /* Item 9 (Cycle 18): wire dead bell & menu buttons in creator header. */
    if (q('#s-home button[aria-label="Notifications"]')) { e.stopPropagation(); e.preventDefault(); showCreatorNotifHistory(); return; }
    if (q('#s-home button[aria-label="Menu"]')) { e.stopPropagation(); e.preventDefault(); showCreatorMenu(); return; }
    if (q('#s-login #sb')) { e.stopPropagation(); e.preventDefault(); doEmailAuth(); return; }
    var sbtn = q('#s-login .sbtn');
    if (sbtn && !/phone/i.test(sbtn.textContent)) { e.stopPropagation(); e.preventDefault(); doGoogle(); return; }
    if (q('#s-profile .black.red')) {
      e.stopPropagation(); e.preventDefault();
      FB.logout().then(function () { try { Collancer.go(window.COLLANCER_LOGIN_DISABLED_TEMPORARILY ? 'home' : 'login'); } catch (x) {} });
      return;
    }
    /* Item 5 (Cycle 21): DPDP deletion is now an in-app sheet owned by the
     * profile script (index.html, Item 8 Cycle 19 panel). The old native
     * confirm() interception here is REMOVED — it fired in capture phase and
     * shadowed the sheet. Clicks on [data-cdel] now bubble to the panel. */
    var igBtn = q('button.black');
    if (igBtn && /connect instagram/i.test(igBtn.textContent)) {
      e.stopPropagation(); e.preventDefault(); connectInstagram(); return;
    }
    /* Item 17: "Do it later" defers the Instagram step (nano creators). */
    if (q('#ccon-ig-defer')) {
      e.stopPropagation(); e.preventDefault(); deferInstagram(); return;
    }
    if (q('#s-earnings #rq')) { e.stopPropagation(); e.preventDefault(); requestPayout(); return; }
    if (q('#s-ai #go')) { e.stopPropagation(); e.preventDefault(); aiSend(false); return; }
    if (q('#s-ai #dn')) { e.stopPropagation(); e.preventDefault(); aiVoiceDone(); return; }
    if (q('#s-market #sendBtn')) { e.stopPropagation(); e.preventDefault(); sendProposal(); return; }
    var wd = q('#s-market .wd');
    if (wd) { e.stopPropagation(); e.preventDefault(); withdrawOffer(wd); return; }
    if (q('#s-tools #cs')) { e.stopPropagation(); e.preventDefault(); toolsChat(); return; }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !e.target || !e.target.closest) return;
    var t = e.target;
    if (t.closest('#s-login') && (t.id === 'em' || t.id === 'pw')) {
      e.stopPropagation(); e.preventDefault(); doEmailAuth();
    } else if (t.closest('#s-ai #in')) {
      e.stopPropagation(); e.preventDefault(); aiSend(false);
    } else if (t.closest('#s-tools #ci')) {
      e.stopPropagation(); e.preventDefault(); toolsChat();
    }
  }, true);
}

/* ---------------- creator profile ---------------- */
function loadCreatorDoc() {
  var ref = DB.collection('creators').doc(uid);
  trackUnsub(ref.onSnapshot(function (snap) {
    if (!snap.exists) return;
    creatorDoc = snap.data(); creatorDoc.id = uid;
    paintProfile();
    /* 6e (Cycle 21): re-run the checklist on snapshot updates so steps tick
     * when the doc changes (IG connect, portfolio pins, prices), not only at
     * init and after profileShared. */
    try { paintChecklist(); } catch (e) {}
  }));
}
function paintProfile() {
  var root = $('#s-profile');
  if (!root || !creatorDoc) return;
  var d = creatorDoc, ig = d.instagram || {};
  var name = d.name || 'Creator';
  var followers = ig.followersCount != null ? ig.followersCount : (d.followers || 0);
  var card = root.querySelector('.glass.card');
  if (!card) return;
  try {
    var avatar = card.querySelector('.t3.teal');
    if (avatar) {
      var pfp = ig.profilePicUrl || ig.profilePic || d.pfp;
      if (pfp) {
        avatar.style.backgroundImage = 'url("' + pfp.replace(/"/g, '') + '")';
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
        avatar.textContent = '';
      } else {
        var initials = name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
        avatar.textContent = initials || 'C';
      }
    }
    var nameEl = card.querySelector('div[style*="font-size:18.5px"]');
    if (nameEl) nameEl.textContent = name;
    var folEl = card.querySelector('.sub');
    if (folEl) folEl.textContent = fmtCount(followers) + ' followers on Instagram';
    var bar = card.querySelector('div[style*="height:11px"] > div');
    if (bar) bar.style.width = Math.min(100, Math.max(5, profileCompleteness())) + '%';
    // Instagram card state
    var igBtn = null;
    $all('button.black', root).forEach(function (b) {
      if (/connect instagram|connected/i.test(b.textContent)) igBtn = b;
    });
    if (igBtn) {
      if (ig.username) {
        igBtn.disabled = true;
        igBtn.innerHTML = 'Connected as @' + esc(ig.username);
        igBtn.style.opacity = '.75';
      } else {
        igBtn.disabled = false;
        igBtn.style.opacity = '';
      }
    }
    /* Item 17: hide "Do it later" once Instagram is connected or deferred. */
    try {
      var igDeferBtn = document.getElementById('ccon-ig-defer');
      if (igDeferBtn) igDeferBtn.style.display = (ig.username || igDeferred()) ? 'none' : '';
    } catch (e2) {}
    /* No package prices set -> nudge the creator once per session, and show
     * a persistent banner on the Rate card ("Your packages") section until
     * prices are set. Custom offers and barter still work without prices. */
    var hasPrices = !!(d.prices && Object.keys(d.prices).length) || !!(d.packages && d.packages.length);
    if (!hasPrices) {
      if (!window._cconPriceNudge) {
        window._cconPriceNudge = true;
        setTimeout(function () { toast('Set your package prices to get booked faster.'); }, 1200);
      }
      try {
        var h2s = root.querySelectorAll('h2'), pkgCard = null;
        h2s.forEach(function (h) { if (h.textContent.trim() === 'Your packages') pkgCard = h.closest('.glass.card'); });
        if (pkgCard && !pkgCard.querySelector('#ccon-price-banner')) {
          var banner = document.createElement('div');
          banner.id = 'ccon-price-banner';
          banner.setAttribute('role', 'note');
          banner.style.cssText = 'margin:10px 0 0;padding:12px 14px;border-radius:16px;background:#fff7e6;border:1px solid #f2c979;font-size:13.5px;font-weight:700;color:#8a5a00;line-height:1.45';
          banner.textContent = 'Set your package prices to get booked faster. Brands can still send you custom offers meanwhile \u2014 keep your profile ready.';
          var sub = pkgCard.querySelector('.sub');
          pkgCard.insertBefore(banner, sub ? sub.nextSibling : pkgCard.firstChild);
        }
      } catch (e2) {}
    } else {
      try {
        var old = root.querySelector('#ccon-price-banner');
        if (old) old.parentNode.removeChild(old);
      } catch (e3) {}
    }
  } catch (e) { /* paint is best-effort */ }
  try { prefillProfileInputs(); prefillPackageInputs(); wireSaveButtons(); paintChecklist(); } catch (e4) {}
}

/* Pre-fill profile inputs from creatorDoc (so Save edits, not blanks). */
function prefillProfileInputs() {
  if (!creatorDoc) return;
  var d = creatorDoc;
  var set = function (id, v) { var el = document.getElementById(id); if (el && v != null && String(v) !== '') el.value = v; };
  set('cprof-name', d.name); set('cprof-handle', d.handle); set('cprof-bio', d.bio);
  set('cprof-headline', d.headline); set('cprof-platform', d.platform); set('cprof-niche', d.niche);
  set('cprof-city', d.city);
  /* Item 3 (Cycle 21): languages are a chip multi-select now — restore 'on'
   * state from the stored array (legacy comma string also tolerated). */
  try {
    var _langs = Array.isArray(d.languages) ? d.languages : String(d.languages || '').split(',');
    var _norm = _langs.map(function (s) { return String(s).trim().toLowerCase(); });
    Array.prototype.forEach.call(document.querySelectorAll('#cprof-langtags .tag'), function (t) {
      t.classList.toggle('on', _norm.indexOf(String(t.getAttribute('data-lang') || '').toLowerCase()) > -1);
    });
  } catch (e3) {}
  set('cprof-followers', d.followers); set('cprof-engagement', d.engagement);
  set('cprof-views', d.avgViews); set('cprof-likes', d.avgLikes); set('cprof-reach', d.reach);
  set('cprof-social', d.socialLink); set('cprof-youtube', d.youtube);
  set('cprof-address', d.shippingAddress);
  var barter = document.getElementById('cprof-barter');
  if (barter && d.openToBarter === false) barter.classList.remove('on');
  // WhatsApp lives in the private subcollection — load it once per paint.
  try {
    DB.collection('creators').doc(uid).collection('private').doc('contact').get().then(function (s) {
      var w = document.getElementById('cprof-whatsapp');
      if (w && s.exists && s.data().phone) w.value = s.data().phone;
    });
  } catch (e) {}
}

/* Pre-fill package cards from saved packages[]. */
function prefillPackageInputs() {
  if (!creatorDoc || !creatorDoc.packages) return;
  var byKey = {};
  creatorDoc.packages.forEach(function (p) { byKey[p.key] = p; });
  document.querySelectorAll('.glass.pkg[data-pkg]').forEach(function (card) {
    var p = byKey[card.getAttribute('data-pkg')];
    if (!p) return;
    var setV = function (sel, v) { var el = card.querySelector(sel); if (el && v != null) el.value = v; };
    setV('.pkg-desc', p.description); setV('.pkg-price', p.price);
    setV('.pkg-sale', p.salePrice); setV('.pkg-days', p.deliveryDays);
  });
}

/* ---------------- 20k activation kit (Item 11 — Cycle 16) ----------------
 * 4-step onboarding checklist (IG -> portfolio -> prices -> share link),
 * shareable profile/invite links, and referral tracking. */
function paintChecklist() {
  var rows = document.getElementById('ccon-checklist-rows');
  var count = document.getElementById('ccon-checklist-count');
  if (!rows || !creatorDoc) return;
  var d = creatorDoc;
  var hasPrices = !!((d.prices && Object.keys(d.prices).length) || (d.packages && d.packages.length));
  /* Item 16 fix: portfolio pins are stored in `portfolioMediaIds` (Item 12's
   * save writes that field). The old check looked at `featuredMediaIds` /
   * `portfolio`, which nothing ever writes, so this step could never complete.
   * Legacy fallbacks kept so any old docs still count. */
  var hasPortfolio = !!((d.portfolioMediaIds && d.portfolioMediaIds.length) ||
    (d.featuredMediaIds && d.featuredMediaIds.length) || (d.portfolio && d.portfolio.length));
  var steps = [
    /* Item 17: the Instagram step also ticks when the creator deferred it
     * ("Do it later") — nano creators complete the funnel via barter. */
    { label: 'Connect Instagram', done: !!((d.instagram && d.instagram.username) || igDeferred()) },
    { label: 'Pin portfolio posts', done: hasPortfolio },
    { label: 'Set package prices', done: hasPrices },
    { label: 'Share your profile link', done: !!d.profileShared },
  ];
  var doneCount = steps.filter(function (s) { return s.done; }).length;
  var checkSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12.500l3.500 3.500 6.500-7"></path></svg>';
  var circleSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"></circle></svg>';
  rows.innerHTML = steps.map(function (s) {
    return '<div class="row' + (s.done ? ' done' : '') + '"><div class="t3 ' + (s.done ? 'grn' : 'w') +
      '" style="width: 25px; height: 25px">' + (s.done ? checkSvg : circleSvg) + '</div><span>' + s.label + '</span></div>';
  }).join('');
  if (count) count.textContent = doneCount + '/' + steps.length;
}

/* Shareable profile link: /c/<handle> with copy button. Marks profileShared
 * so the checklist step completes. */
function shareProfileLink() {
  if (!creatorDoc || !creatorDoc.handle) { toast('Set your handle first.'); return; }
  var url = location.origin + '/c/' + creatorDoc.handle;
  var copy = function () {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast('Profile link copied!'); });
      } else { throw 0; }
    } catch (e) {
      toast(url);
    }
  };
  copy();
  // Mark the share step done (best-effort).
  try {
    DB.collection('creators').doc(uid).update({ profileShared: true }).then(function () {
      creatorDoc.profileShared = true; paintChecklist();
    });
  } catch (e2) {}
}

/* Referral: each creator gets a code (= their handle). The code is captured at
 * signup and stored in the private contact doc. When a referred creator
 * completes their first booking, the referrer earns ₹100 credit (server-side
 * via lib/referral.js). */
function getReferralCode() {
  /* Item 2 (referral attribution): the creator app runs in a srcdoc iframe
   * where location.search is always empty, so ?ref= is captured on shell load
   * into sessionStorage ('collancer_ref_code', index.html). Read that first;
   * location.search remains as a fallback (e.g. non-iframe contexts). */
  try {
    var s = sessionStorage.getItem('collancer_ref_code');
    if (s) return String(s).toLowerCase();
  } catch (e) {}
  try {
    var m = /[?&]ref=([a-zA-Z0-9_.]+)/.exec(location.search || '');
    return m ? m[1].toLowerCase() : null;
  } catch (e) { return null; }
}
function storeReferral() {
  var code = getReferralCode();
  if (!code || !uid || !DB) return;
  try {
    DB.collection('creators').doc(uid).collection('private').doc('contact').set({
      referredBy: code, updatedAt: FB.serverStamp(),
    }, { merge: true });
  } catch (e) {}
}

/* Invite & Earn (GROWTH item 4): expose the creator's referral link + stats
 * to the inline tools-screen script via window.CollancerReferral. */
function referralLink() {
  var h = '';
  try { h = String((creatorDoc && (creatorDoc.handleLower || creatorDoc.handle)) || '').toLowerCase().trim(); } catch (e) {}
  if (!h) return null;
  return location.origin + '/?ref=' + encodeURIComponent(h);
}
function referralStats() {
  // Query by creatorId only (indexed) and filter kind client-side — avoids a
  // new composite index. Counts referral_credit payouts for this creator.
  if (!uid || !DB) return Promise.resolve({ count: 0, earned: 0 });
  return DB.collection('payoutRequests').where('creatorId', '==', uid).get().then(function (snap) {
    var count = 0, earned = 0;
    snap.forEach(function (doc) {
      var d = doc.data() || {};
      if (d.kind === 'referral_credit') { count++; earned += Number(d.amount) || 0; }
    });
    return { count: count, earned: earned };
  }).catch(function () { return { count: 0, earned: 0 }; });
}
try {
  window.CollancerReferral = { getLink: referralLink, getStats: referralStats };
} catch (e) {}
function profileCompleteness() {
  if (!creatorDoc) return 29;
  var d = creatorDoc, score = 10;
  if (d.name) score += 10;
  if (d.bio) score += 10;
  if (d.niche) score += 10;
  if (d.city) score += 5;
  if ((d.prices && Object.keys(d.prices).length) || (d.packages && d.packages.length)) score += 15;
  if (d.instagram && d.instagram.username) score += 30;
  return Math.min(100, score);
}

/* ---------------- profile + package saving (Items 8, 9 — Cycle 16) ---------------- */
function _val(id) { var el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
function _num(id) { var v = parseFloat(_val(id)); return isNaN(v) ? 0 : v; }

/* Save profile: name/handle/bio/headline/platform/niche/city/stats/links.
 * Handle change re-reserves creatorHandles/{newLower} (old handle doc stays
 * reserved — rules allow only admin delete; the new reservation is what the
 * uniqueness constraint needs). */
function saveProfile() {
  if (!uid || !DB) { toast('Please wait, loading\u2026'); return; }
  var btn = document.getElementById('cprof-save');
  if (btn) btn.disabled = true;
  var name = _val('cprof-name'), handle = _val('cprof-handle').toLowerCase().replace(/[^a-z0-9_.]/g, '');
  var bio = _val('cprof-bio'), headline = _val('cprof-headline');
  var platform = _val('cprof-platform') || 'Instagram', niche = _val('cprof-niche'), city = _val('cprof-city');
  /* Item 3 (Cycle 21): languages from the chip multi-select — stored as an
   * array of codes so the brand discovery language filter can match. */
  var languages = [];
  try {
    Array.prototype.forEach.call(document.querySelectorAll('#cprof-langtags .tag.on'), function (t) {
      var lv = t.getAttribute('data-lang'); if (lv) languages.push(lv);
    });
  } catch (e) {}
  languages = languages.slice(0, 12);
  if (!name) { toast('Please enter your display name.'); if (btn) btn.disabled = false; return; }
  if (!handle) { toast('Please choose a handle.'); if (btn) btn.disabled = false; return; }
  if (bio && bio.length < 10) { toast('Bio needs at least 10 characters.'); if (btn) btn.disabled = false; return; }
  var oldHandle = (creatorDoc && creatorDoc.handleLower) || '';
  var data = {
    name: name.slice(0, 40), handle: handle, handleLower: handle,
    bio: bio.slice(0, 500), headline: headline.slice(0, 80),
    platform: platform, niche: niche, city: city,
    languages: languages,
    followers: Math.max(0, _num('cprof-followers')),
    engagement: Math.max(0, _num('cprof-engagement')),
    avgViews: Math.max(0, _num('cprof-views')),
    avgLikes: Math.max(0, _num('cprof-likes')),
    reach: Math.max(0, _num('cprof-reach')),
    socialLink: _val('cprof-social').slice(0, 200),
    youtube: _val('cprof-youtube').slice(0, 200),
    updatedAt: FB.serverStamp(),
  };
  var write = function () {
    return DB.collection('creators').doc(uid).update(data).then(function () {
      creatorDoc = Object.assign({}, creatorDoc, data);
      toast('Profile saved.');
      try { if (window.render) window.render(); } catch (e) {}
    });
  };
  var done = function () { if (btn) btn.disabled = false; };
  // Handle changed -> reserve the new handle first (uniqueness), then save.
  if (handle !== oldHandle) {
    reserveHandle(handle, 0).then(function (h) {
      data.handle = h; data.handleLower = h;
      return write();
    }).then(done, function () { toast('Could not save profile. Try again.'); done(); });
  } else {
    write().then(done, function () { toast('Could not save profile. Try again.'); done(); });
  }
}

/* Save packages: reads every .glass.pkg[data-pkg] card (toggle + desc +
 * price + sale + days) and persists packages[] + prices{}. */
var PKG_LABELS = { story: '1 \u00D7 Instagram Story', videopost: '1 \u00D7 Video Post', reel: '1 \u00D7 Instagram Reel', personalvideo: '1 \u00D7 Personal Video', adshoot: '1 \u00D7 Personal Ad Shoot', ytshort: '1 \u00D7 YouTube Short' };
function savePackages() {
  if (!uid || !DB) { toast('Please wait, loading\u2026'); return; }
  var btn = document.getElementById('cprof-savepkg');
  if (btn) btn.disabled = true;
  var cards = document.querySelectorAll('.glass.pkg[data-pkg]');
  var packages = [], prices = {};
  cards.forEach(function (card) {
    var key = card.getAttribute('data-pkg');
    var on = card.classList.contains('on') || !!card.querySelector('.sw.on');
    var desc = (card.querySelector('.pkg-desc') || {}).value || '';
    var price = parseFloat((card.querySelector('.pkg-price') || {}).value || '');
    var sale = parseFloat((card.querySelector('.pkg-sale') || {}).value || '');
    var days = parseInt((card.querySelector('.pkg-days') || {}).value || '', 10);
    if (!on) return; // disabled package -> not offered
    if (isNaN(price) || price < 100) return; // minimum package \u20B9100 (nano trap guard)
    var pkg = {
      key: key, label: PKG_LABELS[key] || key,
      description: String(desc).slice(0, 500),
      price: Math.round(price),
      salePrice: (!isNaN(sale) && sale > 0 && sale < price) ? Math.round(sale) : null,
      deliveryDays: (!isNaN(days) && days > 0) ? days : null,
    };
    packages.push(pkg);
    prices[key] = pkg.salePrice != null ? pkg.salePrice : pkg.price;
  });
  DB.collection('creators').doc(uid).update({
    packages: packages, prices: prices, updatedAt: FB.serverStamp(),
  }).then(function () {
    creatorDoc = Object.assign({}, creatorDoc, { packages: packages, prices: prices });
    toast(packages.length ? 'Packages saved \u2014 you are bookable!' : 'Packages saved.');
    try { if (window.render) window.render(); } catch (e) {}
    if (btn) btn.disabled = false;
  }).catch(function () {
    toast('Could not save packages. Try again.');
    if (btn) btn.disabled = false;
  });
}

/* Save account: WhatsApp -> private contact subcollection (Item 14: never on
 * the public doc), shipping address + barter flag -> public doc. */
function saveAccount() {
  if (!uid || !DB) { toast('Please wait, loading\u2026'); return; }
  var btn = document.getElementById('cprof-saveacct');
  if (btn) btn.disabled = true;
  var wa = _val('cprof-whatsapp').replace(/\D/g, '').slice(0, 15);
  var addr = _val('cprof-address').slice(0, 500);
  var barterEl = document.getElementById('cprof-barter');
  var barter = barterEl ? barterEl.classList.contains('on') : true;
  var done = function () { if (btn) btn.disabled = false; };
  DB.collection('creators').doc(uid).collection('private').doc('contact').set({
    phone: wa, updatedAt: FB.serverStamp(),
  }, { merge: true }).then(function () {
    return DB.collection('creators').doc(uid).update({
      shippingAddress: addr, openToBarter: barter, updatedAt: FB.serverStamp(),
    });
  }).then(function () {
    creatorDoc = Object.assign({}, creatorDoc, { shippingAddress: addr, openToBarter: barter });
    toast('Account details saved.');
    done();
  }).catch(function () { toast('Could not save. Try again.'); done(); });
}

/* Wire the save buttons (creator app has no global data-a dispatcher). */
function wireSaveButtons() {
  try {
    var sp = document.getElementById('cprof-save');
    if (sp && !sp._wired) { sp._wired = true; sp.addEventListener('click', saveProfile); }
    var pk = document.getElementById('cprof-savepkg');
    if (pk && !pk._wired) { pk._wired = true; pk.addEventListener('click', savePackages); }
    var ac = document.getElementById('cprof-saveacct');
    if (ac && !ac._wired) { ac._wired = true; ac.addEventListener('click', saveAccount); }
    var sh = document.getElementById('ccon-share');
    if (sh && !sh._wired) { sh._wired = true; sh.addEventListener('click', shareProfileLink); }
  } catch (e) {}
}

/* ---------------- Instagram connect ---------------- */
function connectInstagram() {
  toast('Opening Instagram authorization\u2026');
  FB.api('instagram-start', {})
    .then(function (r) {
      if (r && r.ok && r.url) { window.top.location.href = r.url; return; }
      var reason = (r && r.reason) || 'unknown';
      if (reason === 'not-configured' || reason === 'server-not-configured') {
        toast('Instagram connect is being set up. Please try again soon.');
      } else {
        toast('Could not start Instagram connect. Please try again.');
      }
    })
    .catch(function () { toast('Could not start Instagram connect. Please try again.'); });
}

/* Item 17 (IG-connect defer): nano creators may not have Instagram yet. The
 * "Do it later" button on the profile IG card sets this per-user flag so the
 * onboarding checklist's Instagram step stops blocking and they can complete
 * the funnel via the barter path. Connecting Instagram later clears the
 * block naturally (the connected state wins in paintChecklist). */
function igDeferred() {
  try { return !!localStorage.getItem('collancer_ig_deferred_' + uid); } catch (e) { return false; }
}
function deferInstagram() {
  try { localStorage.setItem('collancer_ig_deferred_' + uid, '1'); } catch (e) {}
  toast('No problem \u2014 you can connect Instagram anytime from your profile.');
  try {
    var b = document.getElementById('ccon-ig-defer');
    if (b) b.style.display = 'none';
  } catch (e) {}
  try { paintChecklist(); } catch (e) {}
}

/* ---------------- bookings ---------------- */
var STATUS_MAP = {
  Pending: 'Pending', Active: 'Active', PendingCompletion: 'In review',
  Completed: 'Completed', Cancelled: 'Cancelled', Disputed: 'Disputed',
};
function mapBooking(id, d) {
  return {
    id: id, orderId: id,
    status: STATUS_MAP[d.status] || 'Pending',
    brand: d.bizName || 'Brand',
    campaign: d.campaignName || '', product: d.productName || '',
    type: d.type || 'paid', pkgName: d.packageKey || '', pkgDesc: '',
    price: Number(d.creatorPrice || 0),
    platform: d.platform || '', category: d.category || '',
    deadline: fmtDate(d.deadline), deliverables: d.deliverables || '',
    brief: d.brief || '', audience: d.targetAudience || '',
    hashtags: d.hashtags || '', website: d.websiteLink || '',
    cta: d.cta || '', usage: d.usageRights || '',
    revisions: d.revisions || '', exclusivity: d.exclusivity || '',
    other: d.requirements || '', contact: d.contact || '',
    shipping: d.shipping || '', media: d.mediaFiles || [],
    revisionNote: d.revisionNote || '', revisionCount: Number(d.revisionCount || 0),
    isCustomOffer: !!d.isCustomOffer, offerStatus: d.offerStatus || '',
    offerPrice: Number(d.offerPrice || 0), bizVerified: !!d.bizVerified,
    received: (function () {
      try { return (d.createdAt && d.createdAt.toDate ? d.createdAt.toDate() : new Date(d.createdAt)).toISOString(); }
      catch (e) { return new Date().toISOString(); }
    })(),
    _bizId: d.bizId, _firestoreStatus: d.status,
  };
}
/* Creator marks work delivered: Active -> PendingCompletion, starting the
 * 72h brand-review window. Verifies the booking belongs to this creator.
 * Update shape matches firestore.rules exactly (CREATOR delivery submit
 * allows status/driveLink/promotedVideoLink/deliverySubmittedAt/
 * completionRequestedAt/adminRejected/adminRejectionReason/reviewDeadline/
 * seenByCreator — deliveredAt/updatedAt are NOT allowed and would be denied).
 * deliveryUrl: optional proof-of-delivery link (post URL, Drive link...). */
function deliverBooking(bookingId, deliveryUrl) {
  var ref = DB.collection('bookings').doc(String(bookingId || ''));
  var bizId = null;
  ref.get().then(function (snap) {
    if (!snap.exists) throw new Error('not_found');
    var d = snap.data() || {};
    if (String(d.creatorId) !== String(uid)) throw new Error('not_your_booking');
    if (d.status !== 'Active') throw new Error('wrong_status');
    bizId = d.bizId || null;
    var patch = {
      status: 'PendingCompletion',
      deliverySubmittedAt: FB.serverStamp(),
      reviewDeadline: new Date(Date.now() + 72 * 3600 * 1000),
      seenByCreator: true,
    };
    var url = String(deliveryUrl || '').trim().slice(0, 500);
    if (url) patch.driveLink = url;
    return ref.update(patch);
  }).then(function () {
    toast('Work delivered. The brand has 72 hours to review.');
    // REMOVED (Cycle 13+14+15, Item 7): the bizNotifs write here was 100%
    // permission-denied — firestore.rules only let a user create bizNotifs
    // for their own bizId, and this was the brand's. Server writes
    // notifications via the Admin SDK instead.
  }).catch(function (e) {
    var m = (e && e.message) || '';
    if (m === 'not_your_booking') toast('This booking does not belong to your account.');
    else if (m === 'wrong_status') toast('Only active bookings can be marked delivered.');
    else toast('Could not mark as delivered. Please try again.');
  });
}
function loadBookings() {
  var col = DB.collection('bookings');
  var q;
  try { q = col.where('creatorId', '==', uid).orderBy('createdAt', 'desc'); }
  catch (e) { q = col.where('creatorId', '==', uid); }
  trackUnsub(q.onSnapshot(function (snap) {
    var arr = [];
    snap.forEach(function (doc) { arr.push(mapBooking(doc.id, doc.data())); });
    arr.sort(function (a, b) { return (b.received || '').localeCompare(a.received || ''); });
    creatorBookings = arr;
    try { window.CollancerBookings.set(arr); } catch (e) {}
    paintEarnings();
  }, function () {
    // index missing -> retry without orderBy
    trackUnsub(col.where('creatorId', '==', uid).onSnapshot(function (snap) {
      var arr = [];
      snap.forEach(function (doc) { arr.push(mapBooking(doc.id, doc.data())); });
      arr.sort(function (a, b) { return (b.received || '').localeCompare(a.received || ''); });
      creatorBookings = arr;
      try { window.CollancerBookings.set(arr); } catch (e) {}
      paintEarnings();
    }));
  }));
  // persist accept/decline through the rule-safe state machine
  try {
    window.CollancerBookings.onAction = function (booking, action) {
      if (!booking || !booking.id) return;
      var ref = DB.collection('bookings').doc(booking.id);
      if (action === 'accept') {
        var patch = { status: 'Active', acceptedAt: FB.serverStamp(), acceptedByCreator: true, seenByCreator: true };
        ref.update(patch).then(function () { notifyBiz(); notifyBookingParty('booking_accepted', booking.id); }).catch(function () { toast('Could not update booking. Please try again.'); });
        return;
      }
      // Item 13: accepting a custom offer uses the same rule-safe
      // Pending -> Active shape as a normal accept; the agreed price is the
      // booking's offerPrice. The brand collects payment via collancerPayOffer.
      if (action === 'acceptOffer') {
        var opatch = { status: 'Active', acceptedAt: FB.serverStamp(), acceptedByCreator: true, seenByCreator: true };
        ref.update(opatch).then(function () {
          try { sendChatMessage(booking.id, 'Accepted your custom offer of \u20B9' + Number(booking.offerPrice || 0).toLocaleString('en-IN') + '.'); } catch (e) {}
          notifyBookingParty('booking_accepted', booking.id);
          // REMOVED (Cycle 13+14+15, Item 7): the bizNotifs write here was
          // 100% permission-denied (rules: bizNotifs create requires
          // bizId == caller's own uid). Server writes notifications instead.
        }).catch(function () { toast('Could not update booking. Please try again.'); });
        return;
      }
      if (action === 'deliver') { deliverBooking(booking.id, booking.deliveryUrl); return; }
        // REJECT: mark cancelled + attach the refund INTENT on the booking
        // doc only. The creator can never write walletTransactions rows
        // (the ledger is server-only: firestore.rules deny ALL client ledger
        // creates, and a creator writing the brand's bizId was a rule
        // violation anyway). The actual wallet credit + ledger entry are
        // written server-side by the cron (api/booking-deadlines.js section
        // 1b), idempotent on the deterministic refund_{bookingId} doc id.
        DB.runTransaction(function (tx) {
          return tx.get(ref).then(function (snap) {
            var d = snap.data() || {};
            // B-C2: refundAmount is SERVER-TRUTH — always the booking's own
            // paidAmount (written server-side by api/booking-create.js). Never
            // take a client-supplied refund amount.
            var amt = Number(d.paidAmount || 0);
            var refundable = !d.barter && amt > 0 && !d.refundProcessed && d.status === 'Pending';
            var p = { status: 'Cancelled', rejectedAt: FB.serverStamp(), rejectedByCreator: true, seenByCreator: true };
            if (refundable) {
              p.refundProcessed = false;
              p.refundRequested = true;
              p.refundAmount = amt;
              p.refundStatus = 'pending';
            }
            tx.update(ref, p);
          });
        }).then(notifyBiz).catch(function () { toast('Could not update booking. Please try again.'); });
      function notifyBiz() {
        // REMOVED (Cycle 13+14+15, Item 7): the bizNotifs write here was
        // 100% permission-denied — firestore.rules only let a user create
        // bizNotifs for their own bizId, and this was the brand's. Kept as
        // a no-op so the .then(notifyBiz) call chain still settles cleanly.
      }
      /* Item 15 (Cycle 19): server-owned cross-party notification. The
       * client cannot write the brand's feed (rules), so after our own
       * state write succeeds we ask /api/booking-action to notify the
       * other side via the Admin SDK. Best-effort — never blocks UI. */
      function notifyBookingParty(kind, bookingId) {
        try {
          if (window.FB && FB.api) {
            FB.api('booking-action', { action: 'notify', kind: kind, bookingId: String(bookingId || '') })
              .catch(function () {});
          }
        } catch (e) {}
      }
    };
  } catch (e) {}
}

/* ---------------- earnings ---------------- */
/* Item 30 (payout-queue UI): prefill the creator's last-used payout
 * destination. On earnings-form load, ask the server for the caller's most
 * recent payout destination (payout-last-destination) and fill the UPI input
 * when a value exists and the field is still empty. Fallback: the server
 * reads the single-string `destination` field, which the current creator
 * save flow never writes (it writes method/upi/… via the scoped
 * firestore.rules update branch) — so also check the caller's own latest
 * payoutRequest `upi` field directly (owner read is rules-allowed).
 * Read-only prefill; the save flow (submitPayout) is untouched. */
function prefillLastDestination(){
  var root = $('#s-earnings');
  var upiInp = root && $('#upi', root);
  if(!upiInp || window._lastDestTried) return;
  window._lastDestTried = true;
  function setIfEmpty(sel, v){
    var el = root && $(sel, root);
    v = String(v || '').trim();
    if(el && v && !el.value) el.value = v;
  }
  function setMethod(m){
    try{
      var t = root.querySelector('#mt>div[data-m="' + m + '"]');
      if(t && !t.classList.contains('on')) t.click();
    }catch(e){}
  }
  /* Item 30 fix: prefill the BANK form too, not just the UPI input. Bank
   * fields (#hn holder, #an account, #ifs IFSC) fill when the last-used
   * destination was a bank payout; the method toggle follows. */
  function fillBank(d){
    var any = false;
    if(String(d.holder || '').trim()){ setIfEmpty('#hn', d.holder); any = true; }
    if(String(d.account || '').trim()){ setIfEmpty('#an', d.account); any = true; }
    if(String(d.ifsc || '').trim()){ setIfEmpty('#ifs', d.ifsc); any = true; }
    if(any) setMethod('bank');
    return any;
  }
  function fillFrom(r){
    if(!r) return false;
    var isBank = String(r.method || '') === 'bank' ||
      (!!String(r.holder || r.account || '').trim() && !String(r.upi || '').trim());
    if(isBank) return fillBank(r);
    var d = r.destination ? String(r.destination).trim() : String(r.upi || '').trim();
    if(d){ setIfEmpty('#upi', d); return true; }
    return false;
  }
  function fallback(){
    try{
      DB.collection('payoutRequests').where('creatorId', '==', uid).limit(25).get().then(function(snap){
        var best = null, bestAt = -1;
        snap.forEach(function(doc){
          var d = doc.data() || {};
          var u = String(d.upi || d.destination || '').trim();
          if(!u && !d.holder && !d.account) return;
          var c = d.createdAt, at = (c && c.toMillis) ? c.toMillis() : 0;
          if(at >= bestAt){ bestAt = at; best = d; }
        });
        fillFrom(best);
      }).catch(function(){});
    }catch(e){}
  }
  try{
    if(window.FB && FB.api){
      FB.api('booking-action', { action: 'payout-last-destination' }).then(function(r){
        if(!fillFrom(r)) fallback();
      }).catch(function(){ fallback(); });
    }else{ fallback(); }
  }catch(e){ fallback(); }
}
function paintEarnings() {
  var root = $('#s-earnings');
  if (!root) return;
  prefillLastDestination();
  var released = 0, locked = 0;
  creatorBookings.forEach(function (b) {
    var share = Number(b.price || 0) * 0.95;
    if (b._firestoreStatus === 'Completed') released += share;
    else if (b._firestoreStatus === 'Active' || b._firestoreStatus === 'PendingCompletion') locked += share;
  });
  var pending = 0, successful = 0;
  DB.collection('payoutRequests').where('creatorId', '==', uid).get().then(function (snap) {
    snap.forEach(function (doc) {
      var d = doc.data(), a = Number(d.amount || 0);
      /* Item 13a: 'accumulating' is a real queued payout (sub-₹100 shares the
       * server queues via /api/booking-action + booking-deadlines; admin
       * combines them with future payouts). It was silently dropped from the
       * stats though the money is still withdrawable — count it with pending
       * (queued, awaiting release), same as any other unreleased payout. */
      if (d.status === 'pending' || d.status === 'accumulating') pending += a;
      else if (d.status === 'approved' || d.status === 'paid' || d.status === 'completed') successful += a;
    });
    var avail = Math.max(0, released - successful - pending);
    try {
      var stats = $all('#po .sc b', root);
      if (stats[0]) stats[0].textContent = inr(Math.round(locked));
      if (stats[1]) stats[1].textContent = inr(Math.round(released));
      if (stats[2]) stats[2].textContent = inr(Math.round(pending));
      if (stats[3]) stats[3].textContent = inr(Math.round(successful));
      var avEl = $('#pw .av b', root);
      if (avEl) avEl.textContent = inr(Math.round(avail));
      root._avail = avail;
    } catch (e) {}
    // Item 10 (Cycle 19): TDS/194J — show FY payout total. Reads the
    // server-maintained creators/{uid}/private/tdsTracking counters
    // (SENTINEL-287: kept off the world-readable public creators doc);
    // created on demand with the existing .m style (no new visual language).
    try {
      DB.collection('creators').doc(uid).collection('private').doc('tdsTracking').get().then(function (csnap) {
        var cd = csnap.exists ? (csnap.data() || {}) : {};
        var fy = cd.payoutFY, total = Number(cd.payoutFYTotal || 0);
        var line = root.querySelector('#fyline');
        if (!line) {
          var bal = root.querySelector('.glass.bal');
          var anchor = bal && bal.querySelector('.m');
          if (bal && anchor) {
            line = document.createElement('div');
            line.className = 'm'; line.id = 'fyline';
            line.style.marginTop = '6px';
            anchor.parentNode.insertBefore(line, anchor.nextSibling);
          }
        }
        if (line) {
          /* Item 7 (Cycle 21): TDS copy only — no deduction logic (server-side
           * agent owns the data hooks). The FY ₹50k threshold concept stays
           * visible even before any FY payouts exist. */
          var tdsNote = cd.tdsApplicable
            ? 'TDS may apply above \u20B950,000 this FY (CA opinion pending).'
            : 'TDS: not deducted yet (CA opinion pending). Applies on FY payouts above \u20B950,000.';
          line.textContent = (fy ? 'FY ' + fy + ' payouts: ' + inr(Math.round(total)) + ' \u00B7 ' : '') + tdsNote;
          line.style.display = '';
        }
      }).catch(function () {});
    } catch (e) {}
    paintPayoutHistory();
  }).catch(function () {});
}
/* 6a (Cycle 21): payout status labels resolve through the money-screen i18n
 * (window.tM) so Hindi mode shows Hindi. Falls back to English. */
function payoutStatusLabel(s) {
  var t = function (k) { try { return window.tM ? window.tM(k) : k; } catch (e) { return k; } };
  if (s === 'pending') return t('Pending');
  /* Item 13a: 'accumulating' previously fell through to the raw status key.
   * Resolve it through the money i18n dict ('Accumulating (under ₹100)' /
   * Hindi) like every other payout status. */
  if (s === 'accumulating') return t('Accumulating');
  if (s === 'approved' || s === 'paid' || s === 'completed') return t('Paid out');
  return s || '';
}
function paintPayoutHistory() {  var root = $('#s-earnings');
  var pz = root && $('#pz', root);
  if (!pz) return;
  DB.collection('payoutRequests').where('creatorId', '==', uid).orderBy('createdAt', 'desc').limit(20).get()
    .then(function (snap) {
      if (snap.empty) return; // keep the designed empty state
      var html = snap.docs.map(function (doc) {
        var d = doc.data();
        /* 6a (Cycle 21): payout status labels through tM() — no hardcoded
         * English in Hindi mode. */
        var st = payoutStatusLabel(d.status);
        return '<div class="glass card" style="margin-top:12px"><div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div><div style="font-size:15px;font-weight:800">' + inr(d.amount) + '</div>' +
          '<div style="font-size:12px;color:#55616d;margin-top:2px">' + esc(agoStr(d.createdAt)) + ' \u00B7 ' + esc(d.method || 'UPI') + '</div></div>' +
          '<div class="glass pill">' + esc(st) + '</div></div></div>';
      }).join('');
      var wrap = $('#ccon-payouts');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'ccon-payouts';
        pz.appendChild(wrap);
      }
      wrap.innerHTML = html;
    }).catch(function () {});
}
/* Canonical payout request (1d — matches the firestore.rules payoutRequests
 * create rule exactly): one payout per booking, deterministic doc id
 * `payout_{bookingId}`, amount EXACTLY Math.round(creatorPrice * 0.95),
 * bookingId + creatorId + status 'pending'. The amount is never typed in by
 * the creator — it is computed from the completed booking, so the rule's
 * exact-equality check always passes. */
function eligiblePayoutBookings() {
  // Completed bookings with no payout doc yet (server auto-release or a
  // previous request covers the rest).
  // Item 11 (Cycle 17, LEDGER): also surface server-queued payouts that are
  // missing destination info (no UPI/bank details) — the brand-approve and
  // cron auto-approve paths queue payout_{bookingId} via Admin SDK without
  // destination fields, and previously the creator had no path to add them,
  // so those payouts stalled in the admin queue. Flagged needsDetails so the
  // picker + submit flow can add destination fields via the scoped rules
  // update (method/upi/holder/account/ifsc only).
  return DB.collection('bookings').where('creatorId', '==', uid).get().then(function (snap) {
    var done = {};
    var needsDetails = {};
    return DB.collection('payoutRequests').where('creatorId', '==', uid).get().then(function (ps) {
      ps.forEach(function (d) {
        var b = d.data() || {};
        if (!b.bookingId) return;
        // Only payout_ docs are creator-actionable here. killfee_* docs are
        // the creator's compensation when a brand cancels an Active booking
        // (10% of the paid amount, capped at the retained platform fee, queued
        // by the refund cron for admin release), and ref_* docs are referral
        // credits — both are admin-released, so the creator never adds payout
        // details to them.
        if (d.id.indexOf('payout_') !== 0) { done[b.bookingId] = true; return; }
        var hasDest = (b.upi && String(b.upi).trim()) || (b.account && String(b.account).trim());
        if (hasDest || b.status !== 'pending') done[b.bookingId] = true;
        else needsDetails[b.bookingId] = d.id; // pending payout, no destination
      });
      var arr = [];
      snap.forEach(function (d) {
        var b = d.data() || {};
        if (b.status !== 'Completed' || done[d.id]) return;
        var share = Math.round(Number(b.creatorPrice || 0) * 0.95);
        if (share < 100) return; // the rule requires amount >= 100
        arr.push({
          id: d.id, creatorPrice: Number(b.creatorPrice || 0), amount: share,
          campaign: b.campaignName || '', biz: b.bizName || '',
          needsDetails: !!needsDetails[d.id],
          payoutDocId: needsDetails[d.id] || null,
        });
      });
      return arr;
    });
  });
}
function renderPayoutPicker(list) {
  var root = $('#s-earnings');
  var wrap = $('#ccon-payout-pick', root);
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'ccon-payout-pick';
    var pz = $('#pz', root);
    if (pz && pz.parentNode) pz.parentNode.insertBefore(wrap, pz);
    else root.appendChild(wrap);
  }
  wrap.innerHTML = '<div style="font-size:13px;font-weight:800;margin:10px 0 6px">Choose a completed booking to withdraw its payout:</div>' +
    list.map(function (b, i) {
      return '<div class="glass card" style="margin-top:8px"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px">' +
        '<div><div style="font-size:15px;font-weight:800">' + inr(b.amount) + '</div>' +
        '<div style="font-size:12px;color:#55616d;margin-top:2px">' + esc(b.campaign || 'Collaboration') +
        (b.biz ? ' \u00B7 ' + esc(b.biz) : '') + '</div></div>' +
        '<button class="black" data-pick="' + i + '" style="min-width:96px;height:42px;border-radius:21px">' + (b.needsDetails ? 'Add UPI' : 'Request') + '</button>' +
        '</div></div>';
    }).join('');
  $all('[data-pick]', wrap).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var b = list[+btn.getAttribute('data-pick')];
      if (!b) return;
      root._payoutPick = b;
      try { wrap.innerHTML = ''; } catch (e) {}
      continuePayout(b);
    });
  });
}
/* 6b (Cycle 21): destination-confirm sheet. Consumes the validated dest/amt
 * snapshot and shows it back (masked) for an explicit confirm before anything
 * is queued — both the create path and the needsDetails update path. */
function maskUpi(u) {
  u = String(u || ''); var p = u.split('@');
  if (p.length !== 2 || p[0].length < 2) return u;
  return p[0].slice(0, 2) + '***@' + p[1];
}
function maskAcct(a) {
  a = String(a || '').replace(/\D/g, '');
  return a.length > 4 ? '****' + a.slice(-4) : '****';
}
function confirmPayoutSheet(b, amt, dest, onConfirm) {
  var destLine = dest.method === 'upi'
    ? 'UPI&nbsp;' + esc(maskUpi(dest.upi))
    : 'A/C&nbsp;' + esc(maskAcct(dest.account)) + ' · IFSC&nbsp;' + esc(dest.ifsc);
  cconSheet('Confirm payout',
    'Check the destination carefully — payouts cannot be reversed once sent.',
    '<div class="glass card" style="padding:6px 16px">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(15,40,60,.08)"><span style="color:#55616d;font-size:13.5px">Amount</span><b style="font-size:16px">' + inr(amt) + '</b></div>'
    + '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(15,40,60,.08)"><span style="color:#55616d;font-size:13.5px">Destination</span><b style="font-size:14px;text-align:right">' + destLine + '</b></div>'
    + '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0"><span style="color:#55616d;font-size:13.5px">Booking</span><b style="font-size:14px;text-align:right;max-width:58%">' + esc(b.campaign || 'Collaboration') + (b.biz ? ' · ' + esc(b.biz) : '') + '</b></div>'
    + '</div>'
    + '<div style="display:flex;gap:10px;margin-top:14px">'
    + '<button type="button" class="black" id="ccon-pok" style="flex:1;height:44px;border-radius:22px">Confirm payout</button>'
    + '<button type="button" class="tag glass" id="ccon-pox" style="flex:1;height:44px;border-radius:22px;justify-content:center;font-weight:700">' + (window.tM ? window.tM('Cancel') : 'Cancel') + '</button>'
    + '</div>');
  var ov = document.getElementById('ccon-sheet');
  if (ov) {
    var ok = ov.querySelector('#ccon-pok'), no = ov.querySelector('#ccon-pox');
    if (ok) ok.addEventListener('click', function () { cconCloseSheet(); onConfirm(); });
    if (no) no.addEventListener('click', function () { cconCloseSheet(); });
  }
}
/* The actual queue write, extracted so the confirm sheet gates it. */
function submitPayout(b, amt, dest) {
  var root = $('#s-earnings');
  var amtEl = $('#amt', root), erEl = $('#er', root);
  erEl.textContent = 'Submitting payout request\u2026';
  // Item 11 (Cycle 17, LEDGER): the payout doc may already exist — queued by
  // the server on brand-approve / cron auto-approve without destination
  // fields. In that case UPDATE only the destination fields (the scoped
  // firestore.rules update branch allows exactly method/upi/holder/account/
  // ifsc on the creator's own pending payouts; amount/status stay immutable).
  if (b.needsDetails && b.payoutDocId) {
    DB.collection('payoutRequests').doc(b.payoutDocId).update({
      method: dest.method, upi: dest.upi || '', holder: dest.holder || '',
      account: dest.account || '', ifsc: dest.ifsc || '',
    }).then(function () {
      erEl.textContent = '';
      if (amtEl) amtEl.value = '';
      root._payoutPick = null;
      toast('Payout details saved.');
      paintEarnings();
    }).catch(function () { erEl.textContent = 'Could not save. Please try again.'; });
    return;
  }
  // Rule-safe shape: deterministic id payout_{bookingId}, exact canonical
  // amount, bookingId + creatorId + status pending.
  DB.collection('payoutRequests').doc('payout_' + b.id).set({
    creatorId: uid, bookingId: b.id, amount: amt, status: 'pending',
    method: dest.method, upi: dest.upi || '', holder: dest.holder || '',
    account: dest.account || '', ifsc: dest.ifsc || '',
    createdAt: FB.serverStamp(),
  }, { merge: true }).then(function () {
    erEl.textContent = '';
    if (amtEl) amtEl.value = '';
    root._payoutPick = null;
    toast('Payout request submitted.');
    /* INSIGHT-1: analytics — payout requested */
    try { if (typeof track === 'function') track('payout_requested', { amount: amt, method: dest.method }); } catch (e) {}
    paintEarnings();
  }).catch(function () { erEl.textContent = 'Could not submit. Please try again.'; });
}
function continuePayout(b) {
  var root = $('#s-earnings');
  var amtEl = $('#amt', root), erEl = $('#er', root);
  if (!b || !b.id) { erEl.textContent = 'No completed booking selected.'; return; }
  // Canonical amount: the rule demands EXACT Math.round(creatorPrice * 0.95).
  var amt = Math.round(Number(b.creatorPrice || 0) * 0.95);
  if (!(amt >= 100)) { erEl.textContent = 'This booking has no withdrawable payout.'; return; }
  if (amtEl) amtEl.value = String(amt); // display the canonical amount
  var meth = 'upi';
  var mtOn = root.querySelector('#mt .on');
  if (mtOn) meth = mtOn.dataset.m || 'upi';
  var dest = {}, ok = false;
  if (meth === 'upi') {
    var upi = ($('#upi', root).value || '').trim();
    ok = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi);
    if (!ok) { erEl.textContent = 'Enter a valid UPI ID.'; return; }
    dest = { method: 'upi', upi: upi };
  } else {
    var hn = ($('#hn', root).value || '').trim();
    var an = ($('#an', root).value || '').trim();
    var ifs = ($('#ifs', root).value || '').trim().toUpperCase();
    ok = hn.length > 2 && /^\d{6,18}$/.test(an) && /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(ifs);
    if (!ok) { erEl.textContent = 'Enter valid bank details.'; return; }
    dest = { method: 'bank', holder: hn, account: an, ifsc: ifs };
  }
  /* 6b: validation passed — show the destination-confirm sheet with the
   * validated snapshot before anything is queued. */
  confirmPayoutSheet(b, amt, dest, function () { submitPayout(b, amt, dest); });
}
function requestPayout() {
  var root = $('#s-earnings');
  var erEl = $('#er', root);
  if (root._payoutPick && root._payoutPick.id) { continuePayout(root._payoutPick); return; }
  erEl.textContent = 'Finding completed bookings\u2026';
  eligiblePayoutBookings().then(function (list) {
    if (!list.length) { erEl.textContent = 'No completed bookings are awaiting payout.'; return; }
    if (list.length === 1) {
      root._payoutPick = list[0];
      continuePayout(list[0]);
      return;
    }
    erEl.textContent = '';
    renderPayoutPicker(list);
  }).catch(function () { erEl.textContent = 'Could not load bookings. Please try again.'; });
}

/* ---------------- market (requirements + proposals) ---------------- */
function loadMarket() {
  // real open requirements (public read)
  DB.collection('requirements').where('status', '==', 'open').orderBy('createdAt', 'desc').limit(30).get()
    .then(function (snap) {
      requirementsCache = [];
      snap.forEach(function (doc) {
        var d = doc.data(); d.id = doc.id;
        requirementsCache.push(d);
      });
      paintRequirements();
    })
    .catch(function () {
      DB.collection('requirements').where('status', '==', 'open').limit(30).get().then(function (snap) {
        requirementsCache = [];
        snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; requirementsCache.push(d); });
        paintRequirements();
      }).catch(function () {});
    });
  // my proposals
  DB.collection('requirementOffers').where('creatorId', '==', uid).orderBy('createdAt', 'desc').limit(30).get()
    .then(function (snap) {
      myOffers = [];
      snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; myOffers.push(d); });
      paintProposals();
    })
    .catch(function () {
      DB.collection('requirementOffers').where('creatorId', '==', uid).get().then(function (snap) {
        myOffers = [];
        snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; myOffers.push(d); });
        paintProposals();
      }).catch(function () {});
    });
}
function paintRequirements() {
  var root = $('#s-market');
  if (!root) return;
  var demo = $('#brief', root);
  var list = $('#ccon-reqs');
  if (!list) {
    list = document.createElement('div');
    list.id = 'ccon-reqs';
    list.style.cssText = 'display:flex;flex-direction:column;gap:12.5px;margin-top:12.5px;';
    if (demo && demo.parentNode) demo.parentNode.insertBefore(list, demo.nextSibling);
  }
  if (demo) demo.style.display = 'none'; // demo brief replaced by live data
  var q = (($('#q', root) || {}).value || '').toLowerCase();
  var chipEl = root.querySelector('#chips .black');
  var chip = chipEl ? chipEl.textContent.toLowerCase() : 'all';
  var items = requirementsCache.filter(function (r) {
    var hay = ((r.title || '') + ' ' + (r.description || '') + ' ' + (r.category || '') + ' ' + (r.bizName || '')).toLowerCase();
    var okQ = !q || hay.indexOf(q) > -1;
    var okC = chip === 'all' || hay.indexOf(chip) > -1;
    return okQ && okC;
  });
  var nob = $('#nob', root);
  if (nob) nob.style.display = items.length ? 'none' : '';
  var cb = root.querySelector('.panel#p1 .sec .glass.cb, #p1 .sec .glass.cb');
  if (cb) cb.textContent = items.length;
  list.innerHTML = items.map(function (r, i) {
    return '<div class="glass card" data-req="' + esc(r.id) + '">' +
      '<div style="display:flex;gap:12.5px;align-items:center"><div class="t3 teal" style="width:50.5px;height:50.5px"><svg viewBox="0 0 24 24"><use href="#tag"/></svg></div>' +
      '<div style="flex:1"><div style="font-size:16.5px;font-weight:800">' + esc(r.title || 'Brand brief') + '</div>' +
      '<div style="margin-top:2.5px;font-size:12px;color:#55616d">' + esc(r.bizName || 'Brand') + ' \u00B7 ' + esc(agoStr(r.createdAt)) + '</div></div>' +
      (r.budget ? '<div class="bud">Budget<b>' + inr(r.budget) + '</b></div>' : '') + '</div>' +
      (r.description ? '<div style="margin-top:10px;font-size:13px;line-height:1.45;color:#3b4652">' + esc(String(r.description).slice(0, 160)) + '</div>' : '') +
      '<div style="display:flex;gap:7px;margin-top:12px;flex-wrap:wrap">' +
      (r.category ? '<div class="glass pill t">' + esc(r.category) + '</div>' : '') +
      (r.platform ? '<div class="glass pill">' + esc(r.platform) + '</div>' : '') + '</div>' +
      '<button class="black" data-reqbtn="' + esc(r.id) + '" style="width:100%;height:45px;margin-top:14.5px;border-radius:22.5px"><svg class="ico" style="stroke:#fff;width:17px;height:17px"><use href="#send"/></svg>Send proposal</button></div>';
  }).join('');
  $all('[data-reqbtn]', list).forEach(function (b) {
    b.addEventListener('click', function () {
      selectedReq = null;
      requirementsCache.forEach(function (r) { if (r.id === b.getAttribute('data-reqbtn')) selectedReq = r; });
      var open = $('#open', root);
      if (open) open.click(); // reuse the designed sheet
      else toast('Proposal sheet unavailable.');
    });
  });
  // live search filter for real cards
  var qEl = $('#q', root);
  if (qEl && !qEl._ccon) {
    qEl._ccon = true;
    qEl.addEventListener('input', paintRequirements);
    var chips = $('#chips', root);
    if (chips) chips.addEventListener('click', function () { setTimeout(paintRequirements, 50); });
  }
}
function paintProposals() {
  var root = $('#s-market');
  if (!root) return;
  var list = $('#list', root), empty = $('#empty', root);
  if (!list) return;
  if (!myOffers.length) return; // keep designed empty state until real data arrives
  if (empty) empty.style.display = 'none';
  var pend = myOffers.filter(function (x) { return x.status === 'pending'; }).length;
  var cnt = $('#cnt', root); if (cnt) cnt.textContent = pend + (pend === 1 ? ' proposal' : ' proposals');
  var bd2 = $('#bd2', root); if (bd2) bd2.textContent = myOffers.length;
  var cb2 = $('#cb2', root); if (cb2) cb2.textContent = myOffers.length;
  list.innerHTML = myOffers.map(function (x) {
    var pd = x.status === 'pending';
    return '<div class="glass card"><div style="display:flex;gap:12.5px;align-items:center"><div class="t3 teal" style="width:43px;height:43px"><svg viewBox="0 0 24 24"><use href="#send"/></svg></div>' +
      '<div style="flex:1"><div style="font-size:16px;font-weight:800">' + esc(x.requirementTitle || 'Brand brief') + '</div>' +
      '<div style="margin-top:2px;font-size:12px;color:#55616d">' + esc(x.bizName || 'Brand') + ' \u00B7 Sent ' + esc(agoStr(x.createdAt)) + '</div></div>' +
      '<div class="glass pill ' + (pd ? 'st-p' : 'st-w') + '">' + (pd ? 'Pending' : esc(x.status || '')) + '</div></div>' +
      '<div style="height:1px;background:rgba(15,40,60,.08);margin:12.5px 0"></div>' +
      '<div class="prow"><span>Your proposed price</span><b>' + inr(x.price) + '</b></div>' +
      '<div style="margin-top:11px;font-size:13px;line-height:1.4;color:#3b4652">' + esc(x.message || '') + '</div>' +
      (x.timeline ? '<div style="margin-top:5.5px;font-size:12px;color:#55616d">Timeline: ' + esc(x.timeline) + '</div>' : '') +
      (pd ? '<button class="wd" data-offer="' + esc(x.id) + '">Withdraw proposal</button>' : '') + '</div>';
  }).join('');
}
function sendProposal() {
  var root = $('#s-market');
  var priceEl = $('#price', root), pitchEl = $('#pitch', root), tlEl = $('#tl', root), errEl = $('#err', root);
  var p = parseInt((priceEl.value || '').replace(/\D/g, ''), 10) || 0;
  if (!p) { errEl.textContent = 'Enter your price to send a proposal.'; return; }
  if ((pitchEl.value || '').trim().length < 5) { errEl.textContent = 'Add a short pitch message.'; return; }
  if (!selectedReq) { errEl.textContent = 'Please choose a brief first.'; return; }
  errEl.textContent = 'Sending\u2026';
  DB.collection('requirementOffers').add({
    requirementId: selectedReq.id,
    requirementTitle: selectedReq.title || '',
    bizId: selectedReq.bizId || '', bizName: selectedReq.bizName || '',
    creatorId: uid, creatorName: (creatorDoc && creatorDoc.name) || '',
    creatorHandle: (creatorDoc && creatorDoc.handle) || '',
    price: p, message: pitchEl.value.trim(), timeline: (tlEl.value || '').trim(),
    status: 'pending', createdAt: FB.serverStamp(),
  }).then(function () {
    priceEl.value = ''; pitchEl.value = ''; tlEl.value = '';
    errEl.textContent = '';
    try {
      var form = $('#form', root), sent = $('#sent', root);
      if (form) form.style.display = 'none';
      if (sent) sent.style.display = 'block';
      var okt = $('#okt', root), oks = $('#oks', root);
      if (okt) okt.textContent = 'Proposal sent!';
      if (oks) oks.textContent = 'Your pitch is on its way to ' + (selectedReq.bizName || 'the brand') + '. Track it under My proposals.';
    } catch (e) {}
    toast('Proposal sent.');
    selectedReq = null;
    loadMarket();
  }).catch(function () { errEl.textContent = 'Could not send. Please try again.'; });
}
function withdrawOffer(btn) {
  var id = btn.getAttribute('data-offer');
  if (!id) return;
  DB.collection('requirementOffers').doc(id).update({
    status: 'withdrawn', withdrawnAt: FB.serverStamp(), updatedAt: FB.serverStamp(),
  }).then(function () { loadMarket(); })
    .catch(function () { toast('Could not withdraw. Please try again.'); });
}

/* ---------------- Collancer AI ---------------- */
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
function aiContext() {
  return {
    user: creatorDoc || {}, bookings: creatorBookings, payouts: [],
    verification: null, convo: null, live: true,
  };
}
function renderAiUser(t) {
  var M = $('#s-ai #msgs');
  if (!M) return null;
  var u = document.createElement('div');
  u.className = 'u';
  u.textContent = t;
  M.appendChild(u); M.scrollTop = M.scrollHeight;
  return u;
}
function renderAiTyping() {
  var M = $('#s-ai #msgs');
  if (!M) return null;
  var d = document.createElement('div');
  d.className = 'glass a';
  d.innerHTML = '<div class="dots"><i></i><i></i><i></i></div>';
  M.appendChild(d); M.scrollTop = M.scrollHeight;
  return d;
}
function renderAiBot(t, speakIt) {
  var M = $('#s-ai #msgs');
  if (!M) return;
  var a = document.createElement('div');
  a.className = 'glass a';
  a.textContent = t;
  var s = document.createElement('button');
  s.className = 'glass spk';
  s.setAttribute('aria-label', 'Read aloud');
  s.innerHTML = '<svg class="ico" style="width:20px;height:20px"><use href="#spk"/></svg>';
  s.onclick = function () {
    try {
      var S = window.speechSynthesis;
      if (!S) return;
      if (s.classList.contains('on')) { S.cancel(); s.classList.remove('on'); return; }
      S.cancel();
      var u = new SpeechSynthesisUtterance(t);
      u.lang = 'en-IN';
      u.onend = function () { s.classList.remove('on'); };
      s.classList.add('on');
      S.speak(u);
    } catch (e) {}
  };
  M.appendChild(a); M.appendChild(s); M.scrollTop = M.scrollHeight;
  if (speakIt) { try { s.onclick(); } catch (e) {} }
}
function aiSend(fromVoice) {
  var IN = $('#s-ai #in');
  var t = IN ? IN.value : '';
  if (!t || !t.trim()) return;
  if (IN) { IN.value = ''; }
  renderAiUser(t.trim());
  var typing = renderAiTyping();
  cleoReady().then(function (CleoAI) {
    if (!CleoAI) {
      if (typing) typing.remove();
      renderAiBot('AI is still loading. Please try again in a moment.');
      return;
    }
    return CleoAI.ask(t, { isCreator: true, context: aiContext() }).then(function (r) {
      if (typing) typing.remove();
      renderAiBot((r && r.answer) || 'Sorry, I could not answer that.', fromVoice);
    });
  }).catch(function () {
    if (typing) typing.remove();
    renderAiBot('AI is having trouble right now. Please try again in a moment.');
  });
}
function aiVoiceDone() {
  var lb = $('#s-ai #lb');
  var t = lb ? lb.textContent : '';
  if (!t || t === 'Listening...' || /demo/i.test(t)) return;
  try { var vc = $('#s-ai .v'); if (vc) vc.classList.remove('v'); } catch (e) {}
  renderAiUser(t);
  var typing = renderAiTyping();
  cleoReady().then(function (CleoAI) {
    if (!CleoAI) { if (typing) typing.remove(); return; }
    return CleoAI.ask(t, { isCreator: true, context: aiContext() }).then(function (r) {
      if (typing) typing.remove();
      renderAiBot((r && r.answer) || 'Sorry, I could not answer that.', true);
    });
  }).catch(function () { if (typing) typing.remove(); });
}

/* ---------------- tools chat -> AI ---------------- */
function toolsChat() {
  var root = $('#s-tools');
  var ci = $('#ci', root), msgs = $('#msgs', root);
  var t = ci ? ci.value : '';
  if (!t || !t.trim()) return;
  ci.value = '';
  if (msgs) {
    var u = document.createElement('div');
    u.className = 'u';
    u.textContent = t.trim();
    msgs.appendChild(u); msgs.scrollTop = msgs.scrollHeight;
  }
  cleoReady().then(function (CleoAI) {
    if (!CleoAI) return;
    return CleoAI.ask(t, { isCreator: true, context: aiContext() }).then(function (r) {
      if (!msgs || !r || !r.answer) return;
      var a = document.createElement('div');
      a.className = 'glass a';
      a.textContent = r.answer;
      msgs.appendChild(a); msgs.scrollTop = msgs.scrollHeight;
    });
  }).catch(function () {});
}

/* ---------------- Cycle 12 Worker D: in-booking chat + portfolio ---------------- */

/* Item 11 — in-booking chat (creator side). booking_messages rules allow the
 * brand/creator of the booking to read + create messages. The overlay is
 * built inside the creator iframe; the booking template calls
 * window.CollancerChat.open(id, booking) via data-a="chat". */
var ccUnsub = null, ccBookingId = null, ccBooking = null;
function escHtml(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }).replace(/\n/g, '<br>');
}
function sendChatMessage(bookingId, text) {
  bookingId = String(bookingId || ''); text = String(text || '').slice(0, 2000).trim();
  if (!bookingId || !text || !uid) return Promise.reject(new Error('bad_message'));
  return DB.collection('booking_messages').add({
    bookingId: bookingId, text: text, senderType: 'creator', senderId: uid,
    createdAt: FB.serverStamp(),
  }).then(function () {
    // rule-safe chat metadata stamp on the booking
    DB.collection('bookings').doc(bookingId).update({ lastMessageAt: FB.serverStamp(), lastMessageFrom: 'creator' }).catch(function () {});
  });
}
function ccMsgHTML(m) {
  var mine = m.senderType === 'creator', t = String(m.text || ''), price = 0, isCounter = false;
  try { var o = JSON.parse(t); if (o && o.kind === 'counter_offer') { isCounter = true; price = Math.floor(+o.price || 0); } } catch (e) {}
  if (isCounter) {
    var pl = '\u20B9' + price.toLocaleString('en-IN');
    var inner = '<div style="font-size:14px;font-weight:800;color:#0e7490">' + (mine ? 'You countered' : 'Brand countered') + ': ' + pl + '</div>';
    if (!mine) inner += '<div style="margin-top:8px"><button type="button" class="black" data-cc="acceptCounter" style="width:100%;height:42px;border-radius:21px;font-size:14px">Accept ' + pl + '</button></div><div class="hint" style="margin-top:6px">Accepting starts the booking \u2014 the brand then completes payment.</div>';
    else inner += '<div class="hint" style="margin-top:4px">Waiting for the brand to respond.</div>';
    return '<div class="cc-msg them" style="max-width:94%">' + inner + '</div>';
  }
  return '<div class="cc-msg ' + (mine ? 'me' : 'them') + '">' + (mine ? '' : '<small>Brand</small>') + escHtml(t) + '</div>';
}
function ccPaint(snap) {
  var box = document.getElementById('cc-msgs');
  if (!box) return;
  var arr = [];
  snap.forEach(function (doc) { var d = doc.data(); arr.push({ senderType: d.senderType || '', text: d.text || '', at: d.createdAt }); });
  arr.sort(function (a, b) {
    var ta = a.at && a.at.toMillis ? a.at.toMillis() : 0, tb = b.at && b.at.toMillis ? b.at.toMillis() : 0;
    return ta - tb;
  });
  box.innerHTML = arr.length ? arr.map(ccMsgHTML).join('') : '<div class="hint" style="text-align:center">No messages yet. Say hello to the brand.</div>';
  box.scrollTop = box.scrollHeight;
}
function closeChat() {
  var ov = document.getElementById('cc-chat');
  if (ov) ov.classList.remove('on');
  if (ccUnsub) { try { ccUnsub(); } catch (e) {} ccUnsub = null; }
  ccBookingId = null; ccBooking = null;
}
function openChat(bookingId, booking) {
  bookingId = String(bookingId || '');
  if (!bookingId || !uid) return;
  closeChat();
  ccBookingId = bookingId; ccBooking = booking || null;
  var root = document.getElementById('s-bookings');
  if (!root) return;
  var ov = document.getElementById('cc-chat');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'cc-chat';
    ov.innerHTML = '<div class="cc-dim" id="cc-dim"></div>' +
      '<div class="glass cc-box"><div class="cc-head">' +
      '<div class="glass circ" id="cc-back" role="button" aria-label="Back" style="width:42px;height:42px;flex:none"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#back"/></svg></div>' +
      '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="cc-title">Messages</div><div style="font-size:12px;color:#55616d">Chat with the brand</div></div></div>' +
      '<div class="cc-msgs" id="cc-msgs"></div>' +
      '<div class="cc-inrow"><div class="f ft" style="flex:1"><input id="cc-in" placeholder="Type a message..." maxlength="2000" autocomplete="off"></div>' +
      '<button type="button" class="black" id="cc-send" style="width:50px;height:50px;border-radius:50%;flex:none;padding:0" aria-label="Send"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" style="stroke:#fff;width:20px;height:20px"><use href="#send"/></svg></button></div></div>';
    var st = document.createElement('style');
    st.textContent = '#cc-chat{position:absolute;inset:0;z-index:60;display:none}#cc-chat.on{display:block}.cc-dim{position:absolute;inset:0;background:rgba(255,255,255,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}.cc-box{position:absolute;left:8px;right:8px;bottom:8px;top:64px;border-radius:36px;display:flex;flex-direction:column;overflow:hidden;padding:14px 16px 16px}.cc-box>*{position:relative;z-index:1}.cc-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}.cc-msgs{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:6px 2px}.cc-inrow{display:flex;gap:8px;align-items:center;margin-top:8px}.cc-msg{max-width:84%;padding:10px 14px;font-size:14.5px;line-height:1.4;word-break:break-word;position:relative;z-index:1}.cc-msg.me{align-self:flex-end;color:#fff;background:linear-gradient(180deg,#3a3d44 0,#16181c 46%,#000 100%);box-shadow:0 0 0 1px rgba(255,255,255,.5),0 8px 14px -8px rgba(0,0,0,.5);border-radius:20px 20px 6px 20px}.cc-msg.them{align-self:flex-start;background:rgba(255,255,255,.85);box-shadow:0 0 0 1px rgba(15,40,60,.1);border-radius:20px 20px 20px 6px}.cc-msg small{display:block;font-size:11px;opacity:.65;margin-bottom:2px}';
    document.head.appendChild(st);
    ov.querySelector('#cc-back').addEventListener('click', closeChat);
    ov.querySelector('#cc-dim').addEventListener('click', closeChat);
    var send = function () {
      var inp = document.getElementById('cc-in');
      if (!inp || !ccBookingId) return;
      var t = inp.value.trim();
      if (!t) return;
      inp.value = '';
      sendChatMessage(ccBookingId, t).catch(function () { toast('Message could not be sent.'); });
    };
    ov.querySelector('#cc-send').addEventListener('click', send);
    ov.querySelector('#cc-in').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    ov.querySelector('#cc-msgs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cc="acceptCounter"]');
      if (b) ccAcceptCounter();
    });
    root.appendChild(ov);
  }
  try {
    var ttl = document.getElementById('cc-title');
    if (ttl) ttl.textContent = (booking && booking.campaign) || 'Messages';
  } catch (e) {}
  ov.classList.add('on');
  var msgs = document.getElementById('cc-msgs');
  if (msgs) msgs.innerHTML = '<div class="hint" style="text-align:center">Loading messages\u2026</div>';
  ccUnsub = DB.collection('booking_messages').where('bookingId', '==', bookingId).limit(100).onSnapshot(ccPaint, function () {});
  var inp = document.getElementById('cc-in');
  if (inp) setTimeout(function () { try { inp.focus(); } catch (e) {} }, 250);
}
function ccAcceptCounter() {
  if (!ccBooking || !ccBooking.id) return;
  var ref = DB.collection('bookings').doc(String(ccBooking.id));
  ref.update({ status: 'Active', acceptedAt: FB.serverStamp(), acceptedByCreator: true, seenByCreator: true })
    .then(function () {
      try { sendChatMessage(ccBooking.id, 'Accepted.'); } catch (e) {}
      closeChat();
      toast('Booking accepted. The brand will complete payment.');
    })
    .catch(function () { toast('Could not update booking. Please try again.'); });
}
function sendCounter(bookingId, price) {
  price = Math.floor(Number(price) || 0);
  if (!(price >= 100)) { toast('Enter at least \u20B9100.'); return Promise.reject(new Error('bad_price')); }
  return sendChatMessage(bookingId, JSON.stringify({ kind: 'counter_offer', price: price }));
}
try {
  window.CollancerChat = { open: openChat, close: closeChat, send: sendChatMessage, sendCounter: sendCounter, acceptCounter: ccAcceptCounter };
} catch (e) {}

/* Item 12 — creator portfolio: pin up to 6 post URLs on
 * creators/{uid}.portfolioMediaIds (owner-writable per firestore.rules). */
function loadPortfolio() {
  if (!uid) return;
  DB.collection('creators').doc(uid).get().then(function (snap) {
    var d = (snap.exists && snap.data()) || {};
    var arr = Array.isArray(d.portfolioMediaIds)
      ? d.portfolioMediaIds.filter(function (u) { return typeof u === 'string' && u; }).slice(0, 6)
      : [];
    try {
      window.CollancerPortfolio = {
        list: arr,
        save: function (urls) {
          var clean = (Array.isArray(urls) ? urls : [])
            .filter(function (u) { return typeof u === 'string' && /^https?:\/\//i.test(u.trim()); })
            .map(function (u) { return u.trim().slice(0, 500); })
            .slice(0, 6);
          return DB.collection('creators').doc(uid).update({ portfolioMediaIds: clean }).then(function () {
            window.CollancerPortfolio.list = clean;
            try { if (typeof window.CollancerPortfolio.onChange === 'function') window.CollancerPortfolio.onChange(); } catch (e) {}
          });
        },
        onChange: null,
      };
      var f = window.__pfRender;
      if (typeof f === 'function') { window.CollancerPortfolio.onChange = f; f(); }
    } catch (e) {}
  }).catch(function () {});
}

/* ================= Item 26 (Cycle 21): pre-booking "Ask a question" (creator) =
 * Brands ask pre-booking questions from a creator's public profile view; the
 * threads land here in a "Questions from brands" inbox card at the top of the
 * Bookings screen (#cqq anchor in index.html — the creator's inbox area).
 * Doc shape: { creatorId, brandId, brandName, creatorHandle,
 *   messages: [{from:'brand'|'creator', text, at}], status:'open'|'closed',
 *   createdAt, updatedAt }. The thread overlay mirrors the in-booking chat
 * (#cc-chat) message patterns exactly. Fully separate from the booking state
 * machine — no booking is created or touched. */

var CQ_MAX_MSGS = 100; /* thread length cap — oldest messages are trimmed */
var cqInboxUnsub = null, cqThreadId = null, cqThreadUnsub = null, cqBusy = false;

function loadQuestionInbox() {
  if (!uid) return;
  if (cqInboxUnsub) { try { cqInboxUnsub(); } catch (e) {} cqInboxUnsub = null; }
  try {
    /* Single-field query (no composite index needed); sorted client-side. */
    cqInboxUnsub = DB.collection('prebooking_questions').where('creatorId', '==', uid)
      .onSnapshot(cqPaintInbox, function () {});
    trackUnsub(cqInboxUnsub); /* released on logout by teardown() */
  } catch (e) {}
}

function cqLastMsg(d) {
  var msgs = (d && Array.isArray(d.messages)) ? d.messages : [];
  return msgs.length ? msgs[msgs.length - 1] : null;
}

/* Inbox card: one row per thread with the brand name, last-message preview,
 * recency and open/closed state. Hidden when there are no threads. */
function cqPaintInbox(snap) {
  var box = document.getElementById('cqq');
  if (!box) return;
  var arr = [];
  snap.forEach(function (doc) { arr.push({ id: doc.id, d: doc.data() || {} }); });
  arr.sort(function (a, b) {
    var ta = a.d.updatedAt && a.d.updatedAt.toMillis ? a.d.updatedAt.toMillis() : 0;
    var tb = b.d.updatedAt && b.d.updatedAt.toMillis ? b.d.updatedAt.toMillis() : 0;
    return tb - ta;
  });
  if (!arr.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = '<div class="glass card" style="padding:14px 16px"><div style="display:flex;gap:10px;align-items:center">' +
    '<div class="t3 teal" style="width:40px;height:40px"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#send"/></svg></div>' +
    '<div style="flex:1;min-width:0"><div style="font-size:16px;font-weight:800">Questions from brands</div>' +
    '<div style="font-size:12.5px;color:#55616d">Pre-booking questions — reply fast to win the collab</div></div></div>' +
    '<div style="display:flex;flex-direction:column;margin-top:6px">' +
    arr.map(function (x) {
      var last = cqLastMsg(x.d), prev = last ? String(last.text || '') : '';
      if (prev.length > 80) prev = prev.slice(0, 80) + '…';
      var open = x.d.status !== 'closed';
      var ini = esc(String(x.d.brandName || 'B').trim().charAt(0).toUpperCase() || 'B');
      return '<div class="cq-row" data-cq="' + esc(x.id) + '" role="button" tabindex="0" style="display:flex;gap:10px;align-items:center;padding:10px 2px;border-top:1px solid rgba(15,40,60,.08);cursor:pointer">' +
        '<div class="t3 grn" style="width:38px;height:38px;flex:none;font-size:16px;font-weight:800;color:#fff">' + ini + '</div>' +
        '<div style="flex:1;min-width:0"><div style="font-size:14.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.d.brandName || 'Brand') + '</div>' +
        '<div style="font-size:12.5px;color:#55616d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (last ? esc((last.from === 'creator' ? 'You: ' : '') + prev) : 'No messages yet') + '</div></div>' +
        '<div style="text-align:right;flex:none"><div style="font-size:11.5px;color:#55616d">' + esc(agoStr(x.d.updatedAt)) + '</div>' +
        (open ? '<div style="font-size:11px;font-weight:800;color:#0e7490;margin-top:2px">OPEN</div>'
              : '<div style="font-size:11px;font-weight:700;color:#98a2ad;margin-top:2px">CLOSED</div>') + '</div></div>';
    }).join('') + '</div></div>';
}

/* Overlay CSS mirrors the in-booking chat (#cc-chat) exactly — same bubbles,
 * same glass sheet, same input row. Injected once, on first thread open. */
function cqEnsureCss() {
  if (document.getElementById('cq-css')) return;
  var st = document.createElement('style');
  st.id = 'cq-css';
  st.textContent = '#cq-chat{position:absolute;inset:0;z-index:60;display:none}' +
    '#cq-chat.on{display:block}' +
    '.cq-dim{position:absolute;inset:0;background:rgba(255,255,255,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}' +
    '.cq-box{position:absolute;left:8px;right:8px;bottom:8px;top:64px;border-radius:36px;display:flex;flex-direction:column;overflow:hidden;padding:14px 16px 16px}' +
    '.cq-box>*{position:relative;z-index:1}' +
    '.cq-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}' +
    '.cq-msgs{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:6px 2px}' +
    '.cq-inrow{display:flex;gap:8px;align-items:center;margin-top:8px}' +
    '.cq-msg{max-width:84%;padding:10px 14px;font-size:14.5px;line-height:1.4;word-break:break-word;position:relative;z-index:1}' +
    '.cq-msg.me{align-self:flex-end;color:#fff;background:linear-gradient(180deg,#3a3d44 0,#16181c 46%,#000 100%);box-shadow:0 0 0 1px rgba(255,255,255,.5),0 8px 14px -8px rgba(0,0,0,.5);border-radius:20px 20px 6px 20px}' +
    '.cq-msg.them{align-self:flex-start;background:rgba(255,255,255,.85);box-shadow:0 0 0 1px rgba(15,40,60,.1);border-radius:20px 20px 20px 6px}' +
    '.cq-msg small{display:block;font-size:11px;opacity:.65;margin-bottom:2px}';
  document.head.appendChild(st);
}

/* Message bubbles mirror the in-booking chat (ccMsgHTML): own = black 3D,
 * brand = glass with the brand name label. */
function cqMsgHTML(m, brandName) {
  var mine = m.from === 'creator';
  return '<div class="cq-msg ' + (mine ? 'me' : 'them') + '">' +
    (mine ? '' : '<small>' + esc(brandName || 'Brand') + '</small>') + escHtml(m.text) + '</div>';
}

function cqPaintThread(snap) {
  var box = document.getElementById('cq-msgs');
  if (!box) return;
  var d = (snap && snap.exists) ? (snap.data() || {}) : null;
  if (!d) { box.innerHTML = '<div class="hint" style="text-align:center">This thread is no longer available.</div>'; return; }
  var arr = Array.isArray(d.messages) ? d.messages.slice() : [];
  arr.sort(function (a, b) {
    var ta = a.at && a.at.toMillis ? a.at.toMillis() : 0;
    var tb = b.at && b.at.toMillis ? b.at.toMillis() : 0;
    return ta - tb;
  });
  box.innerHTML = arr.length ? arr.map(function (m) { return cqMsgHTML(m, d.brandName); }).join('')
    : '<div class="hint" style="text-align:center">No messages yet.</div>';
  box.scrollTop = box.scrollHeight;
  var closed = d.status === 'closed';
  var ttl = document.getElementById('cq-title');
  if (ttl) ttl.textContent = d.brandName || 'Brand';
  var inp = document.getElementById('cq-in');
  if (inp) inp.disabled = closed;
  var sendb = document.getElementById('cq-send');
  if (sendb) sendb.style.opacity = closed ? '.45' : '1';
  var cb = document.getElementById('cq-close');
  if (cb) cb.style.display = closed ? 'none' : '';
}

function cqCloseThread() {
  var ov = document.getElementById('cq-chat');
  if (ov) ov.classList.remove('on');
  if (cqThreadUnsub) { try { cqThreadUnsub(); } catch (e) {} cqThreadUnsub = null; }
  cqThreadId = null; cqBusy = false;
}

function cqOpenThread(threadId) {
  if (!uid || !threadId) return;
  cqCloseThread();
  cqEnsureCss();
  cqThreadId = String(threadId);
  var root = document.getElementById('s-bookings');
  if (!root) return;
  var ov = document.getElementById('cq-chat');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'cq-chat';
    ov.innerHTML = '<div class="cq-dim" id="cq-dim"></div>' +
      '<div class="glass cq-box"><div class="cq-head">' +
      '<div class="glass circ" id="cq-back" role="button" aria-label="Back" style="width:42px;height:42px;flex:none"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#back"/></svg></div>' +
      '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="cq-title">Questions</div>' +
      '<div style="font-size:12px;color:#55616d">Pre-booking question thread</div></div></div>' +
      '<div class="cq-msgs" id="cq-msgs"></div>' +
      '<div class="cq-inrow"><div class="f ft" style="flex:1"><input id="cq-in" placeholder="Type your reply..." maxlength="2000" autocomplete="off"></div>' +
      '<button type="button" class="black" id="cq-send" style="width:50px;height:50px;border-radius:50%;flex:none;padding:0" aria-label="Send"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" style="stroke:#fff;width:20px;height:20px"><use href="#send"/></svg></button></div>' +
      '<button type="button" class="tag glass" id="cq-close" style="width:100%;height:44px;border-radius:22px;justify-content:center;font-size:14px;font-weight:700;border:0;margin-top:10px">Mark resolved</button></div>';
    root.appendChild(ov);
    var send = function () {
      var inp = document.getElementById('cq-in');
      if (!inp || inp.disabled || !cqThreadId || cqBusy) return;
      var t = inp.value.trim();
      if (!t) return;
      inp.value = '';
      cqBusy = true;
      cqAppend(cqThreadId, t).then(function () { cqBusy = false; },
        function () { cqBusy = false; toast('Message could not be sent.'); });
    };
    ov.querySelector('#cq-back').addEventListener('click', cqCloseThread);
    ov.querySelector('#cq-dim').addEventListener('click', cqCloseThread);
    ov.querySelector('#cq-send').addEventListener('click', send);
    ov.querySelector('#cq-in').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    ov.querySelector('#cq-close').addEventListener('click', function () {
      if (!cqThreadId) return;
      DB.collection('prebooking_questions').doc(cqThreadId)
        .update({ status: 'closed', updatedAt: FB.serverStamp() })
        .then(function () { toast('Thread marked resolved.'); })
        .catch(function () { toast('Could not update the thread.'); });
    });
  }
  ov.classList.add('on');
  var msgs = document.getElementById('cq-msgs');
  if (msgs) msgs.innerHTML = '<div class="hint" style="text-align:center">Loading messages…</div>';
  if (cqThreadUnsub) { try { cqThreadUnsub(); } catch (e) {} }
  cqThreadUnsub = DB.collection('prebooking_questions').doc(cqThreadId)
    .onSnapshot(cqPaintThread, function () {});
  var inp = document.getElementById('cq-in');
  if (inp) setTimeout(function () { try { inp.focus(); } catch (e) {} }, 250);
}

/* Append-only reply write via transaction; trims the array to CQ_MAX_MSGS. */
function cqAppend(threadId, text) {
  text = String(text || '').slice(0, 2000).trim();
  if (!text || !uid) return Promise.reject(new Error('bad_message'));
  var ref = DB.collection('prebooking_questions').doc(String(threadId));
  return DB.runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      if (!snap.exists) throw new Error('cq_gone');
      var d = snap.data() || {};
      if (d.status === 'closed') throw new Error('cq_closed');
      if (String(d.creatorId) !== String(uid)) throw new Error('cq_denied');
      var msgs = Array.isArray(d.messages) ? d.messages.slice() : [];
      msgs.push({ from: 'creator', text: text, at: FB.serverStamp() });
      if (msgs.length > CQ_MAX_MSGS) msgs = msgs.slice(-CQ_MAX_MSGS);
      tx.update(ref, { messages: msgs, updatedAt: FB.serverStamp() });
    });
  });
}

/* Inbox row taps (delegated — rows are rendered dynamically by cqPaintInbox). */
document.addEventListener('click', function (e) {
  var r = e.target && e.target.closest ? e.target.closest('.cq-row') : null;
  if (r && r.dataset.cq) cqOpenThread(r.dataset.cq);
});
document.addEventListener('keydown', function (e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest) {
    var r = e.target.closest('.cq-row');
    if (r && r.dataset.cq) { e.preventDefault(); cqOpenThread(r.dataset.cq); }
  }
});

})();
