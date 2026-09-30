/**
 * admin-app.js — Try for Tomorrow admin console.
 *
 * Answers the four questions the programme needs:
 *   1. Which educational providers exist?
 *   2. For each, has a given session ever been delivered — and how many times?
 *   3. What pledges were captured in each run of each session?
 *   4. What are the All-Providers totals per session?
 *   5. How did groups answer the evaluation survey, before and after? (Evaluation)
 *
 * WHAT THIS CONSOLE DELIBERATELY CANNOT DO
 * It cannot show you a student's name. Pledges carry only `student_ref`, and the
 * ref→name mapping lives exclusively in the provider's WordPress account. That
 * is not an oversight to be fixed later — it is the privacy design. If a future
 * change makes names appear here, something has gone wrong.
 */

import {
  initializeApp, getFirestore, getAuth, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, doc, getDoc, getDocs, collection, updateDoc, deleteDoc, query, orderBy, where,
  MODE, currentUser } from '../data-layer.js';
import * as sessionConfig from '../public_widget/session-config.js';
import { listSessionDocs, versionUrl, projectorPagePath, projectorPageStatus } from '../doc-store.js';
import { SURVEY, tallyLabels } from '../public_widget/survey-config.js';
import { askConfirm } from '../confirm-dialog.js';
const { SESSION_COUNT, SESSIONS } = sessionConfig;
const SESSION_MEDIA = sessionConfig.SESSION_MEDIA || {};

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
/**
 * Sandbox: the admin login signs in to the local stand-in database.
 *
 * Live: the admin login is a PERSONA (like the facilitator logins). The real
 * database access comes from the account signed in at the black bar
 * (auth-gate.js): a demo guest sees and moderates the demo organisations only;
 * a genuine admin (claim admin:true) sees everything. The rules enforce this.
 */
const PERSONA = { email: 'admin@tft-demo.example', password: 'tftadmin' };
const LS_PERSONA = 'tft26_admin_persona_v1';
let realAdmin = false;          // Live: is the real account a genuine admin?

function viewLogin(message) {
  render('v-login');
  if (message) { $('lg-err').textContent = message; $('lg-err').classList.remove('hidden'); }
  const go = async () => {
    const email = $('lg-email').value.trim(), password = $('lg-pass').value;
    if (MODE === 'live') {
      if (email === PERSONA.email && password === PERSONA.password) {
        try { localStorage.setItem(LS_PERSONA, email); } catch {}
        return enter(email);
      }
    } else {
      try { await signInWithEmailAndPassword(auth, email, password); return; } catch {}
    }
    $('lg-err').textContent = 'Incorrect email or password.';
    $('lg-err').classList.remove('hidden');
  };
  $('lg-go').addEventListener('click', go);
  $('lg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

function enter(label) {
  $('ab-user').textContent = label;
  $('ab-signout').classList.remove('hidden');
  $('ab-nav').classList.remove('hidden');
  viewDash();
}
function leave(message) {
  $('ab-user').textContent = ''; $('ab-signout').classList.add('hidden'); $('ab-nav').classList.add('hidden');
  viewLogin(message);
}

if (MODE === 'live') {
  (async () => {
    const real = currentUser();
    realAdmin = !!(real && (await real.getIdTokenResult()).claims.admin);
    let persona = null;
    try { persona = localStorage.getItem(LS_PERSONA); } catch {}
    persona ? enter(persona) : leave();
  })();
} else {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return leave();
    // Client-side claim check; the rules enforce it server-side too.
    const token = await user.getIdTokenResult();
    if (!token.claims.admin) { await signOut(auth); return leave('That account does not have admin access.'); }
    enter(user.email);
  });
}

$('ab-signout').addEventListener('click', e => {
  e.preventDefault();
  if (MODE === 'live') { try { localStorage.removeItem(LS_PERSONA); } catch {} leave(); }
  else signOut(auth);
});
document.querySelectorAll('[data-nav]').forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  a.dataset.nav === 'docs' ? viewDocs() : a.dataset.nav === 'eval' ? viewEval() : viewDash();
}));
function navOn(which) { document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === which)); }

// ─── 1. Dashboard — all providers ────────────────────────────────────────────
async function viewDash() {
  render('v-dash');
  navOn('dash');

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

  const providers = await listProviders();

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

  // Pledges by option, one session at a time.
  let pick = Number(sessionStorage.getItem('tft26_admin_opt_session')) || 1;
  const paintOptions = (all) => {
    if (!$('da-options')) return;
    $('da-opt-sessions').innerHTML = SESSIONS.map(s =>
      `<button data-os="${s.n}" aria-pressed="${s.n === pick}" title="${esc(s.title)}">Session ${s.n}</button>`).join('');
    appEl.querySelectorAll('[data-os]').forEach(b => b.addEventListener('click', () => {
      pick = Number(b.dataset.os);
      try { sessionStorage.setItem('tft26_admin_opt_session', pick); } catch {}
      paintOptions(all);
    }));
    $('da-opt-title').textContent = SESSIONS.find(s => s.n === pick)?.title || '';
    $('da-options').innerHTML = optionTable(all.filter(p => p.session === pick), pick);
  };
  try {
    pledgeCache = pledgeCache || await loadAllPledges(providers);
    paintOptions(pledgeCache);
  } catch (e) {
    console.error('[TFT26] pledges unavailable', e);
    if ($('da-options')) $('da-options').innerHTML = '<div class="muted">Couldn’t load the pledges.</div>';
  }
}

// ─── Pledges by option ───────────────────────────────────────────────────────
/**
 * How many pledges each option got, and its share: the session's five options
 * plus "Their own idea" (option 6), most popular first. Counts every pledge
 * captured, pending moderation or approved.
 */
function optionRows(pledges, session) {
  const opts = SESSIONS.find(s => s.n === Number(session))?.options || [];
  const rows = opts.map((text, i) => ({ text, count: pledges.filter(p => p.option === i + 1).length }));
  rows.push({ text: 'Their own idea', count: pledges.filter(p => p.option === 6).length, own: true });
  const total = pledges.length;
  return rows.map(r => ({ ...r, pct: total ? Math.round(r.count / total * 100) : 0 }))
             .sort((a, b) => b.count - a.count || (a.own ? 1 : 0) - (b.own ? 1 : 0));
}
function optionTable(pledges, session) {
  if (!pledges.length) return '<div class="muted" style="font-size:.85rem">No pledges yet.</div>';
  return `<div class="opt-stats">${optionRows(pledges, session).map(r => `
    <div class="os-row">
      <div class="os-t">${esc(r.text)}</div>
      <div class="os-n">${r.count}</div>
      <div class="os-p">${r.pct}%</div>
      <div class="bar-track"><div class="bar-fill" style="width:${r.pct}%"></div></div>
    </div>`).join('')}
    <div class="os-total">${pledges.length} pledge${pledges.length === 1 ? '' : 's'} in all</div></div>`;
}

/** Every pledge the admin can see (a demo guest: the demo organisations only). */
let pledgeCache = null;
async function loadAllPledges(providers) {
  const out = [];
  await Promise.all(providers.map(async p => {
    const runs = await getDocs(collection(db, 'providers', p.id, 'runs'));
    await Promise.all(runs.docs.map(async r => {
      const ps = await getDocs(collection(db, 'providers', p.id, 'runs', r.id, 'pledges'));
      ps.docs.forEach(d => out.push(d.data()));
    }));
  }));
  return out;
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
            <span class="muted" style="font-size:.75rem">${when(r.started_at)} · ${r.pledge_count || 0} pledges · physical task ${r.physical_done ? 'done' : 'not done'}</span>
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
    `${labels.cohort(run.cohort_id)} · ${labels.group(run.cohort_id, run.group_id)} · ${when(run.started_at)} · ${run.pledge_count || 0} pledges · physical task ${run.physical_done ? 'done' : 'not done'} · ${run.status || ''}`;

  const pledges = pledgeSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  $('rv-options').innerHTML = optionTable(pledges, session);
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
      pledgeCache = null;
      viewRun(providerId, runId, session);
    }));
}

// ─── Session documents — upload new PDF versions ─────────────────────────────
const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const onDay = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

/**
 * Each session's worksheet: the current PDF (+ earlier versions) and the state
 * of its projector page (worksheets/html/session-N.html). The projector page is
 * supplied separately and should match the current PDF — its meta tags say
 * whether it's still a holder, and which PDF version it matches.
 */
async function viewDocs() {
  render('v-docs');
  navOn('docs');
  const docs = await listSessionDocs();
  const rows = await Promise.all(SESSIONS.map(async (s) => {
    const meta = docs[String(s.n)] || {};
    const cur = meta.current || null;
    const url = versionUrl(cur);
    let page = { kind: 'missing' };
    try {
      const res = await fetch('../' + projectorPagePath(s.n), { cache: 'no-cache' });
      if (res.ok) page = projectorPageStatus(await res.text());
    } catch {}
    return { s, cur, url, history: meta.history || [], page };
  }));
  if (!$('dc-list')) return;

  const pageStatus = (page, cur) =>
      page.kind === 'missing' ? '<span class="pill pending">Missing</span>'
    : page.kind === 'holder'  ? '<span class="pill pending">Holder</span> <span class="muted">replace when the final worksheet is ready</span>'
    : !cur                    ? '<span class="pill ok">Final</span>'
    : page.matchesPdf === cur.version ? `<span class="pill ok">Matches PDF v${cur.version}</span>`
    : `<span class="pill pending">Out of step</span> <span class="muted">matches PDF v${page.matchesPdf || '?'}; current is v${cur.version}</span>`;

  $('dc-list').innerHTML = rows.map(({ s, cur, url, history, page }) => `
    <div class="card doc-admin">
      <strong>Session ${s.n} · ${esc(s.title)}</strong>
      <div class="muted" style="font-size:.82rem">${esc(s.classroom?.title || '')}${SESSION_MEDIA[s.n]?.worksheet ? ' · ' + esc(SESSION_MEDIA[s.n].worksheet) : ''}</div>
      <div class="doc-grid">
        <div><div class="lbl">PDF</div><div class="val">${cur
          ? `v${cur.version} · <a href="${esc(url)}" target="_blank" rel="noopener">${esc(cur.name)}</a> · ${kb(cur.size)} · ${onDay(cur.added)}`
          : '<span class="muted">None added yet</span>'}</div></div>
        <div><div class="lbl">Projector page</div><div class="val">${pageStatus(page, cur)}
          · <a href="../${projectorPagePath(s.n)}" target="_blank" rel="noopener">Open</a></div></div>
      </div>
      ${history.length ? `<details><summary>Earlier versions (${history.length})</summary><ul>${history.slice().reverse().map(v =>
        `<li>v${v.version} · <a href="${esc(versionUrl(v))}" target="_blank" rel="noopener">${esc(v.name)}</a> · ${kb(v.size)} · ${onDay(v.added)}</li>`).join('')}</ul></details>` : ''}
    </div>`).join('');

}

// ─── Evaluation — the group surveys, baseline vs final ───────────────────────
/**
 * Every group answers the survey twice (survey-config.js): a baseline before its
 * first session and a final after its sixth. One response per group — nothing
 * here is about an individual. Drill down organisation → cohort → group; with a
 * group chosen, its two responses are shown side by side. Only responses to the
 * current survey version are compared.
 */
const evalState = { foundation: '', provider: '', cohort: '', group: '', matched: true };

/** The providers this admin may see (a demo guest: the demo organisations only). */
async function listProviders() {
  const snap = await getDocs(MODE === 'live' && !realAdmin
    ? query(collection(db, 'providers'), where('demo', '==', true))
    : collection(db, 'providers'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadSurveys() {
  const providers = await listProviders();
  const rows = [];
  await Promise.all(providers.map(async p => {
    const snap = await getDocs(collection(db, 'providers', p.id, 'surveys'));
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const labels = await loadCohortLabels(p.id, docs);
    docs.forEach(d => rows.push({
      ...d, provider_id: p.id, provider: p.name || p.id,
      cohort: labels.cohort(d.cohort_id), group: labels.group(d.cohort_id, d.group_id)
    }));
  }));
  return rows;
}

const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

/** One baseline-vs-final bar pair. `max` scales the bars; `fmt` labels the values. */
function compareBars(label, b, f, max, fmt) {
  const w = (v) => v == null ? 0 : Math.max(0, Math.min(100, v / max * 100));
  const lab = (v) => v == null ? '–' : fmt(v);
  return `<div class="cmp">
    <div class="cmp-l">${esc(label)}</div>
    <div class="cmp-bars">
      <div class="cmp-row b"><span>Baseline</span><div class="track"><i style="width:${w(b)}%"></i></div><b>${lab(b)}</b></div>
      <div class="cmp-row f"><span>Final</span><div class="track"><i style="width:${w(f)}%"></i></div><b>${lab(f)}</b></div>
    </div>
    <div class="cmp-d">${changeHtml(b, f)}</div>
  </div>`;
}
/** Final minus baseline, in percentage points: "+12 pts", "−5 pts", "No change". */
function changeHtml(b, f) {
  if (b == null || f == null) return '<span class="muted">–</span>';
  const d = f - b;
  return d === 0 ? '<span class="muted">No change</span>'
       : `<span class="chg ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${Math.abs(d)} pts</span>`;
}

/**
 * A question's result across a set of baseline and final responses. Answers are
 * a show of hands per group, so they're pooled: for a poll, each answer's share
 * of all the young people who answered; for "counts" (e.g. spoken with friends /
 * family / teachers), each item's share of everyone taking part.
 */
function questionResult(q, B, F) {
  const has = (rs) => rs.filter(r => Array.isArray(r.answers?.[q.id]));
  const b = has(B), f = has(F);
  const labels = tallyLabels(q);
  const pooled = (rs, i) => {
    if (!rs.length) return null;
    const hands = rs.reduce((s, r) => s + (r.answers[q.id][i] || 0), 0);
    const of = q.type === 'poll'
      ? rs.reduce((s, r) => s + r.answers[q.id].reduce((x, n) => x + (n || 0), 0), 0)
      : rs.reduce((s, r) => s + (r.present || 0), 0);
    return pct(hands, of);
  };
  const people = (rs) => rs.reduce((s, r) => s + (r.present || 0), 0);
  const body = `<div class="cmp cmp-head"><div>Answer</div><div>Baseline / final</div><div>Change</div></div>`
    + labels.map((l, i) => compareBars(l, pooled(b, i), pooled(f, i), 100, v => v + '%')).join('');
  return `<div class="card qres">
    <strong>${esc(q.text)}</strong>
    <div class="muted qn">${q.type === 'poll' ? '% of young people giving each answer' : '% of young people saying yes to each'}
      · baseline ${b.length} group${b.length === 1 ? '' : 's'}, ${people(b)} young people · final ${f.length}, ${people(f)}</div>
    ${body}
  </div>`;
}

/** One group's answer: "Yes 9 (75%) · No 3 (25%)". */
function tallyHtml(q, a, present) {
  if (!Array.isArray(a)) return '<span class="muted">No answer</span>';
  const of = q.type === 'poll' ? a.reduce((s, n) => s + (n || 0), 0) : present;
  return tallyLabels(q).map((l, i) =>
    `<span class="tally">${esc(l)} <b>${a[i] ?? '–'}</b> <span class="muted">(${pct(a[i] || 0, of)}%)</span></span>`).join('');
}

async function viewEval() {
  render('v-eval');
  navOn('eval');
  let rows;
  try { rows = await loadSurveys(); }
  catch (e) { console.error('[TFT26] surveys unavailable', e); $('ev-body').innerHTML = '<div class="empty">Couldn’t load the surveys.</div>'; return; }
  if (!$('ev-body')) return;
  const Q = SURVEY.questions;
  const current = rows.filter(r => r.survey_version === SURVEY.version);
  const older = rows.length - current.length;
  $('ev-version').textContent = `Survey version ${SURVEY.version}${SURVEY.placeholder ? ' (placeholder questions)' : ''}`
    + (older ? ` · ${older} response${older === 1 ? '' : 's'} to an earlier version not included` : '');

  const key = (r) => `${r.provider_id}|${r.cohort_id}|${r.group_id}`;
  const opt = (v, t, on) => `<option value="${esc(v)}" ${on ? 'selected' : ''}>${esc(t)}</option>`;
  const uniq = (rs, k, t) => [...new Map(rs.map(r => [r[k] || '', r[t] || '(not given)'])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));

  function paint() {
    const s = evalState;
    // ── Filters: Foundation, then organisation → cohort → group ──
    const inF = current.filter(r => !s.foundation || (r.foundation || '') === s.foundation);
    const inP = inF.filter(r => !s.provider || r.provider_id === s.provider);
    const inC = inP.filter(r => !s.cohort || r.cohort_id === s.cohort);
    const inG = inC.filter(r => !s.group || r.group_id === s.group);
    $('ev-foundation').innerHTML = opt('', 'All Foundations', !s.foundation) + uniq(current, 'foundation', 'foundation').map(([v, t]) => opt(v, t, v === s.foundation)).join('');
    $('ev-provider').innerHTML = opt('', 'All organisations', !s.provider) + uniq(inF, 'provider_id', 'provider').map(([v, t]) => opt(v, t, v === s.provider)).join('');
    $('ev-cohort').innerHTML = opt('', 'All cohorts', !s.cohort) + uniq(inP, 'cohort_id', 'cohort').map(([v, t]) => opt(v, t, v === s.cohort)).join('');
    $('ev-group').innerHTML = opt('', 'All groups', !s.group) + uniq(inC, 'group_id', 'group').map(([v, t]) => opt(v, t, v === s.group)).join('');
    $('ev-cohort').disabled = !s.provider;
    $('ev-group').disabled = !s.cohort;
    $('ev-matched').checked = s.matched;

    // ── Groups in scope, and which responses to compare ──
    const groups = new Map();
    inG.forEach(r => { const g = groups.get(key(r)) || { ...r, baseline: null, final: null }; g[r.phase] = r; groups.set(key(r), g); });
    const list = [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.cohort.localeCompare(b.cohort) || a.group.localeCompare(b.group));
    const matched = list.filter(g => g.baseline && g.final);
    const use = s.matched ? matched : list;
    const B = use.map(g => g.baseline).filter(Boolean), F = use.map(g => g.final).filter(Boolean);

    $('ev-tiles').innerHTML = [
      [list.filter(g => g.baseline).length, 'Groups with a baseline'],
      [list.filter(g => g.final).length, 'Groups with a final'],
      [matched.length, 'Groups with both'],
      [B.reduce((a, r) => a + (r.present || 0), 0), 'Young people, baseline'],
      [F.reduce((a, r) => a + (r.present || 0), 0), 'Young people, final']
    ].map(([n, l]) => `<div class="stotal"><div class="n">${n}</div><div class="s">${l}</div></div>`).join('');

    const single = s.group && list.length === 1 ? list[0] : null;
    if (single) {
      // One group: its two responses side by side.
      const cell = (r, q) => r ? tallyHtml(q, r.answers?.[q.id], r.present) : '<span class="muted">Not yet</span>';
      // Each answer's share (as in tallyHtml), final minus baseline.
      const shares = (r, q) => {
        const a = r?.answers?.[q.id];
        if (!Array.isArray(a)) return null;
        const of = q.type === 'poll' ? a.reduce((s, n) => s + (n || 0), 0) : r.present;
        return a.map(n => pct(n || 0, of));
      };
      const change = (q) => {
        const b = shares(single.baseline, q), f = shares(single.final, q);
        if (!b || !f) return '<span class="muted">–</span>';
        return tallyLabels(q).map((l, i) => `<span class="tally">${esc(l)} ${changeHtml(b[i], f[i])}</span>`).join('');
      };
      const del = (r, ph) => r ? `<button class="btn ghost" data-del="${esc(r.provider_id)}|${esc(r.id)}" title="Remove this response so the group can answer again">Delete ${ph}</button>` : '';
      const who = (r) => r ? [r.facilitator, when(r.created_at)].filter(Boolean).map(esc).join(' · ') : '';
      $('ev-body').innerHTML = `<div class="card">
        <div class="row between" style="flex-wrap:wrap;gap:.5rem">
          <div><strong>${esc(single.provider)} · ${esc(single.cohort)} · ${esc(single.group)}</strong>
            <div class="muted" style="font-size:.8rem">${[single.foundation, single.school].filter(Boolean).map(esc).join(' · ')}</div></div>
          <span class="row" style="gap:.3rem">${del(single.baseline, 'baseline')}${del(single.final, 'final')}</span></div>
        <div class="table-scroll" style="margin-top:.7rem"><table class="ev-single">
          <thead><tr><th>Question</th><th>Baseline<br><span class="muted">${who(single.baseline)}</span></th><th>Final<br><span class="muted">${who(single.final)}</span></th><th>Change</th></tr></thead>
          <tbody><tr><td>Taking part</td><td>${single.baseline?.present ?? '–'}</td><td>${single.final?.present ?? '–'}</td><td></td></tr>
          ${Q.map((q, i) => `<tr><td>${i + 1}. ${esc(q.text)}</td><td>${cell(single.baseline, q)}</td><td>${cell(single.final, q)}</td><td>${change(q)}</td></tr>`).join('')}</tbody>
        </table></div></div>`;
      appEl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        const [pid, id] = b.dataset.del.split('|');
        if (await askConfirm({ title: 'Delete this survey response?', body: 'The group will be asked to answer it again.',
                               confirm: 'Delete response', danger: true }) !== 'confirm') return;
        b.disabled = true;
        try { await deleteDoc(doc(db, 'providers', pid, 'surveys', id)); viewEval(); }
        catch (e) { console.error(e); alert('Could not delete the response.'); b.disabled = false; }
      }));
    } else {
      $('ev-body').innerHTML = !B.length && !F.length
        ? `<div class="empty">${s.matched && list.length ? 'No group here has both surveys yet. Untick “Groups with both” to see what’s in.' : 'No survey responses yet.'}</div>`
        : Q.map(q => questionResult(q, B, F)).join('');
    }

    // ── Groups table (click to drill down) ──
    $('ev-groups').innerHTML = list.length ? list.map(g => `<tr class="clickable" data-g="${esc(key(g))}">
        <td>${esc(g.foundation || '—')}</td><td>${esc(g.provider)}</td><td>${esc(g.school || '—')}</td>
        <td>${esc(g.cohort)} · <strong>${esc(g.group)}</strong></td>
        <td>${g.baseline ? `${when(g.baseline.created_at)} · ${g.baseline.present}` : '<span class="pill none">—</span>'}</td>
        <td>${g.final ? `${when(g.final.created_at)} · ${g.final.present}` : '<span class="pill none">—</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="6"><div class="empty">No groups.</div></td></tr>';
    appEl.querySelectorAll('[data-g]').forEach(tr => tr.addEventListener('click', () => {
      const [p, c, g] = tr.dataset.g.split('|');
      Object.assign(evalState, { provider: p, cohort: c, group: g });
      paint(); window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    $('ev-export').onclick = () => exportCsv(inG);
  }

  $('ev-foundation').addEventListener('change', e => { Object.assign(evalState, { foundation: e.target.value, provider: '', cohort: '', group: '' }); paint(); });
  $('ev-provider').addEventListener('change', e => { Object.assign(evalState, { provider: e.target.value, cohort: '', group: '' }); paint(); });
  $('ev-cohort').addEventListener('change', e => { Object.assign(evalState, { cohort: e.target.value, group: '' }); paint(); });
  $('ev-group').addEventListener('change', e => { evalState.group = e.target.value; paint(); });
  $('ev-matched').addEventListener('change', e => { evalState.matched = e.target.checked; paint(); });
  $('ev-reset').addEventListener('click', () => { Object.assign(evalState, { foundation: '', provider: '', cohort: '', group: '' }); paint(); });
  paint();
}

/**
 * One row per group response for the evaluation team: the survey's details
 * (facilitator, Foundation, school, pre/post), how many took part, then one
 * column per answer holding its show-of-hands count (e.g. interested_yes).
 */
function exportCsv(rows) {
  const Q = SURVEY.questions;
  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const cols = Q.flatMap(q => q.type === 'text' ? [[q, null, q.id]] : tallyLabels(q).map((l, i) => [q, i, `${q.id}_${slug(l)}`]));
  const head = ['facilitator', 'foundation', 'school', 'pre_or_post', 'organisation', 'cohort', 'group', 'date',
                'survey_version', 'taking_part', ...cols.map(c => c[2])];
  const lines = rows.slice().sort((a, b) => a.provider.localeCompare(b.provider) || a.cohort.localeCompare(b.cohort) || a.group.localeCompare(b.group) || a.phase.localeCompare(b.phase))
    .map(r => [r.facilitator, r.foundation, r.school, r.phase === 'baseline' ? 'Pre' : 'Post', r.provider, r.cohort, r.group,
      r.created_at?.seconds ? new Date(r.created_at.seconds * 1000).toISOString().slice(0, 10) : '',
      r.survey_version, r.present,
      ...cols.map(([q, i]) => i == null ? (r.answers?.[q.id] ?? '') : (r.answers?.[q.id]?.[i] ?? ''))]);
  const csv = [head, ...lines].map(l => l.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `tft-survey-results-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
