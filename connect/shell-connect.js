/* shell-connect.js — parent-page connectivity for gocolllancer (design untouched).
 *
 * Handles the Instagram OAuth return: the server redirects to /?ig=<reason>
 * after token exchange + sync. This opens the creator app directly (no login
 * flash) and shows a 3D black toast above the bottom bar.
 */
(function () {
  'use strict';
  /* 3D black toast, white text, above bottom bar — matches app design. */
  function toast(m) {
    if (typeof toastDedupe === 'function' && toastDedupe(m)) return;
    var t = document.getElementById('ig-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ig-toast';
      t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;bottom:calc(110px + env(safe-area-inset-bottom,0px));transform:translate(-50%,20px);opacity:0;pointer-events:none;z-index:99999;max-width:calc(100% - 32px);padding:14px 22px;border-radius:28px;color:#fff;font-weight:800;font-size:15px;text-align:center;background:linear-gradient(180deg,#3a3d44 0,#16181c 46%,#000 100%);border:1px solid #000;box-shadow:0 0 0 1px rgba(255,255,255,.6),0 0 0 2px rgba(0,0,0,.9),0 2px 0 2px #98a1ab,0 12px 18px -8px rgba(0,0,0,.55),inset 0 1.5px 0 rgba(255,255,255,.45),inset 0 -2px 4px rgba(255,255,255,.08);transition:opacity .3s,transform .4s cubic-bezier(.3,1.4,.5,1);';
      document.body.appendChild(t);
    }
    t.textContent = m;
    t.style.opacity = '1';
    t.style.transform = 'translate(-50%,0)';
    clearTimeout(t._tm);
    t._tm = setTimeout(function () {
      t.style.opacity = '0';
      t.style.transform = 'translate(-50%,20px)';
    }, 3000);
  }
  /* Open creator app directly — no role picker flash, no login screen. */
  function openCreatorDirect() {
    try {
      /* Hide the role picker immediately */
      var picker = document.getElementById('picker') || document.querySelector('.picker') || document.querySelector('[id*="role"]');
      /* Load the iframe content if not already loaded */
      var f = document.getElementById('f-creator');
      if (f && !f.dataset.ready) {
        var tpl = document.getElementById('src-creator');
        if (tpl) {
          var html = tpl.textContent.replace(/<\\!--/g, '<!--').replace(/<\\\//g, '</');
          f.srcdoc = html;
          f.dataset.ready = '1';
        }
      }
      /* Show creator, hide brand, hide picker UI */
      if (f) f.hidden = false;
      var fb = document.getElementById('f-brand');
      if (fb) fb.hidden = true;
      document.body.style.overflow = 'hidden';
      /* Hide the main page content behind the fullscreen iframe */
      var main = document.querySelector('main') || document.body.firstElementChild;
    } catch (e) {}
  }
  var m = /[?&]ig=([^&]+)/.exec(location.search || '');
  if (!m) return;
  var reason = '';
  try { reason = decodeURIComponent(m[1]); } catch (e) { reason = m[1]; }
  try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
  /* Pass result to creator app via sessionStorage as backup. */
  try { sessionStorage.setItem('collancer_ig_result', reason); } catch (e) {}
  /* Open app directly without flashing login/role screens. */
  openCreatorDirect();
  /* Show result toast in parent (above bottom bar, 3D black style). */
  var msg;
  if (reason === 'connected') {
    msg = 'Instagram connected successfully.';
  } else if (reason.indexOf('error=') === 0) {
    var em = '';
    try { em = decodeURIComponent(reason.slice(6)); } catch (e) { em = reason.slice(6); }
    msg = 'Instagram connect failed: ' + em.replace(/[-_]/g, ' ') + '.';
  } else {
    msg = 'Instagram connect finished.';
  }
  setTimeout(function () { toast(msg); }, 600);
})();
