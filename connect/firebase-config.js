/* Firebase init for gocolllancer — compat SDK (no build step), project collancer-8fd62.
 * Mirrors collancerlatest src/lib/firebase.js: auth + firestore only.
 * Exposes window.FB = { auth, db, user(), onAuth(), idToken(), api(), ... }.
 * NOTE: the apiKey below is the public Firebase web key (public by design).
 */
(function () {
  if (window.FB) return;
  var cfg = {
  apiKey: 'AIzaSyCfjNkaC2pAePgroS-ginbOy_wRsS2sNw8',
  authDomain: 'collancer-8fd62.firebaseapp.com',
  projectId: 'collancer-8fd62',
  storageBucket: 'collancer-8fd62.firebasestorage.app',
  messagingSenderId: '154521281878',
  appId: '1:154521281878:web:ae6439817888eedd6ce2f7',
  /* INSIGHT-1 (Cycle 17): Firebase Analytics measurement ID.
   * Get this from Firebase console > Project settings > Your apps > Web app.
   * Format: 'G-XXXXXXXXXX'. Leave as null to keep analytics disabled. */
  measurementId: null,
};
  firebase.initializeApp(cfg);
  var auth = firebase.auth();
  var db = firebase.firestore();

  /* Initialize Firebase Analytics if measurementId is configured.
   * Fail-safe: analytics is best-effort, never blocks app init. */
  var analyticsReady = false;
  try {
    if (cfg.measurementId && typeof cfg.measurementId === 'string' &&
        cfg.measurementId.indexOf('G-') === 0 && typeof firebase.analytics === 'function') {
      firebase.analytics();
      analyticsReady = true;
      window._analyticsReady = true;
    }
  } catch (e) { /* analytics unavailable — track() will no-op */ }

  function currentUser() { return auth.currentUser || null; }
  function onAuth(cb) { return auth.onAuthStateChanged(cb); }
  async function idToken(force) {
    var u = currentUser();
    if (!u) throw new Error('not-signed-in');
    return await u.getIdToken(!!force);
  }
  /* POST to same-origin serverless API with the Firebase ID token. */
  async function api(path, body) {
    var tok = await idToken().catch(function () { return null; });
    var res = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ idToken: tok }, body || {})),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || data.message || ('api-' + res.status));
    return data;
  }
  function normPhone(p) {
    p = String(p || '').replace(/[^\d]/g, '');
    if (/^[6-9]\d{9}$/.test(p)) return '+91' + p;
    if (/^91[6-9]\d{9}$/.test(p)) return '+' + p;
    return null;
  }

  window.FB = {
    auth: auth, db: db,
    user: currentUser, onAuth: onAuth, idToken: idToken, api: api,
    analyticsReady: function () { return analyticsReady; },
    registerEmail: function (email, pw) { return auth.createUserWithEmailAndPassword(email, pw); },
    loginEmail: function (email, pw) { return auth.signInWithEmailAndPassword(email, pw); },
    loginGoogle: function () {
      var provider = new firebase.auth.GoogleAuthProvider();
      return auth.signInWithPopup(provider).catch(function () { return auth.signInWithRedirect(provider); });
    },
    logout: function () {
      try { localStorage.removeItem('collancer_role'); } catch (e) {}
      return auth.signOut();
    },
    normPhone: normPhone,
    /* Phone OTP (invisible reCAPTCHA). Container element id for the verifier. */
    startPhoneOtp: function (phone, containerId) {
      var to = normPhone(phone);
      if (!to) return Promise.reject(new Error('invalid-phone'));
      if (!window._recaptchaVerifier) {
        window._recaptchaVerifier = new firebase.auth.RecaptchaVerifier(containerId, { size: 'invisible' });
      }
      return auth.signInWithPhoneNumber(to, window._recaptchaVerifier);
    },
    serverStamp: function () { return firebase.firestore.FieldValue.serverTimestamp(); },
  };
})();
