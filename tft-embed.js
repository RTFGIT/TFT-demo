/**
 * tft-embed.js — put a Try for Tomorrow tool on a WordPress (or other) page.
 *
 * On the WordPress page, in a Custom HTML block:
 *
 *   <div data-tft-tool="facilitator"></div>
 *   <script src="https://rtfgit.github.io/TFT-demo/tft-embed.js" async></script>
 *
 * Tools:   facilitator  the facilitator portal
 *          admin        the admin console
 *          widget       the pledge widget (with the animation test button)
 *          home         the demo home page
 *          guide        how the widget embeds
 * Options (data attributes on the div):
 *          data-tft-mode="live|sandbox"   which data the tool uses (default: the visitor's last choice)
 *          data-tft-height="900"          starting height in px before the tool reports its own
 *
 * The loader builds the iframe (full screen and sound allowed, for the projector
 * view and the kick), sizes it to the tool's content as it changes, and keeps
 * the tool's current screen in this page's address (?tft=…) so refresh, back
 * and bookmarks land in the same place. Several tools can share a page; only
 * the first one keeps its screen in the address.
 *
 * Without this script (e.g. Wix's HTML embed), a plain iframe to the same
 * address works too — give it a fixed height; it just won't resize itself.
 */
(function () {
  const SCRIPT = document.currentScript;
  const SITE = new URL('./', SCRIPT ? SCRIPT.src : location.href);
  const ORIGIN = SITE.origin;
  const TOOLS = {
    facilitator: 'facilitator/index.html',
    admin: 'admin_console/index.html',
    widget: 'widget-demo.html',
    home: 'index.html',
    guide: 'integration.html'
  };
  const PARAM = 'tft';

  function mount(el, keepInAddress) {
    if (el.dataset.tftMounted) return;
    el.dataset.tftMounted = '1';
    const tool = el.getAttribute('data-tft-tool') || 'facilitator';
    const path = TOOLS[tool];
    if (!path) { el.textContent = 'Unknown Try for Tomorrow tool: ' + tool; return; }

    // Resume the screen saved in this page's address (only if it's this tool's).
    const saved = keepInAddress ? new URLSearchParams(location.search).get(PARAM) : null;
    const hash = saved && saved.startsWith(path.split('/').pop() + '#') ? saved.slice(saved.indexOf('#')) : '';
    const src = new URL(path, SITE);
    src.searchParams.set('embed', '1');
    const mode = el.getAttribute('data-tft-mode');
    if (mode === 'live' || mode === 'sandbox') src.searchParams.set('mode', mode);
    src.hash = hash;

    const frame = document.createElement('iframe');
    frame.src = src.href;
    frame.title = 'Try for Tomorrow — ' + tool;
    frame.allow = 'fullscreen; autoplay; clipboard-write';
    frame.setAttribute('allowfullscreen', '');
    frame.loading = 'lazy';
    frame.style.cssText = 'display:block;width:100%;border:0;overflow:hidden;background:transparent;'
      + 'height:' + (parseInt(el.getAttribute('data-tft-height'), 10) || 900) + 'px';
    el.appendChild(frame);

    window.addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow || e.origin !== ORIGIN || !e.data) return;
      if (e.data.type === 'TFT_EMBED_HEIGHT' && e.data.height > 0) {
        frame.style.height = Math.max(320, e.data.height) + 'px';
      } else if (e.data.type === 'TFT_EMBED_ROUTE') {
        if (keepInAddress) {
          const url = new URL(location.href);
          e.data.hash && e.data.hash !== '#' ? url.searchParams.set(PARAM, e.data.route) : url.searchParams.delete(PARAM);
          history.replaceState(history.state, '', url);
        }
        // A new screen inside the tool: bring its top into view.
        const top = frame.getBoundingClientRect().top;
        if (top < 0) window.scrollBy({ top: top - 16, behavior: 'smooth' });
      }
    });
  }

  function mountAll() {
    document.querySelectorAll('[data-tft-tool]').forEach((el, i) => mount(el, i === 0));
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mountAll) : mountAll();
})();
