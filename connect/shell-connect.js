/* shell-connect.js — parent-page connectivity for gocolllancer (design untouched).
 *
 * Handles the Instagram OAuth return: the server redirects to /?ig=<reason>
 * after token exchange + sync. This opens the creator app and passes the
 * result via sessionStorage so the creator app can show its own toast.
 */
(function () {
  'use strict';
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
  /* Pass the result to the creator app via sessionStorage (shared with iframe).
   * The creator app reads and clears this on init, showing its own toast. */
  try { sessionStorage.setItem('collancer_ig_result', reason); } catch (e) {}
  openCreator();
})();
