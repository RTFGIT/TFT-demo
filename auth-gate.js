/**
 * auth-gate.js — the real sign-in in front of the whole demo site.
 *
 * Everyone who opens the demo signs in with their OWN account (created for them
 * on the rtf-tft Firebase project — see scripts/live/users.mjs). Only accounts
 * marked `demo: true` (invited guests) or `admin: true` (genuine RTF admins) get
 * in. Once in, the black bar at the very top shows who is really signed in; the
 * green bar below it is the demo's own world, where the facilitator and admin
 * logins (Alex, Sam, the demo admin) are only personas.
 *
 * What this protects: every page is covered until a real sign-in, and — the part
 * that actually matters — the Live database only accepts real accounts (see
 * firestore.rules, "Shared demo access"). What it cannot do: GitHub Pages serves
 * files publicly, so the page files themselves can still be fetched directly.
 *
 * A CLASSIC script, loaded in <head> so the page is hidden before first paint.
 * It stands down only inside one of OUR OWN gated pages (the widget frame in
 * the portal). Embedded anywhere else — a WordPress or Wix page, any other
 * site — it gates as normal, so an embed can never be a way round it.
 */
(function () {
  if (window.top !== window) {
    let insideGatedPage = false;
    try {                                   // throws for a cross-origin parent
      const p = window.parent.document.documentElement.classList;
      insideGatedPage = p.contains('tft-in') || p.contains('tft-gated');
    } catch { insideGatedPage = false; }
    if (insideGatedPage) return;
  }

  const ROOT = new URL('./', document.currentScript.src);   // the site root
  const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
  const PERSONA_KEYS = ['tft26_wp_session_v1', 'tft26_admin_persona_v1', 'tft26_active_run_v1'];
  // Running the source on this computer (localhost) in Sandbox: no real sign-in.
  // Sandbox never touches the real database, so there's nothing to protect, and
  // it lets the team try the tool before accounts exist. Never applies to the
  // published site (a different host) or to Live mode (which needs a real account).
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    let mode = null;
    try {
      const qs = new URLSearchParams(location.search);
      mode = qs.get('mode_once') || qs.get('mode') || localStorage.getItem('tft26_mode');
    } catch {}
    if (mode !== 'live') return;
  }

  const html = document.documentElement;
  html.classList.add('tft-gated');

  const style = document.createElement('style');
  style.textContent = `
    html.tft-gated body > *:not(#tft-gate) { visibility: hidden !important; }
    #tft-gate { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center;
      background: #111; color: #f3f3f0; font-family: system-ui, 'Segoe UI', sans-serif; padding: 1rem; }
    #tft-gate form { width: min(380px, 100%); background: #1b1b1b; border: 1px solid #2c2c2c;
      border-radius: 10px; padding: 1.6rem 1.5rem 1.3rem; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
    #tft-gate .brand { font-size: .72rem; letter-spacing: .14em; text-transform: uppercase; color: #9a9a92; font-weight: 700; }
    #tft-gate h1 { font-size: 1.45rem; margin: .2rem 0 .3rem; font-weight: 700; }
    #tft-gate p { font-size: .85rem; color: #b8b8b0; margin: 0 0 1rem; line-height: 1.45; }
    #tft-gate label { display: block; font-size: .8rem; font-weight: 600; margin-bottom: .75rem; color: #d8d8d0; }
    #tft-gate input { display: block; width: 100%; box-sizing: border-box; margin-top: .3rem; padding: .62rem .7rem;
      border-radius: 6px; border: 1px solid #3a3a3a; background: #111; color: #fff; font: inherit; font-size: .95rem; }
    #tft-gate input:focus { outline: 2px solid #8ab4f8; outline-offset: 1px; }
    #tft-gate button { font: inherit; cursor: pointer; }
    #tft-gate .go { width: 100%; padding: .7rem; border: 0; border-radius: 6px; background: #f3f3f0; color: #111;
      font-weight: 700; font-size: .95rem; margin-top: .2rem; }
    #tft-gate .go:disabled { opacity: .5; cursor: default; }
    #tft-gate .link { background: none; border: 0; color: #9ab8f0; padding: .6rem 0 0; font-size: .82rem; }
    #tft-gate .msg { min-height: 1.1em; margin: .7rem 0 0; font-size: .84rem; color: #f0b3a8; }
    #tft-gate .msg.ok { color: #a8e0b4; }
    #tft-gate .foot { margin: 1rem 0 0; font-size: .75rem; color: #7d7d76; }
    #tft-gate .wait { font-size: .9rem; color: #9a9a92; }

    #tft-access { position: fixed; top: 0; left: 0; right: 0; height: 32px; z-index: 2147482000;
      background: #000; color: #d6d6d0; display: flex; align-items: center; gap: .7rem; padding: 0 1rem;
      font: 600 .75rem/1 system-ui, 'Segoe UI', sans-serif; }
    #tft-access .lbl { text-transform: uppercase; letter-spacing: .12em; color: #8a8a84; font-size: .66rem; }
    #tft-access .who { color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #tft-access .role { font-size: .64rem; padding: .15rem .45rem; border-radius: 99px; background: #2b2b2b; color: #e0e0d8; }
    #tft-access .role.admin { background: #f3f3f0; color: #000; }
    #tft-access .sp { flex: 1; }
    #tft-access button { background: none; border: 1px solid #3a3a3a; color: #fff; border-radius: 5px;
      padding: .2rem .6rem; font: inherit; cursor: pointer; }
    #tft-access button:hover { border-color: #888; }
    @media (max-width: 520px) { #tft-access .lbl { display: none; } }

    /* Make room for the black bar above everything the page already has. */
    html.tft-in body { margin-top: 32px !important; }
    html.tft-in .wp-bar, html.tft-in .admin-bar { top: 32px !important; }
    html.tft-in .ws-bar { top: 32px !important; }
    html.tft-in .part-nav { top: calc(2.9rem + 32px) !important; }
    html.tft-in .roster-panel { top: calc(3.6rem + 32px) !important; }
  `;
  document.head.appendChild(style);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ready = new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r());

  async function gateEl() {
    await ready;
    let el = document.getElementById('tft-gate');
    if (!el) { el = document.createElement('div'); el.id = 'tft-gate'; document.body.prepend(el); }
    return el;
  }
  async function showWait(text) {
    (await gateEl()).innerHTML = `<div class="wait">${esc(text)}</div>`;
  }

  async function showLogin(api, message) {
    const el = await gateEl();
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <form novalidate aria-labelledby="tft-gate-t">
        <div class="brand">Try for Tomorrow</div>
        <h1 id="tft-gate-t">Demo access</h1>
        <p>Sign in with the account you were invited with.</p>
        <label>Email<input type="email" name="email" autocomplete="username" required></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <button class="go" type="submit">Sign in</button>
        <button class="link" type="button" data-forgot>Forgot your password?</button>
        <p class="msg" role="status">${esc(message || '')}</p>
        <p class="foot">Access is by invitation from Rethink Food.</p>
      </form>`;
    const form = el.querySelector('form');
    const msg = el.querySelector('.msg');
    const go = el.querySelector('.go');
    form.email.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg'; msg.textContent = '';
      go.disabled = true; go.textContent = 'Signing in…';
      try {
        await api.authM.signInWithEmailAndPassword(api.auth, form.email.value.trim(), form.password.value);
        // onAuthStateChanged takes it from here.
      } catch (err) {
        go.disabled = false; go.textContent = 'Sign in';
        msg.textContent = /too-many-requests/.test(err.code) ? 'Too many attempts. Try again in a few minutes.'
                        : /network/.test(err.code) ? 'Can’t reach the sign-in service. Check the connection.'
                        : 'That email and password don’t match an invited account.';
      }
    });
    el.querySelector('[data-forgot]').addEventListener('click', async () => {
      const email = form.email.value.trim();
      msg.className = 'msg';
      if (!email) { msg.textContent = 'Enter your email above first.'; form.email.focus(); return; }
      try { await api.authM.sendPasswordResetEmail(api.auth, email); } catch (err) { /* same reply either way */ }
      msg.className = 'msg ok';
      msg.textContent = 'If that address has an account, a link to set a new password is on its way.';
    });
  }

  async function unlock(api, user, claims) {
    await ready;
    document.getElementById('tft-gate')?.remove();
    const bar = document.createElement('div');
    bar.id = 'tft-access';
    const admin = claims.admin === true;
    bar.innerHTML = `
      <span class="lbl">Demo access</span>
      <span class="who" title="${esc(user.email)}">${esc(user.displayName || user.email)}</span>
      <span class="role ${admin ? 'admin' : ''}">${admin ? 'Admin' : 'Guest'}</span>
      <span class="sp"></span>
      <button type="button">Sign out</button>`;
    bar.querySelector('button').addEventListener('click', async () => {
      // Signing out of the real account also ends any demo persona on this device.
      PERSONA_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      await api.authM.signOut(api.auth);
    });
    document.body.prepend(bar);
    html.classList.add('tft-in');
    html.classList.remove('tft-gated');
    window.TFT_ACCESS = { email: user.email, name: user.displayName || user.email, admin };
  }

  (async () => {
    showWait('Checking access…');
    let api;
    try {
      const { FIREBASE_CONFIG } = await import(new URL('firebase-config.js', ROOT).href);
      if (!FIREBASE_CONFIG) { showWait('Demo access isn’t set up on this copy of the site.'); return; }
      const [appM, authM] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]);
      const app = appM.getApps().length ? appM.getApp() : appM.initializeApp(FIREBASE_CONFIG);
      api = { authM, auth: authM.getAuth(app) };
    } catch (e) {
      console.error('[TFT] access check failed', e);
      showWait('Can’t reach the sign-in service. Check the connection and reload.');
      return;
    }

    let first = true;
    api.authM.onAuthStateChanged(api.auth, async (user) => {
      // A change after the first answer (signed in or out on this page):
      // reload so every part of the page starts again as the right person.
      if (!first) { location.reload(); return; }
      first = false;
      if (!user) {
        let note = '';
        try { note = sessionStorage.getItem('tft_gate_note') || ''; sessionStorage.removeItem('tft_gate_note'); } catch {}
        return showLogin(api, note);
      }
      const { claims } = await user.getIdTokenResult();
      if (claims.demo === true || claims.admin === true) return unlock(api, user, claims);
      try { sessionStorage.setItem('tft_gate_note', 'That account hasn’t been given access to the demo.'); } catch {}
      await api.authM.signOut(api.auth);          // reloads, then asks again
    });
  })();
})();
