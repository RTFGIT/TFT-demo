/**
 * confirm-dialog.js — the tool's own "Are you sure?" dialog, in place of the
 * browser's confirm(). It matches the portal, it's keyboard- and
 * screen-reader-friendly (a native modal <dialog>: Escape cancels, focus stays
 * inside), and it keeps working when the tool is embedded on another site,
 * where browsers may block confirm() inside a cross-origin iframe.
 *
 *   const choice = await askConfirm({
 *     title: 'Delete Group 2?',
 *     body:  'Its 12 students are removed from the roster.',     // text, or { html }
 *     confirm: 'Delete group',          // the main button's label
 *     danger: true,                     // red main button, for anything destructive
 *     alt: 'Move them to Group 1 instead'   // optional second choice
 *   });
 *   // → 'confirm' | 'alt' | null (cancelled)
 *
 * Colours come from the page's theme tokens (theme-tokens.css), with fallbacks.
 */
const STYLE = `
  /* margin:auto centres a modal dialog; page resets (* { margin:0 }) would pin it top-left. */
  dialog.tft-confirm { margin:auto; border:0; padding:0; border-radius:var(--radius, 12px); max-width:min(460px, calc(100vw - 32px));
    width:100%; background:var(--surface, #fff); color:var(--ink, #111); box-shadow:0 24px 60px rgba(0,0,0,.35); }
  dialog.tft-confirm::backdrop { background:rgba(10, 14, 20, .55); }
  .tft-confirm .tc-body { padding:1.3rem 1.4rem 1.1rem; }
  .tft-confirm h2 { font-size:1.2rem; line-height:1.25; margin:0 0 .5rem; font-weight:800; }
  .tft-confirm p { margin:0; font-size:.93rem; line-height:1.5; color:var(--muted, #555); }
  .tft-confirm .tc-acts { display:flex; flex-wrap:wrap; gap:.5rem; justify-content:flex-end; align-items:center;
    padding:.9rem 1.4rem 1.2rem; }
  /* The second choice sits on its own line under the main buttons. */
  .tft-confirm .tc-alt { order:3; flex-basis:100%; text-align:right; font-size:.86rem; padding:.35rem 0 0;
    background:none; border:0; text-decoration:underline; }
  .tft-confirm .btn.danger { background:var(--danger, #b42318); border-color:var(--danger, #b42318); color:#fff; }
  @media (max-width:480px){ .tft-confirm .tc-acts { flex-direction:column-reverse; align-items:stretch; }
    .tft-confirm .tc-alt { order:0; text-align:center; } }
`;

let dialog = null;
function ensure() {
  if (dialog) return dialog;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  dialog = document.createElement('dialog');
  dialog.className = 'tft-confirm';
  dialog.setAttribute('aria-labelledby', 'tc-title');
  dialog.setAttribute('aria-describedby', 'tc-text');
  dialog.innerHTML = `
    <div class="tc-body"><h2 id="tc-title"></h2><p id="tc-text"></p></div>
    <div class="tc-acts">
      <button type="button" class="btn ghost tc-alt" data-v="alt"></button>
      <button type="button" class="btn secondary" data-v="cancel">Cancel</button>
      <button type="button" class="btn" data-v="confirm"></button>
    </div>`;
  document.body.appendChild(dialog);
  return dialog;
}

/** Show the dialog; resolves 'confirm', 'alt', or null if cancelled. */
export function askConfirm({ title, body = '', confirm = 'OK', danger = false, alt = '' } = {}) {
  const d = ensure();
  d.querySelector('#tc-title').textContent = title || 'Are you sure?';
  const text = d.querySelector('#tc-text');
  if (body && typeof body === 'object' && 'html' in body) text.innerHTML = body.html; else text.textContent = body;
  text.hidden = !body;
  const ok = d.querySelector('[data-v="confirm"]');
  ok.textContent = confirm;
  ok.classList.toggle('danger', !!danger);
  const altBtn = d.querySelector('[data-v="alt"]');
  altBtn.textContent = alt;
  altBtn.hidden = !alt;

  return new Promise((resolve) => {
    const done = (v) => {
      d.removeEventListener('cancel', onCancel);
      d.querySelectorAll('[data-v]').forEach(b => { b.onclick = null; });
      if (d.open) d.close();
      resolve(v);
    };
    const onCancel = (e) => { e.preventDefault(); done(null); };
    d.addEventListener('cancel', onCancel);                        // Escape
    d.querySelectorAll('[data-v]').forEach(b => {
      b.onclick = () => done(b.dataset.v === 'cancel' ? null : b.dataset.v);
    });
    d.onclick = (e) => { if (e.target === d) done(null); };        // click on the backdrop
    d.showModal();
    // Destructive: focus Cancel, so Enter doesn't delete by accident.
    (danger ? d.querySelector('[data-v="cancel"]') : ok).focus();
  });
}
