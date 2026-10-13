/**
 * admin-app.js — Try for Tomorrow admin console.
 *
 * Answers the four questions the programme needs:
 *   1. Which educational providers exist?
 *   2. For each, has a given session ever been delivered — and how many times?
 *   3. What pledges were captured in each run of each session?
 *   4. What are the All-Providers totals per session?
 *   5. How did groups answer the evaluation survey, before and after? (Evaluation)
 * …and lets admins set the session videos every facilitator plays (Session videos),
 * manage who can use the tool (Users), and set up Foundations — the
 * organisations that deliver the programme — and their facilitators (Foundations).
 * ("Provider" in the code and database = a Foundation on screen.)
 *
 * ROLES (firestore.rules enforces them; this console only follows suit)
 *   admin    everything, including Session videos
 *   manager  read-only: sees everything, every change control is hidden
 *   guest    the shared demo: the demo admin persona, on the demo organisations
 *
 * WHAT THIS CONSOLE DELIBERATELY CANNOT DO
 * It cannot show you a student's name. Pledges carry only `student_ref`, and the
 * ref→name mapping lives exclusively in the provider's WordPress account. That
 * is not an oversight to be fixed later — it is the privacy design. If a future
 * change makes names appear here, something has gone wrong.
 */

import {
  initializeApp, getFirestore, getAuth, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, doc, getDoc, getDocs, setDoc, collection, updateDoc, deleteDoc, query, orderBy, where,
  serverTimestamp, inviteAccount, sendPasswordReset, MODE, currentUser } from '../data-layer.js';
import { resolveRole, ROLES, ALL_ROLES, ROLE_HELP } from '../roles.js';
import { videoEmbed, videoKind, VIDEO_KIND_LABEL } from '../video-embed.js';
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
 * Live: the account signed in at the black bar (auth-gate.js) decides. Rethink
 * Food staff (admin or manager) go straight in as themselves. A demo guest
 * signs in with the demo admin PERSONA and sees and moderates the demo
 * organisations only. The rules enforce all of this.
 */
const PERSONA = { email: 'admin@tft-demo.example', password: 'tftadmin' };
const LS_PERSONA = 'tft26_admin_persona_v1';
/** 'admin' | 'manager' | 'guest' — set on sign-in. */
let role = 'guest';
/** The signed-in account's role (roles.js — the people list, else its claims). */
async function roleOfUser(user) {
  if (!user) return 'guest';
  const { claims } = await user.getIdTokenResult();
  const { role: r } = await resolveRole(user, claims, async (email) => {
    const snap = await getDoc(doc(db, 'staff', email));
    return snap.exists() ? snap.data() : null;
  });
  return r;
}
/** Managers are read-only: no change controls are shown to them. */
const canChange = () => role !== 'manager';
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager · read-only', guest: 'Demo admin' };

function viewLogin(message) {
  render('v-login');
  // Sandbox has a read-only manager login too (in Live, roles come from the real account).
  if (MODE !== 'live') $('lg-mgr').classList.remove('hidden');
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

function enter(label, staff = false) {
  $('ab-user').textContent = label;
  $('ab-role').textContent = ROLE_LABEL[role];
  $('ab-role').className = 'mode-pill role-pill ' + role;
  $('ab-role').classList.remove('hidden');
  // Live staff sign out at the black bar (their real account); personas here.
  $('ab-signout').classList.toggle('hidden', MODE === 'live' && staff);
  $('ab-nav').classList.remove('hidden');
  document.querySelector('[data-nav="videos"]').classList.toggle('hidden', role !== 'admin');
  document.querySelector('[data-nav="users"]').classList.toggle('hidden', role !== 'admin');
  document.querySelector('[data-nav="foundations"]').classList.toggle('hidden', role !== 'admin');
  document.body.classList.toggle('read-only', !canChange());
  viewDash();
}
function leave(message) {
  $('ab-user').textContent = ''; $('ab-signout').classList.add('hidden'); $('ab-nav').classList.add('hidden');
  $('ab-role').classList.add('hidden');
  viewLogin(message);
}

if (MODE === 'live') {
  (async () => {
    const real = currentUser();
    role = await roleOfUser(real);
    if (role === 'facilitator') return leave('The admin console is for Rethink Food staff. Your sessions are in the facilitator portal.');
    if (role === 'none') role = 'guest';             // the gate keeps no-access accounts out
    if (role !== 'guest') return enter(real.displayName || real.email, true);
    let persona = null;
    try { persona = localStorage.getItem(LS_PERSONA); } catch {}
    persona ? enter(persona) : leave();
  })();
} else {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return leave();
    // Client-side check; the rules enforce it server-side too.
    role = await roleOfUser(user);
    if (role !== 'admin' && role !== 'manager') { await signOut(auth); return leave('That account does not have admin access.'); }
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
  const v = a.dataset.nav;
  v === 'docs' ? viewDocs() : v === 'eval' ? viewEval() : v === 'videos' ? viewSessionVideos()
    : v === 'users' ? viewUsers() : v === 'foundations' ? viewFoundations() : viewDash();
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

  $('pv-eyebrow').textContent = 'Foundation';
  $('pv-name').textContent    = p.name || providerId;
  $('pv-contact').textContent = priv
    ? `${priv.contact_name} · ${priv.contact_email}`
    : 'No contact on record';
  $('pv-manage').classList.toggle('hidden', role !== 'admin');
  $('pv-manage').onclick = (e) => { e.preventDefault(); viewFoundation(providerId); };

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
          ${p.status !== 'approved' && canChange()
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
const evalState = { provider: '', cohort: '', group: '', matched: true };

/** The providers this admin may see (a demo guest: the demo organisations only). */
async function listProviders() {
  const snap = await getDocs(MODE === 'live' && role === 'guest'
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
      ...d, provider_id: p.id, provider: p.name || p.id, foundation: p.name || p.id,
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
    const inF = current;
    const inP = inF.filter(r => !s.provider || r.provider_id === s.provider);
    const inC = inP.filter(r => !s.cohort || r.cohort_id === s.cohort);
    const inG = inC.filter(r => !s.group || r.group_id === s.group);
    $('ev-provider').innerHTML = opt('', 'All Foundations', !s.provider) + uniq(inF, 'provider_id', 'provider').map(([v, t]) => opt(v, t, v === s.provider)).join('');
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
      const del = (r, ph) => r && canChange() ? `<button class="btn ghost" data-del="${esc(r.provider_id)}|${esc(r.id)}" title="Remove this response so the group can answer again">Delete ${ph}</button>` : '';
      const who = (r) => r ? [r.facilitator, when(r.created_at)].filter(Boolean).map(esc).join(' · ') : '';
      $('ev-body').innerHTML = `<div class="card">
        <div class="row between" style="flex-wrap:wrap;gap:.5rem">
          <div><strong>${esc(single.provider)} · ${esc(single.cohort)} · ${esc(single.group)}</strong>
            <div class="muted" style="font-size:.8rem">${single.school ? esc(single.school) : ''}</div></div>
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
        <td>${esc(g.provider)}</td><td>${esc(g.school || '—')}</td>
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

  $('ev-provider').addEventListener('change', e => { Object.assign(evalState, { provider: e.target.value, cohort: '', group: '' }); paint(); });
  $('ev-cohort').addEventListener('change', e => { Object.assign(evalState, { cohort: e.target.value, group: '' }); paint(); });
  $('ev-group').addEventListener('change', e => { evalState.group = e.target.value; paint(); });
  $('ev-matched').addEventListener('change', e => { evalState.matched = e.target.checked; paint(); });
  $('ev-reset').addEventListener('click', () => { Object.assign(evalState, { provider: '', cohort: '', group: '' }); paint(); });
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
  const head = ['facilitator', 'foundation', 'school', 'pre_or_post', 'cohort', 'group', 'date',
                'survey_version', 'taking_part', ...cols.map(c => c[2])];
  const lines = rows.slice().sort((a, b) => a.provider.localeCompare(b.provider) || a.cohort.localeCompare(b.cohort) || a.group.localeCompare(b.group) || a.phase.localeCompare(b.phase))
    .map(r => [r.facilitator, r.provider, r.school, r.phase === 'baseline' ? 'Pre' : 'Post', r.cohort, r.group,
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

// ─── Session videos — admins set the links every facilitator plays ───────────
/**
 * Each session has two videos: the session film (part 1, "Watch & respond")
 * and the physical task demo (part 3). Their links are saved on the public
 * sessions/{n} documents, which the facilitator portal reads when it opens —
 * so a change here reaches every facilitator without touching the code.
 * Until a session has a saved link, the one in session-config.js is used.
 * Admins only: firestore.rules lets nobody else write sessions/{n}, and only
 * accepts https links.
 */
const VIDEO_FIELDS = [
  ['video_url', 'Session film', (s) => s.film?.title || ''],
  ['physical_video', 'Physical task video', (s) => s.physical?.title || '']
];

async function viewSessionVideos() {
  render('v-videos');
  navOn('videos');
  if (role !== 'admin') { $('vs-list').innerHTML = '<div class="empty">Only admins can change the session videos.</div>'; return; }
  let stored = {};
  try {
    const snap = await getDocs(collection(db, 'sessions'));
    stored = Object.fromEntries(snap.docs.map(d => [Number(d.id), d.data()]));
  } catch (e) { console.error('[TFT26] sessions unavailable', e); }
  if (!$('vs-list')) return;
  const current = (s, f) => typeof stored[s.n]?.[f] === 'string' ? stored[s.n][f]
                           : f === 'video_url' ? (s.video_url || '') : (SESSION_MEDIA[s.n]?.physical_video || '');
  const changed = (s) => stored[s.n]?.media_updated_at
    ? `Last changed ${when(stored[s.n].media_updated_at)}${stored[s.n].media_updated_by ? ' by ' + esc(stored[s.n].media_updated_by) : ''}`
    : 'Not changed here yet';

  $('vs-list').innerHTML = SESSIONS.map(s => `
    <div class="card vid-card" data-n="${s.n}">
      <div class="vid-head"><strong>Session ${s.n} · ${esc(s.title)}</strong><span class="muted vid-when">${changed(s)}</span></div>
      ${VIDEO_FIELDS.map(([f, label, sub]) => `
        <div class="vid-field" data-f="${f}">
          <label class="vid-l" for="vs-${s.n}-${f}">${label}${sub(s) ? ` <span class="muted">· ${esc(sub(s))}</span>` : ''}</label>
          <div class="vid-row">
            <input type="url" id="vs-${s.n}-${f}" value="${esc(current(s, f))}" placeholder="https://www.youtube.com/watch?v=…" spellcheck="false" autocomplete="off">
            <button class="btn secondary" data-preview aria-expanded="false">Preview</button>
          </div>
          <div class="vid-kind"></div>
          <div class="vid-prev pvideo hidden"></div>
        </div>`).join('')}
      <div class="vid-acts"><span class="vid-msg" role="status"></span><button class="btn" data-save disabled>Save session ${s.n}</button></div>
    </div>`).join('');

  appEl.querySelectorAll('.vid-card').forEach(card => {
    const n = Number(card.dataset.n), s = SESSIONS.find(x => x.n === n);
    const saved = Object.fromEntries(VIDEO_FIELDS.map(([f]) => [f, current(s, f)]));
    const value = (f) => card.querySelector(`[data-f="${f}"] input`).value.trim();
    const msg = card.querySelector('.vid-msg'), save = card.querySelector('[data-save]');
    const sync = () => {
      let ok = true, dirty = false;
      for (const [f] of VIDEO_FIELDS) {
        const kind = videoKind(value(f));
        const k = card.querySelector(`[data-f="${f}"] .vid-kind`);
        k.textContent = VIDEO_KIND_LABEL[kind] + (kind && kind !== 'invalid' ? ' ✓' : '');
        k.className = 'vid-kind ' + (kind === 'invalid' ? 'bad' : kind ? 'good' : '');
        if (kind === 'invalid') ok = false;
        if (value(f) !== saved[f]) dirty = true;
      }
      save.disabled = !ok || !dirty;
      if (dirty) { msg.textContent = ok ? 'Unsaved changes' : 'Fix the link to save'; msg.className = 'vid-msg ' + (ok ? 'warn' : 'bad'); }
      else if (!msg.classList.contains('ok')) { msg.textContent = ''; msg.className = 'vid-msg'; }
    };
    card.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { msg.classList.remove('ok'); sync(); }));
    card.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', () => {
      const field = b.closest('.vid-field'), box = field.querySelector('.vid-prev');
      const open = box.classList.contains('hidden');
      box.innerHTML = open ? videoEmbed(field.querySelector('input').value.trim(), 'Preview') : '';
      box.classList.toggle('hidden', !open);
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      b.textContent = open ? 'Close preview' : 'Preview';
    }));
    save.addEventListener('click', async () => {
      save.disabled = true; save.textContent = 'Saving…';
      const by = currentUser()?.email || $('ab-user').textContent || '';
      const data = Object.fromEntries(VIDEO_FIELDS.map(([f]) => [f, value(f)]));
      try {
        await setDoc(doc(db, 'sessions', String(n)), { ...data, media_updated_at: serverTimestamp(), media_updated_by: by }, { merge: true });
        Object.assign(saved, data);
        card.querySelector('.vid-when').textContent = `Last changed ${when({ seconds: Date.now() / 1000 })}${by ? ' by ' + by : ''}`;
        msg.textContent = 'Saved. Facilitators get it next time they open the portal.'; msg.className = 'vid-msg ok';
      } catch (e) {
        console.error('[TFT26] could not save the session videos', e);
        msg.textContent = 'Couldn’t save — check the links and try again.'; msg.className = 'vid-msg bad';
      }
      save.textContent = `Save session ${n}`;
      sync();
    });
    sync();
  });
}

// ─── Users — who can use the tool, and what they can do (admins only) ────────
/**
 * The people list (staff/{email}). Adding someone creates their account and
 * emails them a link to set their own password; their role works once they've
 * used it (that's what verifies their email — see roles.js / firestore.rules).
 * Admins can change anyone's role or switch them off — but not their own entry,
 * so nobody locks themselves out. Switching off is used rather than deleting,
 * so an older account's built-in role can't come back.
 */
const ROLE_NAME = { admin: 'Admin', manager: 'Manager', guest: 'Guest' };
const EMAIL_RE = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

async function viewUsers() {
  render('v-users');
  navOn('users');
  if (role !== 'admin') { $('us-body').innerHTML = '<div class="empty">Only admins can manage users.</div>'; return; }
  $('us-sandbox').classList.toggle('hidden', MODE === 'live');
  $('us-role').innerHTML = ROLES.map(r => `<option value="${r}" ${r === 'manager' ? 'selected' : ''}>${ROLE_NAME[r]} — ${ROLE_HELP[r]}</option>`).join('');
  const me = (currentUser()?.email || $('ab-user').textContent || '').toLowerCase();

  let people = [], foundationNames = {};
  async function load() {
    const snap = await getDocs(collection(db, 'staff'));
    people = snap.docs.map(d => d.data()).filter(p => p.demo !== true).sort((a, b) =>
      (b.active === true) - (a.active === true) || ALL_ROLES.indexOf(a.role) - ALL_ROLES.indexOf(b.role) || String(a.name || a.email).localeCompare(String(b.name || b.email)));
    foundationNames = await foundationNameMap().catch(() => ({}));
  }
  const flash = (text, kind = 'ok') => { const m = $('us-msg'); m.textContent = text; m.className = 'us-msg ' + kind; };

  function paint() {
    if (!$('us-list')) return;
    $('us-count').textContent = `${people.filter(p => p.active).length} active · ${people.length} on the list`;
    $('us-list').innerHTML = people.length ? people.map(p => {
      const self = p.email === me;
      return `<tr class="${p.active ? '' : 'off'}">
        <td><strong>${esc(p.name || '—')}</strong>${self ? ' <span class="pill none">You</span>' : ''}<div class="muted us-email">${esc(p.email)}</div></td>
        <td>${p.role === 'facilitator'
          ? `Facilitator<div class="muted us-email"><a href="#" data-foundation="${esc(p.provider)}">${esc(foundationNames[p.provider] || p.provider)}</a></div>`
          : `<select data-role="${esc(p.email)}" ${self ? 'disabled title="You can’t change your own role"' : ''} aria-label="Role for ${esc(p.email)}">
          ${ROLES.map(r => `<option value="${r}" ${r === p.role ? 'selected' : ''}>${ROLE_NAME[r]}</option>`).join('')}</select>`}</td>
        <td>${p.active ? '<span class="pill ok">On</span>' : '<span class="pill none">Off</span>'}</td>
        <td class="muted us-when">${p.added_at ? when(p.added_at) : '—'}${p.added_by ? '<br>by ' + esc(p.added_by) : ''}</td>
        <td class="us-acts">${self ? '' : `
          <button class="btn ghost" data-resend="${esc(p.email)}" ${p.active ? '' : 'disabled'}>Resend link</button>
          <button class="btn ${p.active ? 'ghost danger-text' : 'secondary'}" data-toggle="${esc(p.email)}">${p.active ? 'Switch off' : 'Switch on'}</button>`}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5"><div class="empty">No one on the list yet.</div></td></tr>';

    appEl.querySelectorAll('[data-role]').forEach(sel => sel.addEventListener('change', async () => {
      const p = people.find(x => x.email === sel.dataset.role);
      const to = sel.value;
      const ok = await askConfirm({
        title: `Make ${p.name || p.email} ${to === 'admin' ? 'an' : 'a'} ${ROLE_NAME[to]}?`,
        body: ROLE_HELP[to] + '. It takes effect the next time they open a page.',
        confirm: `Make ${ROLE_NAME[to]}`, danger: to === 'admin'
      });
      if (ok !== 'confirm') { sel.value = p.role; return; }
      await save(p, { role: to }, `${p.name || p.email} is now ${to === 'admin' ? 'an' : 'a'} ${ROLE_NAME[to]}.`);
    }));
    appEl.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const p = people.find(x => x.email === b.dataset.toggle);
      if (p.active) {
        const ok = await askConfirm({ title: `Switch off ${p.name || p.email}?`,
          body: 'They won’t be able to sign in or see anything. You can switch them back on at any time.',
          confirm: 'Switch off', danger: true });
        if (ok !== 'confirm') return;
      }
      await save(p, { active: !p.active }, p.active ? `${p.name || p.email} is switched off.` : `${p.name || p.email} is switched back on.`);
    }));
    appEl.querySelectorAll('[data-foundation]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); viewFoundation(a.dataset.foundation); }));
    appEl.querySelectorAll('[data-resend]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await sendPasswordReset(b.dataset.resend); flash(`Sent a new set-password link to ${b.dataset.resend}.`); }
      catch (e) { console.error(e); flash('Couldn’t send the link. Try again in a minute.', 'bad'); }
      b.disabled = false;
    }));
  }

  async function save(p, change, done) {
    try {
      await setDoc(doc(db, 'staff', p.email), { ...p, ...change, updated_by: me, updated_at: serverTimestamp() });
      await load(); paint(); flash(done);
    } catch (e) {
      console.error('[TFT26] could not update user', e);
      flash('Couldn’t save that change.', 'bad'); paint();
    }
  }

  // ── Add someone ──
  $('us-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('us-email').value.trim().toLowerCase(), name = $('us-name').value.trim().slice(0, 80), r = $('us-role').value;
    if (!EMAIL_RE.test(email)) return flash('Enter a valid email address.', 'bad');
    if (!name) return flash('Enter their name.', 'bad');
    if (email === me) return flash('That’s you — you’re already on the list.', 'bad');
    const existing = people.find(p => p.email === email);
    if (existing) return flash(`${email} is already on the list — change their role below.`, 'bad');
    const btn = $('us-go'); btn.disabled = true; btn.textContent = 'Adding…';
    try {
      // The role first, then the account and the email — so by the time they
      // follow the link, their role is already waiting for them.
      await setDoc(doc(db, 'staff', email), { email, name, role: r, active: true, added_by: me, added_at: serverTimestamp() });
      const { created } = await inviteAccount(email);
      $('us-add').reset(); $('us-role').value = 'manager';
      await load(); paint();
      flash(created
        ? `Added ${name} as ${r === 'admin' ? 'an' : 'a'} ${ROLE_NAME[r]}. They’ve been emailed a link to set their password.`
        : `${name} already had an account — they’re now ${r === 'admin' ? 'an' : 'a'} ${ROLE_NAME[r]}, and have been emailed a link to set their password.`);
    } catch (err) {
      console.error('[TFT26] could not add user', err);
      flash(err?.code === 'auth/too-many-requests' ? 'Too many attempts — wait a minute and try again.'
          : err?.code?.startsWith?.('auth/') ? 'They’re on the list, but the email couldn’t be sent. Use “Resend link”.'
          : 'Couldn’t add them. Check the details and try again.', 'bad');
      await load().catch(() => {}); paint();
    }
    btn.disabled = false; btn.textContent = 'Add and email invite';
  });

  try { await load(); } catch (e) { console.error(e); $('us-list').innerHTML = '<tr><td colspan="5"><div class="empty">Couldn’t load the list.</div></td></tr>'; return; }
  paint();
}

// ─── Foundations — the organisations, and their facilitators (admins only) ───
/**
 * A Foundation is an organisation that delivers the programme (stored as
 * providers/{id}, with its contact on providers_private/{id}). Its facilitators
 * are people-list entries with the role facilitator and that Foundation's id;
 * firestore.rules lets each act only for their own Foundation. Adding one emails
 * them a set-password link, like the Users page. Young people's names never
 * come here: they stay with the facilitator (WordPress).
 */
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'foundation';

/** id → Foundation name, for labelling facilitators. */
async function foundationNameMap() {
  const providers = await listProviders();
  return Object.fromEntries(providers.map(p => [p.id, p.name || p.id]));
}

async function viewFoundations() {
  render('v-foundations');
  navOn('foundations');
  if (role !== 'admin') { $('fd-body').innerHTML = '<div class="empty">Only admins can manage Foundations.</div>'; return; }
  const flash = (text, kind = 'ok') => { const m = $('fd-msg'); m.textContent = text; m.className = 'us-msg ' + kind; };
  let providers = [], staff = [];
  try {
    [providers, staff] = await Promise.all([
      listProviders(),
      getDocs(collection(db, 'staff')).then(s => s.docs.map(d => d.data()))
    ]);
  } catch (e) { console.error(e); $('fd-list').innerHTML = '<div class="empty">Couldn’t load the Foundations.</div>'; return; }
  if (!$('fd-list')) return;
  providers.sort((a, b) => (a.demo === true) - (b.demo === true) || String(a.name).localeCompare(String(b.name)));
  const facs = (id) => staff.filter(p => p.role === 'facilitator' && p.provider === id);
  $('fd-list').innerHTML = providers.map(p => {
    const f = facs(p.id), on = f.filter(x => x.active).length;
    const pledges = Object.values(p.session_stats || {}).reduce((a, s) => a + (s.pledges || 0), 0);
    return `<button class="card fd-card" data-open="${esc(p.id)}">
      <div class="fd-name">${esc(p.name || p.id)} ${p.demo ? '<span class="pill none">Demo</span>' : ''}</div>
      <div class="muted fd-meta">${on} facilitator${on === 1 ? '' : 's'}${f.length > on ? ` (+${f.length - on} off)` : ''} · ${pledges} pledge${pledges === 1 ? '' : 's'}</div>
    </button>`;
  }).join('') || '<div class="empty">No Foundations yet.</div>';
  appEl.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => viewFoundation(b.dataset.open)));

  $('fd-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('fd-name').value.trim().slice(0, 80), contact = $('fd-contact').value.trim().slice(0, 80);
    const email = $('fd-email').value.trim().toLowerCase();
    if (!name) return flash('Enter the Foundation’s name.', 'bad');
    if (email && !EMAIL_RE.test(email)) return flash('That contact email doesn’t look right.', 'bad');
    if (providers.some(p => String(p.name).toLowerCase() === name.toLowerCase())) return flash(`There’s already a Foundation called ${name}.`, 'bad');
    // Its id: from the name, never "demo-…" (reserved for the demo), never a clash.
    let id = slugify(name).replace(/^demo-/, '');
    for (let n = 2; providers.some(p => p.id === id); n++) id = `${slugify(name).replace(/^demo-/, '')}-${n}`;
    const btn = $('fd-go'); btn.disabled = true;
    try {
      const zero = Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => ['s' + n, { runs: 0, pledges: 0, last_run_at: null }]));
      await setDoc(doc(db, 'providers', id), { name, active: true, max_students: 96, demo: false, session_stats: zero,
        created_at: serverTimestamp(), updated_at: serverTimestamp() });
      await setDoc(doc(db, 'providers_private', id), { contact_name: contact, contact_email: email, registered_at: serverTimestamp(), demo: false });
      viewFoundation(id, `${name} created. Now add its facilitators.`);
    } catch (err) {
      console.error('[TFT26] could not create the Foundation', err);
      flash('Couldn’t create the Foundation.', 'bad'); btn.disabled = false;
    }
  });
}

async function viewFoundation(id, note) {
  render('v-foundation');
  navOn('foundations');
  $('fv-back').addEventListener('click', e => { e.preventDefault(); viewFoundations(); });
  if (role !== 'admin') { $('fv-body').innerHTML = '<div class="empty">Only admins can manage Foundations.</div>'; return; }
  const me = (currentUser()?.email || $('ab-user').textContent || '').toLowerCase();
  const flash = (text, kind = 'ok') => { const m = $('fv-msg'); m.textContent = text; m.className = 'us-msg ' + kind; };
  let p, priv, people;
  async function load() {
    const [pSnap, privSnap, staffSnap] = await Promise.all([
      getDoc(doc(db, 'providers', id)), getDoc(doc(db, 'providers_private', id)),
      getDocs(collection(db, 'staff'))
    ]);
    p = pSnap.exists() ? pSnap.data() : null;
    priv = privSnap.exists() ? privSnap.data() : {};
    people = staffSnap.docs.map(d => d.data()).filter(x => x.role === 'facilitator' && x.provider === id)
      .sort((a, b) => (b.active === true) - (a.active === true) || String(a.name || a.email).localeCompare(String(b.name || b.email)));
  }
  try { await load(); } catch (e) { console.error(e); $('fv-body').innerHTML = '<div class="empty">Couldn’t load this Foundation.</div>'; return; }
  if (!$('fv-body')) return;
  if (!p) { $('fv-body').innerHTML = '<div class="empty">That Foundation doesn’t exist.</div>'; return; }

  $('fv-title').textContent = p.name || id;
  $('fv-demo').classList.toggle('hidden', p.demo !== true);
  $('fv-name').value = p.name || '';
  $('fv-contact').value = priv.contact_name || '';
  $('fv-email').value = priv.contact_email || '';
  if (note) flash(note);

  $('fv-save').addEventListener('click', async () => {
    const name = $('fv-name').value.trim().slice(0, 80), contact = $('fv-contact').value.trim().slice(0, 80);
    const email = $('fv-email').value.trim().toLowerCase();
    if (!name) return flash('The Foundation needs a name.', 'bad');
    if (email && !EMAIL_RE.test(email)) return flash('That contact email doesn’t look right.', 'bad');
    try {
      await setDoc(doc(db, 'providers', id), { name, updated_at: serverTimestamp() }, { merge: true });
      await setDoc(doc(db, 'providers_private', id), { contact_name: contact, contact_email: email }, { merge: true });
      $('fv-title').textContent = name; flash('Saved.');
    } catch (e) { console.error(e); flash('Couldn’t save the changes.', 'bad'); }
  });

  function paint() {
    $('fv-count').textContent = `${people.filter(x => x.active).length} active`;
    $('fv-list').innerHTML = people.length ? people.map(x => `<tr class="${x.active ? '' : 'off'}">
        <td><strong>${esc(x.name || '—')}</strong> ${x.demo ? '<span class="pill none">Demo</span>' : ''}<div class="muted us-email">${esc(x.email)}</div></td>
        <td>${x.active ? '<span class="pill ok">On</span>' : '<span class="pill none">Off</span>'}</td>
        <td class="muted us-when">${x.added_at ? when(x.added_at) : '—'}${x.added_by ? '<br>by ' + esc(x.added_by) : ''}</td>
        <td class="us-acts">${x.demo
          ? `<span class="muted fv-persona">${DEMO_PERSONAS[x.email] ? `Demo login on the facilitator portal: <code>${esc(x.email)}</code> / <code>${DEMO_PERSONAS[x.email]}</code>` : 'Fictional — doesn’t sign in'}</span>`
          : `<button class="btn ghost" data-resend="${esc(x.email)}" ${x.active ? '' : 'disabled'}>Resend link</button>
          <button class="btn ${x.active ? 'ghost danger-text' : 'secondary'}" data-toggle="${esc(x.email)}">${x.active ? 'Switch off' : 'Switch on'}</button>`}</td>
      </tr>`).join('') : '<tr><td colspan="4"><div class="empty">No facilitators yet.</div></td></tr>';
    appEl.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const x = people.find(y => y.email === b.dataset.toggle);
      if (x.active && await askConfirm({ title: `Switch off ${x.name || x.email}?`,
          body: 'They won’t be able to sign in or see anything. You can switch them back on at any time.',
          confirm: 'Switch off', danger: true }) !== 'confirm') return;
      try {
        await setDoc(doc(db, 'staff', x.email), { ...x, active: !x.active, updated_by: me, updated_at: serverTimestamp() });
        await load(); paint(); flash(x.active ? `${x.name || x.email} is switched off.` : `${x.name || x.email} is switched back on.`);
      } catch (e) { console.error(e); flash('Couldn’t save that change.', 'bad'); }
    }));
    appEl.querySelectorAll('[data-resend]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await sendPasswordReset(b.dataset.resend); flash(`Sent a new set-password link to ${b.dataset.resend}.`); }
      catch (e) { console.error(e); flash('Couldn’t send the link. Try again in a minute.', 'bad'); }
      b.disabled = false;
    }));
  }
  paint();
  $('fv-deliveries').addEventListener('click', e => { e.preventDefault(); viewProvider(id); });
  paintActivity(id).catch(e => { console.error(e); if ($('fv-cohorts')) $('fv-cohorts').innerHTML = '<div class="empty">Couldn’t load the cohorts.</div>'; });

  $('fv-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('fv-new-email').value.trim().toLowerCase(), name = $('fv-new-name').value.trim().slice(0, 80);
    if (!EMAIL_RE.test(email)) return flash('Enter a valid email address.', 'bad');
    if (!name) return flash('Enter their name.', 'bad');
    if (email === me) return flash('That’s you.', 'bad');
    const existing = (await getDoc(doc(db, 'staff', email))).data();
    if (existing) {
      return flash(existing.role === 'facilitator' && existing.provider === id
        ? `${email} is already a facilitator here.`
        : `${email} is already on the people list (${existing.role}). Change them on the Users page.`, 'bad');
    }
    const btn = $('fv-go'); btn.disabled = true; btn.textContent = 'Adding…';
    try {
      await setDoc(doc(db, 'staff', email), { email, name, role: 'facilitator', provider: id, active: true, added_by: me, added_at: serverTimestamp() });
      const { created } = await inviteAccount(email);
      $('fv-add').reset();
      await load(); paint();
      flash(created ? `Added ${name}. They’ve been emailed a link to set their password.`
                    : `${name} already had an account — they’re now a facilitator here, and have been emailed a link to set their password.`);
    } catch (err) {
      console.error('[TFT26] could not add the facilitator', err);
      flash(err?.code?.startsWith?.('auth/') ? 'They’re on the list, but the email couldn’t be sent. Use “Resend link”.'
          : 'Couldn’t add them. Check the details and try again.', 'bad');
      await load().catch(() => {}); paint();
    }
    btn.disabled = false; btn.textContent = 'Add and email invite';
  });
}

// ─── A Foundation's cohorts, groups and delivery ─────────────────────────────
/** The demo facilitator portal's persona logins (wp-emulator.js). */
const DEMO_PERSONAS = { 'alex@democollege.ac.uk': 'tftdemo', 'sam@demoacademy.ac.uk': 'tftdemo' };

/**
 * Everything the Foundation's facilitators have set up and delivered, from the
 * database: each cohort (and its school), each group with its size, its
 * baseline survey, sessions 1–6 and final survey — the same squares as the
 * facilitator's dashboard. A delivered session opens its pledges; a survey
 * opens that group on the Evaluation page. Names never appear: the database
 * only has pseudonymous student slots, so sizes are counts.
 */
async function paintActivity(id) {
  const [cohSnap, runSnap, svSnap] = await Promise.all([
    getDocs(collection(db, 'providers', id, 'cohorts')),
    getDocs(collection(db, 'providers', id, 'runs')),
    getDocs(collection(db, 'providers', id, 'surveys'))
  ]);
  const cohorts = await Promise.all(cohSnap.docs.map(async c => {
    const g = await getDocs(collection(db, 'providers', id, 'cohorts', c.id, 'groups'));
    return { id: c.id, ...c.data(), groups: g.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
  }));
  const runs = runSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const surveys = Object.fromEntries(svSnap.docs.map(d => [d.id, d.data()]));
  if (!$('fv-cohorts')) return;
  cohorts.sort((a, b) => String(a.label).localeCompare(String(b.label)));

  const delivered = (r) => r.status === 'closed' && (r.pledge_count || 0) > 0;
  const last = (rs) => Math.max(0, ...rs.map(r => r.started_at?.seconds || 0));
  $('fv-cstat').textContent = `${cohorts.length} cohort${cohorts.length === 1 ? '' : 's'} · ${cohorts.reduce((a, c) => a + c.groups.length, 0)} groups · ${runs.filter(delivered).length} sessions delivered`;
  $('fv-cohorts').innerHTML = cohorts.length ? cohorts.map(c => `
    <div class="card fc">
      <div class="fc-head"><strong>${esc(c.label || c.id)}</strong>
        <span class="muted">${[c.school, (c.student_count ?? '?') + ' students'].filter(Boolean).map(esc).join(' · ')}</span></div>
      ${c.groups.map(g => {
        const mine = runs.filter(r => r.cohort_id === c.id && r.group_id === g.id);
        const cell = (n) => {
          const done = mine.filter(r => r.session === n && delivered(r)).sort((a, b) => (b.started_at?.seconds || 0) - (a.started_at?.seconds || 0))[0];
          const open = mine.find(r => r.session === n && r.status === 'open');
          const r = done || open;
          const tip = done ? `Session ${n}: delivered ${when(done.started_at)}, ${done.pledge_count} pledges` : open ? `Session ${n}: in progress` : `Session ${n}: not yet`;
          return r ? `<button class="fc-c ${done ? 'done' : 'live'}" data-run="${esc(r.id)}" data-session="${n}" title="${esc(tip)}">${done ? '✓' : n}</button>`
                   : `<span class="fc-c" title="${esc(tip)}">${n}</span>`;
        };
        const sv = (phase) => {
          const s = surveys[`${c.id}__${g.id}__${phase}`];
          const label = phase === 'baseline' ? 'B' : 'F';
          return s ? `<button class="fc-c sv done" data-eval="${esc(c.id)}|${esc(g.id)}" title="${phase === 'baseline' ? 'Baseline' : 'Final'} survey: ${when(s.created_at)}, ${s.present} taking part">${label}</button>`
                   : `<span class="fc-c sv" title="${phase === 'baseline' ? 'Baseline' : 'Final'} survey: not yet">${label}</span>`;
        };
        const pledges = mine.reduce((a, r) => a + (r.pledge_count || 0), 0);
        return `<div class="fc-row">
          <div class="fc-g">${esc(g.label || g.id)}<span class="muted">${g.size ?? '?'} students${last(mine) ? ' · last ' + when({ seconds: last(mine) }) : ''}</span></div>
          <div class="fc-cells">${sv('baseline')}<i></i>${[1, 2, 3, 4, 5, 6].map(cell).join('')}<i></i>${sv('final')}</div>
          <div class="muted fc-p">${pledges} pledge${pledges === 1 ? '' : 's'}</div>
        </div>`;
      }).join('')}
    </div>`).join('')
    : '<div class="empty">No cohorts yet. They appear here when a facilitator sets one up and starts delivering.</div>';

  appEl.querySelectorAll('#fv-cohorts [data-run]').forEach(b => b.addEventListener('click', () => viewRun(id, b.dataset.run, b.dataset.session)));
  appEl.querySelectorAll('#fv-cohorts [data-eval]').forEach(b => b.addEventListener('click', () => {
    const [cid, gid] = b.dataset.eval.split('|');
    Object.assign(evalState, { provider: id, cohort: cid, group: gid });
    viewEval();
  }));
}
