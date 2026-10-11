/* shell-connect.js — parent-page connectivity for gocolllancer (design untouched).
 *
 * Handles the Instagram OAuth return: the server redirects to /?ig=<reason>
 * after token exchange + sync. This opens the creator app and shows the result.
 */
(function () {
  'use strict';
  function toast(m) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = m;
    t.classList.add('on');
    setTimeout(function () { t.classList.remove('on'); }, 2600);
  }
  function openCreator() {
    var btn = document.querySelector('.role[data-role="creator"]');
    var go = document.getElementById('go');
    try { if (btn) btn.click(); } catch (e) {}
    try { if (go && !go.disabled) go.click(); } catch (e) {}
  }
  var m = /[?&]ig=([^&]+)/.exec(location.search || '');
  if (!m) return;
  var reason = '';
  try { reason = decodeURIComponent(m[1]); } catch (e) { reason = m[1]; }
  try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
  openCreator();
  var msg = 'Instagram connected successfully.';
  if (reason && reason !== 'ok') {
    msg = 'Instagram connect finished: ' + reason.replace(/[-_]/g, ' ') + '.';
  }
  setTimeout(function () { toast(msg); }, 900);
})();
