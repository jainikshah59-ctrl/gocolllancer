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
function inr(n) { return '\u20B9' + Number(n || 0).toLocaleString('en-IN'); }
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
    if (!u) { teardown(); try { Collancer.go('login'); } catch (e) {} return; }
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
      return ref.set({
        name: prettyName(local), phone: '', email: email,
        handle: handle, handleLower: handle.toLowerCase(),
        pfp: '', bio: '', niche: '', city: '', platform: 'Instagram',
        prices: {}, followers: 0, engagement: 0,
        verified: false, addedToCollancer: false, banned: false,
        verificationStatus: 'none', rating: 0, profileComplete: false,
        createdAt: FB.serverStamp(),
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
      if (reg) return ensureCreatorDoc(cred.user, email);
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
    if (q('#s-login #sb')) { e.stopPropagation(); e.preventDefault(); doEmailAuth(); return; }
    var sbtn = q('#s-login .sbtn');
    if (sbtn && !/phone/i.test(sbtn.textContent)) { e.stopPropagation(); e.preventDefault(); doGoogle(); return; }
    // Phone button: let the data-toast handler show "opens in the app" message
    if (q('#s-profile .black.red')) {
      e.stopPropagation(); e.preventDefault();
      FB.logout().then(function () { try { Collancer.go('login'); } catch (x) {} });
      return;
    }
    var igBtn = q('button.black');
    if (igBtn && /connect instagram/i.test(igBtn.textContent)) {
      e.stopPropagation(); e.preventDefault(); connectInstagram(); return;
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
    /* No package prices set -> nudge the creator once per session, and show
     * a persistent banner on the Rate card ("Your packages") section until
     * prices are set. Brands cannot book a creator with no prices. */
    var hasPrices = !!(d.prices && Object.keys(d.prices).length) || !!(d.packages && d.packages.length);
    if (!hasPrices) {
      if (!window._cconPriceNudge) {
        window._cconPriceNudge = true;
        setTimeout(function () { toast('Set your package prices to get bookings.'); }, 1200);
      }
      try {
        var h2s = root.querySelectorAll('h2'), pkgCard = null;
        h2s.forEach(function (h) { if (h.textContent.trim() === 'Your packages') pkgCard = h.closest('.glass.card'); });
        if (pkgCard && !pkgCard.querySelector('#ccon-price-banner')) {
          var banner = document.createElement('div');
          banner.id = 'ccon-price-banner';
          banner.setAttribute('role', 'note');
          banner.style.cssText = 'margin:10px 0 0;padding:12px 14px;border-radius:16px;background:#fff7e6;border:1px solid #f2c979;font-size:13.5px;font-weight:700;color:#8a5a00;line-height:1.45';
          banner.textContent = 'Set your package prices to get bookings. Brands see "Custom rates" on your profile until you do.';
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
}
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
    if (bizId) {
      DB.collection('bizNotifs').add({
        bizId: bizId, type: 'work_delivered',
        title: 'Work delivered',
        body: (creatorDoc && creatorDoc.name ? creatorDoc.name : 'Creator') + ' delivered the work for your review.',
        bookingId: String(bookingId), read: false, createdAt: FB.serverStamp(),
      }).catch(function () {});
    }
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
        ref.update(patch).then(notifyBiz).catch(function () { toast('Could not update booking. Please try again.'); });
        return;
      }
      // Item 13: accepting a custom offer uses the same rule-safe
      // Pending -> Active shape as a normal accept; the agreed price is the
      // booking's offerPrice. The brand collects payment via collancerPayOffer.
      if (action === 'acceptOffer') {
        var opatch = { status: 'Active', acceptedAt: FB.serverStamp(), acceptedByCreator: true, seenByCreator: true };
        ref.update(opatch).then(function () {
          try { sendChatMessage(booking.id, 'Accepted your custom offer of \u20B9' + Number(booking.offerPrice || 0).toLocaleString('en-IN') + '.'); } catch (e) {}
          if (booking._bizId) {
            DB.collection('bizNotifs').add({
              bizId: booking._bizId, type: 'offer_accepted',
              title: 'Custom offer accepted',
              body: (creatorDoc && creatorDoc.name ? creatorDoc.name : 'Creator') + ' accepted your custom offer.',
              bookingId: booking.id, read: false, createdAt: FB.serverStamp(),
            }).catch(function () {});
          }
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
        if (booking._bizId) {
          DB.collection('bizNotifs').add({
            bizId: booking._bizId, type: action === 'accept' ? 'booking_accepted' : 'booking_rejected',
            title: action === 'accept' ? 'Booking accepted' : 'Booking declined',
            body: (creatorDoc && creatorDoc.name ? creatorDoc.name : 'Creator') +
              (action === 'accept' ? ' accepted your collaboration request.' : ' declined your collaboration request.'),
            bookingId: booking.id, read: false, createdAt: FB.serverStamp(),
          }).catch(function () {});
        }
      }
    };
  } catch (e) {}
}

/* ---------------- earnings ---------------- */
function paintEarnings() {
  var root = $('#s-earnings');
  if (!root) return;
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
      if (d.status === 'pending') pending += a;
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
    paintPayoutHistory();
  }).catch(function () {});
}
function paintPayoutHistory() {
  var root = $('#s-earnings');
  var pz = root && $('#pz', root);
  if (!pz) return;
  DB.collection('payoutRequests').where('creatorId', '==', uid).orderBy('createdAt', 'desc').limit(20).get()
    .then(function (snap) {
      if (snap.empty) return; // keep the designed empty state
      var html = snap.docs.map(function (doc) {
        var d = doc.data();
        var st = d.status === 'pending' ? 'Pending' : (d.status || '');
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
  return DB.collection('bookings').where('creatorId', '==', uid).get().then(function (snap) {
    var done = {};
    return DB.collection('payoutRequests').where('creatorId', '==', uid).get().then(function (ps) {
      ps.forEach(function (d) {
        var b = d.data() || {};
        if (b.bookingId) done[b.bookingId] = true;
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
        '<button class="black" data-pick="' + i + '" style="min-width:96px;height:42px;border-radius:21px">Request</button>' +
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
  erEl.textContent = 'Submitting payout request\u2026';
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
    paintEarnings();
  }).catch(function () { erEl.textContent = 'Could not submit. Please try again.'; });
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


})();
