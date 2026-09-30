/**
 * embed-frame.js — lets any page of the tool sit inside an iframe on another
 * site (rethinkfood.co.uk on WordPress, the Wix test site, …).
 *
 * When the page is framed by a DIFFERENT site (or opened with ?embed=1) it:
 *   - marks <html class="tft-embed"> so pages can adapt (e.g. hide "Demo home"
 *     links — anything with data-embed-hide);
 *   - tells the host page its height whenever it changes   { type: 'TFT_EMBED_HEIGHT', height }
 *   - and which screen it's on, so the host can keep it in its own address
 *     (refresh / back / bookmarks)                            { type: 'TFT_EMBED_ROUTE', route }
 * The host side of this is tft-embed.js. A bare iframe (e.g. Wix's HTML embed)
 * still works — it just won't resize itself.
 *
 * Inside one of the tool's OWN pages (the widget frame in the facilitator
 * portal, same origin) it does nothing: that's internal, not an embed.
 * A CLASSIC script, loaded in <head>.
 */
(function () {
  const framed = window.top !== window;
  let internal = false;
  if (framed) {
    try { internal = !!window.parent.document && window.parent.location.origin === location.origin; }
    catch { internal = false; }                     // cross-origin parent → a real embed
  }
  const forced = new URLSearchParams(location.search).get('embed') === '1';
  if (!(framed && !internal) && !forced) return;

  const html = document.documentElement;
  html.classList.add('tft-embed');
  const style = document.createElement('style');
  style.textContent = `
    html.tft-embed [data-embed-hide] { display: none !important; }
    /* Full-viewport layouts would grow forever in an auto-height frame. */
    html.tft-embed .ws, html.tft-embed body:has(> .worksheet) { min-height: 0 !important; }
  `;
  document.head.appendChild(style);

  if (!framed) return;                              // ?embed=1 on its own: styling only
  const post = (msg) => { try { window.parent.postMessage(msg, '*'); } catch {} };

  // Height: the page's full height, reported when it changes (not every frame).
  let last = 0, queued = false;
  function sendHeight() {
    queued = false;
    // The body's own height (+ its margins) — not the document's, which can
    // never be smaller than the frame and so would only ever grow.
    const b = document.body;
    if (!b) return;
    const cs = getComputedStyle(b);
    const h = Math.ceil(b.scrollHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom));
    if (Math.abs(h - last) > 2) { last = h; post({ type: 'TFT_EMBED_HEIGHT', height: h }); }
  }
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(sendHeight); } };

  // Route: path + hash, relative to the site, e.g. "facilitator/index.html#/dashboard".
  function sendRoute() {
    post({ type: 'TFT_EMBED_ROUTE', route: location.pathname.split('/').pop() + location.hash, hash: location.hash });
  }

  function start() {
    new ResizeObserver(queue).observe(document.documentElement);
    if (document.body) new ResizeObserver(queue).observe(document.body);
    new MutationObserver(queue).observe(document.body || document.documentElement, { childList: true, subtree: true });
    window.addEventListener('load', queue);
    window.addEventListener('hashchange', () => { sendRoute(); queue(); });
    sendRoute();
    queue();
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();
