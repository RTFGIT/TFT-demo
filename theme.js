/**
 * theme.js — picks the visual direction before first paint.
 *
 * A CLASSIC script (not a module) loaded in <head>, so data-theme is set before
 * the page renders — no flash of the wrong look. Order of precedence:
 *   ?theme=matchday|grow|fresh|brand   (remembered)   → localStorage → default
 *
 * Same-origin pages follow each other through the `storage` event, so switching
 * the direction on the facilitator page also restyles the embedded widget.
 * Demo-only: once a direction is chosen this becomes a single fixed theme.
 */
(function () {
  var THEMES = {
    matchday: { label: 'A · Matchday',      fonts: 'family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700' },
    grow:     { label: 'B · Grow Together', fonts: 'family=Nunito:wght@400;600;700;800;900' },
    fresh:    { label: 'C · Fresh',         fonts: 'family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700' },
    // Stand-ins for the design sheet's Norwester + Indivisible (not on Google Fonts).
    brand:    { label: 'D · Try for Tomorrow', fonts: 'family=Bebas+Neue&family=Plus+Jakarta+Sans:ital,wght@0,300;0,400;0,600;0,700;0,800;1,300;1,600' }
  };
  var KEY = 'tft26_theme', DEFAULT = 'matchday';

  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function remember(n) { try { localStorage.setItem(KEY, n); } catch (e) {} }

  function resolve() {
    var q = new URLSearchParams(location.search).get('theme');
    if (q && THEMES[q]) { remember(q); return q; }
    var s = stored();
    return s && THEMES[s] ? s : DEFAULT;
  }

  function apply(name) {
    document.documentElement.setAttribute('data-theme', name);
    var href = 'https://fonts.googleapis.com/css2?' + THEMES[name].fonts + '&display=swap';
    var link = document.getElementById('tft-fonts');
    if (!link) {
      link = document.createElement('link');
      link.id = 'tft-fonts'; link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.href !== href) link.href = href;
  }

  var current = resolve();
  apply(current);

  function changed(n) {
    current = n; apply(n);
    window.dispatchEvent(new CustomEvent('tft-theme', { detail: n }));
  }

  window.TFTTheme = {
    themes: THEMES,
    get current() { return current; },
    set: function (n) { if (THEMES[n] && n !== current) { remember(n); changed(n); } }
  };

  window.addEventListener('storage', function (e) {
    if (e.key === KEY && e.newValue && THEMES[e.newValue] && e.newValue !== current) changed(e.newValue);
  });

  // Any element with data-theme-switch becomes an A / B / C picker.
  function paintSwitches() {
    var els = document.querySelectorAll('[data-theme-switch]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.dataset.built) {
        el.dataset.built = '1';
        el.classList.add('theme-switch');
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', 'Visual direction');
        Object.keys(THEMES).forEach(function (k) {
          var b = document.createElement('button');
          b.type = 'button'; b.dataset.theme = k;
          b.textContent = el.dataset.themeSwitch === 'long' ? THEMES[k].label : THEMES[k].label.charAt(0);
          b.title = 'Direction ' + THEMES[k].label;
          b.addEventListener('click', function () { window.TFTTheme.set(this.dataset.theme); });
          el.appendChild(b);
        });
      }
      var bs = el.querySelectorAll('button');
      for (var j = 0; j < bs.length; j++) bs[j].setAttribute('aria-pressed', bs[j].dataset.theme === current ? 'true' : 'false');
    }
  }
  window.TFTTheme.paintSwitches = paintSwitches;
  document.addEventListener('DOMContentLoaded', paintSwitches);
  window.addEventListener('tft-theme', paintSwitches);
})();
