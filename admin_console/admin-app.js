/**
 * admin-app.js — Try for Tomorrow admin console.
 *
 * Answers the four questions the programme needs:
 *   1. Which educational providers exist?
 *   2. For each, has a given session ever been delivered — and how many times?
 *   3. What pledges were captured in each run of each session?
 *   4. What are the All-Providers totals per session?
 *
 * WHAT THIS CONSOLE DELIBERATELY CANNOT DO
 * It cannot show you a student's name. Pledges carry only `student_ref`, and the
 * ref→name mapping lives exclusively in the provider's WordPress account. That
 * is not an oversight to be fixed later — it is the privacy design. If a future
 * change makes names appear here, something has gone wrong.
 */

import {
  initializeApp, getFirestore, getAuth, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, doc, getDoc, getDocs, collection, updateDoc, query, orderBy
, MODE } from '../data-layer.js';
import { SESSION_COUNT } from '../public_widget/session-config.js';

const app  = initializeApp({ projectId: 'tft26-local' });
const db   = getFirestore(app);
const auth = getAuth(app);

const appEl = document.getElementById('app');
const modePill = document.getElementById('ab-mode');
modePill.textContent = MODE === 'live' ? 'LIVE' : 'SANDBOX';
modePill.classList.toggle('live', MODE === 'live');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const when = (ts) => ts?.seconds ? new Date(ts.seconds * 1000).toLocaleDateString('en-GB',
  { day:'numeric', month:'short', year:'numeric' }) : '—';

function render(id) {
  appEl.innerHTML = '';
  appEl.appendChild(document.getElementById(id).content.cloneNode(true));
}

// ─── Auth ────────────────────────────────────────────────────────────────────
function viewLogin() {
  render('v-login');
  const go = async () => {
    try {
      await signInWithEmailAndPassword(auth, $('lg-email').value.trim(), $('lg-pass').value);
    } catch {
      $('lg-err').textContent = 'Incorrect email or password.';
      $('lg-err').classList.remove('hidden');
    }
  };
  $('lg-go').addEventListener('click', go);
  $('lg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { $('ab-user').textContent = ''; $('ab-signout').classList.add('hidden'); return viewLogin(); }

  // Client-side claim check. The Firestore rules enforce this server-side too;
  // this only exists so a non-admin sees a clear message, not a broken page.
  const token = await user.getIdTokenResult();
  if (!token.claims.admin) {
    await signOut(auth);
    viewLogin();
    $('lg-err').textContent = 'That account does not have admin access.';
    $('lg-err').classList.remove('hidden');
    return;
  }
  $('ab-user').textContent = user.email;
  $('ab-signout').classList.remove('hidden');
  viewDash();
});

$('ab-signout').addEventListener('click', e => { e.preventDefault(); signOut(auth); });

// ─── 1. Dashboard — all providers ────────────────────────────────────────────
async function viewDash() {
  render('v-dash');

  const totalsSnap = await getDoc(doc(db, 'public', 'session-totals'));
  const t = totalsSnap.exists() ? totalsSnap.data() : {};
  $('da-totals').innerHTML = Array.from({ length: SESSION_COUNT }, (_, i) => {
    const n = i + 1;
    return `<div class="stotal">
      <div class="s">Session ${n}</div>
      <div class="n">${t['s' + n + '_pledges'] || 0}</div>
      <div class="r">${t['s' + n + '_runs'] || 0} run${(t['s' + n + '_runs'] || 0) === 1 ? '' : 's'}</div>
    </div>`;
  }).join('');

  const snap = await getDocs(collection(db, 'providers'));
  const providers = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (!providers.length) {
    $('da-providers').innerHTML = '<tr><td colspan="8"><div class="empty">No providers yet.</div></td></tr>';
    return;
  }

  $('da-providers').innerHTML = providers.map(p => {
    const st = p.session_stats || {};
    let pledges = 0;
    const cells = Array.from({ length: SESSION_COUNT }, (_, i) => {
      const s = st['s' + (i + 1)] || { runs: 0, pledges: 0 };
      pledges += s.pledges || 0;
      return `<td class="sess-cell">${
        s.runs ? `<span class="pill ok">${s.runs}×</span>` : '<span class="pill none">—</span>'
      }</td>`;
    }).join('');
    return `<tr class="clickable" data-provider="${esc(p.id)}">
      <td><strong>${esc(p.name)}</strong><br><span class="muted" style="font-size:.75rem">${esc(p.id)}</span></td>
      ${cells}<td class="sess-cell"><strong>${pledges}</strong></td>
    </tr>`;
  }).join('');

  appEl.querySelectorAll('[data-provider]').forEach(tr =>
    tr.addEventListener('click', () => viewProvider(tr.dataset.provider)));
}

// ─── 2. Provider detail — sessions and their runs ────────────────────────────
async function viewProvider(providerId) {
  render('v-provider');
  $('pv-back').addEventListener('click', e => { e.preventDefault(); viewDash(); });

  const [pSnap, privSnap, runsSnap] = await Promise.all([
    getDoc(doc(db, 'providers', providerId)),
    getDoc(doc(db, 'providers_private', providerId)),
    getDocs(collection(db, 'providers', providerId, 'runs'))
  ]);
  const p = pSnap.exists() ? pSnap.data() : { name: providerId };
  const priv = privSnap.exists() ? privSnap.data() : null;
  const runs = runsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Resolve cohort + group labels so runs read as "Year 9 Rugby · Boys" rather
  // than raw ids. These are structural labels only — never a student name.
  const labels = await loadCohortLabels(providerId, runs);

  $('pv-eyebrow').textContent = 'Provider';
  $('pv-name').textContent    = p.name || providerId;
  $('pv-contact').textContent = priv
    ? `${priv.contact_name} · ${priv.contact_email}`
    : 'No contact on record';

  const st = p.session_stats || {};
  $('pv-sessions').innerHTML = Array.from({ length: SESSION_COUNT }, (_, i) => {
    const n = i + 1;
    const s = st['s' + n] || { runs: 0, pledges: 0 };
    const mine = runs.filter(r => r.session === n);
    const runList = mine.length
      ? mine.map(r => `<button class="btn ghost" data-run="${esc(r.id)}" data-session="${n}" style="text-align:left">
            <strong>${esc(labels.cohort(r.cohort_id))}</strong> · ${esc(labels.group(r.cohort_id, r.group_id))}<br>
            <span class="muted" style="font-size:.75rem">${when(r.started_at)} · ${r.pledge_count || 0} pledges</span>
            <span class="pill ${r.status === 'open' ? 'live' : 'none'}">${esc(r.status)}</span>
          </button>`).join('')
      : '<span class="muted" style="font-size:.82rem">Never delivered</span>';

    return `<div class="card">
      <div class="row between">
        <div><strong>Session ${n}</strong>
          <span class="muted" style="font-size:.8rem"> · ${s.pledges || 0} pledges</span></div>
        ${s.runs ? `<span class="pill ok">Run ${s.runs}×</span>` : '<span class="pill none">Never run</span>'}
      </div>
      <div class="row" style="flex-wrap:wrap;margin-top:.45rem">${runList}</div>
    </div>`;
  }).join('');

  appEl.querySelectorAll('[data-run]').forEach(b =>
    b.addEventListener('click', () => viewRun(providerId, b.dataset.run, b.dataset.session)));
}

/**
 * Build cohort/group label resolvers for a provider. Reads the mirrored cohort
 * and group documents — structural labels only, never a student name.
 */
async function loadCohortLabels(providerId, runs) {
  const cohortIds = [...new Set(runs.map(r => r.cohort_id).filter(Boolean))];
  const map = {};
  await Promise.all(cohortIds.map(async cid => {
    const [cSnap, gSnap] = await Promise.all([
      getDoc(doc(db, 'providers', providerId, 'cohorts', cid)),
      getDocs(collection(db, 'providers', providerId, 'cohorts', cid, 'groups'))
    ]);
    const groups = {};
    gSnap.docs.forEach(d => { groups[d.id] = d.data().label || d.id; });
    map[cid] = { label: cSnap.exists() ? (cSnap.data().label || cid) : cid, groups };
  }));
  return {
    cohort: (cid) => (cid && map[cid]?.label) || cid || '—',
    group:  (cid, gid) => (cid && gid && map[cid]?.groups[gid]) || gid || '—'
  };
}

// ─── 3. Run detail — the captured pledges ────────────────────────────────────
async function viewRun(providerId, runId, session) {
  render('v-run');
  $('rv-back').addEventListener('click', e => { e.preventDefault(); viewProvider(providerId); });
  $('rv-eyebrow').textContent = providerId;
  $('rv-title').textContent   = `Session ${session} — run`;

  const [runSnap, pledgeSnap] = await Promise.all([
    getDoc(doc(db, 'providers', providerId, 'runs', runId)),
    getDocs(query(collection(db, 'providers', providerId, 'runs', runId, 'pledges'),
                  orderBy('created_at', 'desc')))
  ]);
  const run = runSnap.exists() ? runSnap.data() : {};
  const labels = await loadCohortLabels(providerId, [run]);
  $('rv-sub').textContent =
    `${labels.cohort(run.cohort_id)} · ${labels.group(run.cohort_id, run.group_id)} · ${when(run.started_at)} · ${run.pledge_count || 0} pledges · ${run.status || ''}`;

  const pledges = pledgeSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!pledges.length) {
    $('rv-pledges').innerHTML = '<div class="empty">No pledges captured in this run.</div>';
    return;
  }

  $('rv-pledges').innerHTML = pledges.map(p => {
    // Option 6 is a student's own free text — the only pledges that can carry
    // unexpected content, so they are the ones that most need a moderator's eye.
    const own = p.option === 6;
    const tag = own
      ? '<span class="pill live">own idea</span>'
      : `<span class="pill none">option ${esc(p.option ?? '—')}</span>`;
    return `<div class="pledge">
      <div class="top">
        <span class="row" style="gap:.4rem">
          <span class="ref">${esc(p.student_ref)}</span>${tag}
        </span>
        <span class="row" style="gap:.4rem">
          <span class="pill ${p.status === 'approved' ? 'ok' : 'pending'}">${esc(p.status || 'pending')}</span>
          ${p.status !== 'approved'
            ? `<button class="btn ghost" data-approve="${esc(p.id)}">Approve</button>` : ''}
        </span>
      </div>
      <div class="txt">${esc(p.pledge_text)}</div>
    </div>`;
  }).join('');

  // Moderation: the workflow is still being decided, but approval is wired so
  // the pending→approved path can be exercised end to end in testing.
  appEl.querySelectorAll('[data-approve]').forEach(b =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      await updateDoc(doc(db, 'providers', providerId, 'runs', runId, 'pledges', b.dataset.approve),
        { status: 'approved' });
      viewRun(providerId, runId, session);
    }));
}
