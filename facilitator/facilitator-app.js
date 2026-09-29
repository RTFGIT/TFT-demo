/**
 * facilitator-app.js — the facilitator pathway, start to finish.
 *
 *   #/login
 *   #/dashboard                            every cohort & group at a glance; manage cohorts
 *   #/cohort/:c                            groups & students within one cohort
 *   #/cohort/:c/sessions                   pick a session for this cohort
 *   #/cohort/:c/session/:n                 details + pick a group
 *   #/cohort/:c/session/:n/video
 *   #/cohort/:c/session/:n/pledge          capture, one student at a time
 *   #/cohort/:c/session/:n/complete
 *
 * ── COHORTS & GROUPS ────────────────────────────────────────────────────────
 * A provider (institution / club) has MANY cohorts. A cohort has one or more
 * groups (teams). A run is one session delivered to one GROUP — which is why a
 * provider with four groups delivers each session four times.
 *
 * ── MULTI-FACILITATOR ───────────────────────────────────────────────────────
 * Two or more facilitators may sign in with the SAME account on different
 * devices at once. Each device carries its own active run in its own
 * localStorage, so they never collide — and because runs are group-scoped, one
 * facilitator can take Group 1 while another takes Group 2 of the same cohort.
 * The details screen marks any group with a currently-open run "in progress",
 * read from the shared Firestore, so concurrent facilitators can coordinate.
 *
 * ── WORDPRESS COMPATIBILITY ────────────────────────────────────────────────
 * Every screen is a real route mapping to a permalink (WP_ROUTES). No screen
 * assumes it was reached from the previous one — each re-derives its state from
 * the URL plus persisted data, so deep links, the back button and a hard
 * refresh all work. Roster access goes through the wp-* API only, shaped like a
 * WP REST namespace, so swapping to real endpoints touches one module.
 *
 * ── THE PRIVACY SEAM ───────────────────────────────────────────────────────
 * This module is "WordPress" and holds the only real names. It passes a
 * student's name to the widget by postMessage (display only) and the
 * pseudonymous ref via the iframe URL (for storage). The widget writes the ref.
 */

import {
  wpSignIn, wpSignOut, wpCurrentUser, wpAccounts, wpSessionPage, wpSessionPages,
  wpCohorts, wpHasAnyCohort, wpGetCohort, wpCreateCohort, wpRenameCohort, wpDeleteCohort,
  wpGroups, wpAddGroup, wpRenameGroup, wpRemoveGroup,
  wpAddStudent, wpRemoveStudent, wpRoster, wpCapStatus, WP_ROUTES
} from '../wp-emulator.js';
import {
  initializeApp, getFirestore, doc, getDoc, setDoc, updateDoc, addDoc,
  collection, getDocs, serverTimestamp, runTransaction, increment,
  getAuth, signInWithEmailAndPassword, signOut, MODE, currentUser
} from '../data-layer.js';
import * as sessionConfig from '../public_widget/session-config.js';
const { SESSION_COUNT, EXPECTED_GROUPS, OWN_SUGGESTION_INDEX } = sessionConfig;
// Read defensively: a browser holding a cached older session-config.js (GitHub
// Pages caches for ~10 min after a deploy) must not stop the portal loading.
const SESSION_PARTS = sessionConfig.SESSION_PARTS || {
  film: { label: 'Watch & respond', how: '' }, classroom: { label: 'Classroom task', how: '' },
  physical: { label: 'Physical task', how: '' }, pledge: { label: 'Pledge to the planet', how: '' } };

const app = initializeApp({ projectId: 'tft26-local' });
const db  = getFirestore(app);

const LS_RUN = 'tft26_active_run_v1';       // per-device; survives a refresh mid-delivery
const appEl  = document.getElementById('app');
const $      = (id) => document.getElementById(id);
const esc    = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();

let user = null;

// ─── Route builders ──────────────────────────────────────────────────────────
const H = {
  login:    ()      => '#/login',
  dashboard:()      => '#/dashboard',
  cohort:   (c)     => `#/cohort/${c}`,
  sessions: (c)     => `#/cohort/${c}/sessions`,
  detail:   (c, n)  => `#/cohort/${c}/session/${n}`,
  video:    (c, n)  => `#/cohort/${c}/session/${n}/video`,
  pledge:   (c, n)  => `#/cohort/${c}/session/${n}/pledge`,
  complete: (c, n)  => `#/cohort/${c}/session/${n}/complete`
};

// ─── Active-run persistence (per device) ─────────────────────────────────────
const activeRun = {
  get()  { try { return JSON.parse(localStorage.getItem(LS_RUN)); } catch { return null; } },
  set(v) { localStorage.setItem(LS_RUN, JSON.stringify(v)); },
  clear(){ localStorage.removeItem(LS_RUN); }
};

// ─── Chrome ──────────────────────────────────────────────────────────────────
function permalinkForHash(hash) {
  for (const r of Object.values(WP_ROUTES)) {
    const rx = new RegExp('^' + r.hash.replace(':c', '([^/]+)').replace(':n', '(\\d+)') + '$');
    const m = hash.match(rx);
    if (!m) continue;
    let out = r.permalink, gi = 1;
    if (r.hash.includes(':c')) out = out.replace(':c', decodeURIComponent(m[gi++]));
    if (r.hash.includes(':n')) out = out.replace(':n', m[gi++]);
    return out;
  }
  return '';
}
function setChrome() {
  $('wp-user').textContent = user ? `${user.display_name} · ${user.provider_name}` : '';
  $('wp-signout').classList.toggle('hidden', !user);
  $('wp-dash').classList.toggle('hidden', !user);
  $('wp-dash').classList.toggle('on', location.hash === '#/dashboard');
  $('wp-route').textContent = permalinkForHash(location.hash || '');
}
function show(templateId) {
  appEl.innerHTML = '';
  appEl.appendChild(document.getElementById(templateId).content.cloneNode(true));
  setChrome();
}

/** "Term: definition" items get the term in bold (e.g. the Match Time cards). */
const termify = (t) => {
  const m = String(t).match(/^([A-Z][A-Za-z ’']{1,24}): (.+)$/);
  return m ? `<strong>${esc(m[1])}:</strong> ${esc(m[2])}` : esc(t);
};
/** A task's instructions: optional sub-headings, each with a bullet list. */
const renderBlocks = (blocks = []) => blocks.map(b =>
  (b.heading ? `<div class="blk-h">${esc(b.heading)}</div>` : '') +
  `<ul class="blk">${(b.items || []).map(i => `<li>${termify(i)}</li>`).join('')}</ul>`).join('');

/** The 4-step rail across plan → run → pledges → complete. */
function rail(el, step) {
  if (!el) return;
  const steps = ['Session plan', 'Run the session', 'Pledges', 'Done'];
  el.innerHTML = steps.map((s, i) => {
    const cls = i < step ? 'done' : i === step ? 'on' : '';
    const mark = i < step ? '✓' : (i + 1);
    return `<span class="s ${cls}"><span class="dot">${mark}</span>${s}</span>`
         + (i < steps.length - 1 ? '<span class="bar"></span>' : '');
  }).join('');
}

// ═══ 1. LOGIN ════════════════════════════════════════════════════════════════
function viewLogin() {
  show('v-login');
  // One tap signs in as a demo facilitator — the fastest way into a walkthrough.
  $('li-accounts').innerHTML = wpAccounts().map(a => `
    <button class="acct" data-email="${esc(a.email)}" data-pass="${esc(a.password)}">
      <span class="av">${esc(initial(a.display_name || a.email))}</span>
      <span class="grow"><strong>${esc(a.display_name || a.email)}</strong> · ${esc(a.provider)}<br>
        <small>${esc(a.email)} / ${esc(a.password)}</small></span>
      <span class="muted">→</span>
    </button>`).join('');
  appEl.querySelectorAll('[data-email]').forEach(b => b.addEventListener('click', () => {
    $('li-email').value = b.dataset.email;
    $('li-pass').value = b.dataset.pass;
    go();
  }));
  const go = async () => {
    const email = $('li-email').value.trim(), password = $('li-pass').value;
    try {
      user = wpSignIn(email, password);
    } catch {
      return loginError('Those credentials were not recognised.');
    }
    // LIVE: also sign in to Firebase as this facilitator. The Firebase account
    // carries the `provider` claim the security rules check on every write.
    // (Stand-in for the production /firebase-token hand-off in WORDPRESS_BUILD.md.)
    if (MODE === 'live') {
      try { await signInWithEmailAndPassword(getAuth(), email, password); }
      catch (e) {
        wpSignOut(); user = null;
        return loginError('Live mode: could not sign in to the shared database (' + (e.code || e.message) + ').');
      }
    }
    setChrome();
    go2(H.dashboard());
  };
  function loginError(msg) {
    $('li-err').textContent = msg;
    $('li-err').classList.remove('hidden');
  }
  $('li-go').addEventListener('click', go);
  $('li-pass').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// ═══ Progress helpers ═══════════════════════════════════════════════════════
/** A session counts as delivered to a group once a finished run captured pledges.
 *  (A run finished with nobody pledging doesn't tick the session off.) */
const delivered = (r) => r.status === 'closed' && (r.pledge_count || 0) > 0;

/**
 * How far a cohort has got. A session is "done" once every group has a closed
 * run of it, "part" once at least one group has. `next` is the first session
 * that isn't done (null when all six are).
 */
function cohortProgress(cid, groups, runs) {
  const mine = runs.filter(r => r.cohort_id === cid);
  const gids = groups.map(g => g.id);
  const perSession = [];
  for (let n = 1; n <= SESSION_COUNT; n++) {
    const closed = new Set(mine.filter(r => r.session === n && delivered(r)).map(r => r.group_id));
    const hit = gids.filter(g => closed.has(g)).length;
    perSession.push(gids.length && hit === gids.length ? 'done' : hit > 0 ? 'part' : '');
  }
  const i = perSession.findIndex(s => s !== 'done');
  return {
    perSession,
    done: perSession.filter(s => s === 'done').length,
    next: i >= 0 ? i + 1 : null,
    pledges: mine.reduce((a, r) => a + (r.pledge_count || 0), 0),
    last: Math.max(0, ...mine.map(r => r.started_at?.seconds || 0))
  };
}
const ago = (secs) => {
  if (!secs) return '';
  const d = Math.round((Date.now() / 1000 - secs) / 86400);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 14 ? `${d} days ago` : `${Math.round(d / 7)} weeks ago`;
};
// A short badge for a cohort: 'Year 9 Rugby' -> Y9, 'U12s' -> U12, 'Girls Academy' -> GA.
const badge = (s) => {
  const num = (s.match(/\d+/) || [''])[0];
  const letters = s.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase();
  return num ? (letters[0] || '#') + num : letters.slice(0, 2) || '?';
};

// ═══ 2. DASHBOARD — every cohort and group at a glance ═══════════════════════
/**
 * The facilitator's home, built for someone running many groups that started at
 * different times. Each group is its own colour-keyed tile with six session
 * squares and ONE action:
 *
 *   "Deliver Session 4 →"   starts delivery for THAT group straight away (no
 *                           second "which group?" question)
 *   any undelivered square  delivers that session instead — out of order is fine
 *   a delivered square      opens the session's details (to review or re-run)
 *
 * Anything stalled or left open floats to the top as needing attention. All of
 * it is derived from the WordPress roster + the provider's runs; nothing extra
 * is stored.
 */
const DAY_S = 86400;
const STALE_DAYS = 14;          // no session for this long → needs attention
const LEFT_OPEN_HOURS = 3;      // an open run older than this was probably never finished
const LS_PICK = 'tft26_pick_group';   // hands a chosen group to the session-details screen
const fmtDay = (secs) => secs ? new Date(secs * 1000).toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short' }) : '';
const nowSecs = () => Math.floor(Date.now() / 1000);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Filter + search survive moving between screens (this tab only).
const dashState = { filter: 'all', q: '' };

/** Where one group is up to: a state per session, the suggested next one, last activity. */
function groupProgress(cid, gid, runs) {
  const mine = runs.filter(r => r.cohort_id === cid && r.group_id === gid);
  const cells = [];
  for (let n = 1; n <= SESSION_COUNT; n++) {
    const done = mine.find(r => r.session === n && delivered(r));
    const open = mine.find(r => r.session === n && r.status === 'open');
    cells.push({ n, state: done ? 'done' : open ? 'live' : '', run: done || open || null });
  }
  const i = cells.findIndex(c => c.state !== 'done');
  if (i >= 0 && cells[i].state === '') cells[i].state = 'next';
  return {
    cells,
    next: i >= 0 ? i + 1 : null,
    done: cells.filter(c => c.state === 'done').length,
    last: Math.max(0, ...mine.map(r => r.started_at?.seconds || 0)),
    leftOpen: mine.filter(r => r.status === 'open' && nowSecs() - (r.started_at?.seconds || 0) > LEFT_OPEN_HOURS * 3600)
  };
}

/** complete · attention · active · new — plus the reason when it needs attention. */
function cohortStatus(gps) {
  const done = gps.reduce((a, g) => a + g.done, 0);
  if (gps.length && done === gps.length * SESSION_COUNT) return { key: 'complete' };
  if (!gps.some(g => g.last > 0)) return { key: 'new' };
  const leftOpen = gps.flatMap(g => g.leftOpen);
  if (leftOpen.length) return { key: 'attention', why: `Session ${leftOpen[0].session} left open since ${fmtDay(leftOpen[0].started_at?.seconds)}` };
  const days = Math.floor((nowSecs() - Math.max(...gps.map(g => g.last))) / DAY_S);
  if (days > STALE_DAYS) return { key: 'attention', why: `No session for ${Math.round(days / 7)} weeks` };
  return { key: 'active' };
}

const STATUS_PILL = {
  complete:  '<span class="pill ok">Complete</span>',
  active:    '<span class="pill live">In progress</span>',
  attention: '<span class="pill warn">Needs attention</span>',
  new:       '<span class="pill none">Not started</span>'
};
const STATUS_RANK = { attention: 0, active: 1, new: 2, complete: 3 };

/** Open a session's details with a particular group already chosen. */
function openSessionFor(cid, gid, n) {
  try { sessionStorage.setItem(LS_PICK, JSON.stringify({ cid, gid })); } catch {}
  go2(H.detail(cid, n));
}

async function viewDashboard() {
  show('v-dashboard');
  const pid = user.provider_id;
  $('db-provider').textContent = user.provider_name;
  let allRunsHere = [];
  try { allRunsHere = await allRuns(); } catch (e) { console.warn('[TFT26] runs unavailable', e); }
  if (!$('db-list')) return;                                   // navigated away while loading
  const here = activeRun.get();
  // Only runs for cohorts still on the roster — a deleted cohort's history stays
  // in the database (and the admin console) but no longer clutters this view.
  let runs = [];
  const syncRuns = () => {
    const known = new Set(wpCohorts(pid).map(c => c.cohort_id));
    runs = allRunsHere.filter(r => known.has(r.cohort_id));
  };

  function model() {
    return wpCohorts(pid).map(c => {
      const groups = wpGroups(pid, c.cohort_id).map((g, i) => ({
        ...g, colour: `var(--group-${(i % 6) + 1})`,
        size: wpRoster(pid, c.cohort_id, g.id).length,
        p: groupProgress(c.cohort_id, g.id, runs)
      }));
      const gps = groups.map(g => g.p);
      return {
        ...c, groups,
        status: cohortStatus(gps),
        done: gps.reduce((a, g) => a + g.done, 0),
        total: groups.length * SESSION_COUNT,
        last: Math.max(0, ...gps.map(g => g.last))
      };
    });
  }

  // ── One sentence of summary + anything happening right now ──
  function paintSummary(cohorts) {
    const first = (user.display_name || '').split(' ')[0];
    const students = cohorts.reduce((a, c) => a + c.students, 0);
    const pledges = runs.reduce((a, r) => a + (r.pledge_count || 0), 0);
    $('db-hello').textContent = cohorts.length
      ? `Hi ${first} — ${plural(cohorts.length, 'cohort')}, ${plural(students, 'student')}, ${plural(pledges, 'pledge')} so far.`
      : `Hi ${first} — let’s set up your first cohort.`;

    const label = (r) => {
      const c = cohorts.find(x => x.cohort_id === r.cohort_id);
      const g = c?.groups.find(x => x.id === r.group_id);
      return `${c ? c.label : r.cohort_id} · ${g ? g.label : r.group_id}`;
    };
    $('db-livestrip').innerHTML = runs.filter(r => r.status === 'open').map(r => {
      const started = r.started_at?.seconds || 0;
      const mins = Math.max(1, Math.round((nowSecs() - started) / 60));
      if (nowSecs() - started > LEFT_OPEN_HOURS * 3600) {
        return `<div class="stale"><span class="dot"></span><span><strong>${esc(label(r))}</strong> — Session ${r.session} was started ${fmtDay(started)} and never finished. <a href="${H.detail(r.cohort_id, r.session)}">Open it →</a></span></div>`;
      }
      const where = here && here.runId === r.id
        ? `on this device — <a href="${H.pledge(r.cohort_id, r.session)}">resume →</a>` : 'on another device';
      return `<div><span class="dot"></span><span><strong>${esc(label(r))}</strong> — Session ${r.session} live now (started ${mins < 90 ? mins + ' min' : Math.round(mins / 60) + ' h'} ago), ${where}</span></div>`;
    }).join('');
  }

  function paintFilters(cohorts) {
    const count = (k) => k === 'all' ? cohorts.length
      : k === 'active' ? cohorts.filter(c => c.status.key === 'active' || c.status.key === 'attention').length
      : cohorts.filter(c => c.status.key === k).length;
    const chips = [['all', 'All'], ['attention', 'Needs attention'], ['active', 'In progress'], ['new', 'Not started'], ['complete', 'Complete']];
    $('db-filters').innerHTML = chips.filter(([k]) => k === 'all' || count(k) > 0).map(([k, t]) =>
      `<button data-filter="${k}" aria-pressed="${dashState.filter === k}">${t}<span>${count(k)}</span></button>`).join('');
    appEl.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { dashState.filter = b.dataset.filter; paint(); }));
  }

  // ── A group: name · six squares · one action ──
  function groupTile(c, g) {
    const p = g.p;
    const title = (n) => wpSessionPage(n)?.title || '';
    const cells = p.cells.map(cell => {
      const tip = cell.state === 'done' ? `Session ${cell.n} · ${title(cell.n)} — delivered ${fmtDay(cell.run.started_at?.seconds)}, ${plural(cell.run.pledge_count || 0, 'pledge')}. Tap to review.`
                : cell.state === 'live' ? `Session ${cell.n} · ${title(cell.n)} — being delivered now`
                : `Deliver Session ${cell.n} · ${title(cell.n)} to ${g.label}`;
      const act = cell.state === 'done' || cell.state === 'live' ? 'view' : 'deliver';
      return `<button class="cell ${cell.state}" data-${act}="${esc(c.cohort_id)}|${esc(g.id)}|${cell.n}"
        title="${esc(tip)}" aria-label="${esc(tip)}">${cell.state === 'done' ? '✓' : cell.n}</button>`;
    }).join('');

    const live = p.cells.find(x => x.state === 'live');
    const staleDays = p.last ? Math.floor((nowSecs() - p.last) / DAY_S) : 0;
    const meta = g.size === 0 ? 'No students yet'
               : p.next !== null && staleDays > STALE_DAYS ? `<span class="stale">Last session ${Math.round(staleDays / 7)} weeks ago</span>`
               : plural(g.size, 'student');
    let action;
    if (g.size === 0) action = `<div class="go"><button class="btn secondary" data-manage="${esc(c.cohort_id)}">Add students</button></div>`;
    else if (p.next === null) action = `<div class="alldone">All six done ✓</div>`;
    else if (live) action = `<div class="go"><button class="btn secondary" data-view="${esc(c.cohort_id)}|${esc(g.id)}|${live.n}">Session ${live.n} is live</button></div>`;
    else action = `<div class="go"><button class="btn" data-deliver="${esc(c.cohort_id)}|${esc(g.id)}|${p.next}"
        title="Deliver Session ${p.next} · ${esc(title(p.next))} to ${esc(g.label)}">${p.done === 0 ? 'Start' : 'Deliver'} Session ${p.next} →</button></div>`;

    return `<div class="gtile" style="--g:${g.colour}">
      <div class="gname"><i></i><div>${esc(g.label)}<small>${meta}</small></div></div>
      <div class="cells">${cells}</div>
      ${action}
    </div>`;
  }

  function panel(c) {
    const pct = c.total ? Math.round(c.done / c.total * 100) : 0;
    return `<div class="cpanel">
      <div class="cpanel-head">
        <div class="icon">${esc(badge(c.label))}</div>
        <div class="grow">
          <div class="ttl">${esc(c.label)} ${STATUS_PILL[c.status.key]}</div>
          <div class="sub">${plural(c.groups.length, 'group')} · ${plural(c.students, 'student')}${c.status.why ? ` · <strong style="color:var(--warn)">${esc(c.status.why)}</strong>` : ''}</div>
        </div>
        <div class="acts">
          <button class="btn secondary" data-manage="${esc(c.cohort_id)}">Manage</button>
          <button class="btn ghost" data-delcohort="${esc(c.cohort_id)}" title="Delete cohort" aria-label="Delete ${esc(c.label)}">✕</button>
        </div>
      </div>
      <div class="cpanel-bar" title="${pct}% delivered"><i style="width:${pct}%"></i></div>
      <div class="gtiles">${c.groups.map(g => groupTile(c, g)).join('')}</div>
    </div>`;
  }

  function paint() {
    syncRuns();
    const all = model();
    paintSummary(all);
    paintFilters(all);
    const q = dashState.q.trim().toLowerCase();
    const list = all.filter(c =>
      (dashState.filter === 'all'
        || (dashState.filter === 'active' ? ['active', 'attention'].includes(c.status.key) : c.status.key === dashState.filter))
      && (!q || c.label.toLowerCase().includes(q) || c.groups.some(g => g.label.toLowerCase().includes(q))))
      .sort((a, b) => STATUS_RANK[a.status.key] - STATUS_RANK[b.status.key] || b.last - a.last);

    // No cohorts at all: one unmistakable "add your first cohort" panel, with the
    // name box right there — nothing else on the list side competes with it.
    const empty = all.length === 0;
    appEl.querySelector('.dash').classList.toggle('empty', empty);
    $('db-newbtn').classList.toggle('hidden', empty);
    if (empty) openNew(false);
    $('db-list').innerHTML = empty ? `
      <div class="first-cohort">
        <div class="ic" aria-hidden="true">+</div>
        <h2>Add your first cohort</h2>
        <p>A cohort is a class, year group or club squad you’ll take through the six sessions —
           like “Year 9 Rugby” or “U12s”. You’ll add its groups and students next.</p>
        <div class="add">
          <input type="text" id="db-first" placeholder="Cohort name, e.g. Year 9 Rugby" aria-label="Cohort name">
          <button class="btn new-btn" id="db-firstadd"><span class="plus" aria-hidden="true">+</span>Add cohort</button>
        </div>
        <ol><li>Name the cohort</li><li>Add groups &amp; students</li><li>Deliver Session 1</li></ol>
      </div>`
      : list.length === 0 ? '<div class="empty">No cohorts match.</div>'
      : list.map(panel).join('');
    if (empty) {
      const addFirst = () => create($('db-first').value);
      $('db-firstadd').addEventListener('click', addFirst);
      $('db-first').addEventListener('keydown', e => { if (e.key === 'Enter') addFirst(); });
    }

    const parse = (v) => { const [cid, gid, n] = v.split('|'); return [cid, gid, Number(n)]; };
    appEl.querySelectorAll('#db-list [data-deliver]').forEach(b => b.addEventListener('click', () => { const [cid, gid, n] = parse(b.dataset.deliver); beginDelivery(cid, n, gid); }));
    appEl.querySelectorAll('#db-list [data-view]').forEach(b => b.addEventListener('click', () => openSessionFor(...parse(b.dataset.view))));
    appEl.querySelectorAll('#db-list [data-manage]').forEach(b => b.addEventListener('click', () => go2(H.cohort(b.dataset.manage))));
    appEl.querySelectorAll('#db-list [data-delcohort]').forEach(b => b.addEventListener('click', () => {
      const c = all.find(x => x.cohort_id === b.dataset.delcohort);
      if (confirm(`Delete "${c.label}" and its roster? This does not remove any pledges already captured.`)) {
        wpDeleteCohort(pid, b.dataset.delcohort); paint();
      }
    }));
  }

  // ── Toolbar + new cohort ──
  function openNew(on) {
    $('db-newrow').classList.toggle('hidden', !on);
    $('db-newbtn').setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) $('db-new').focus();
  }
  function create(label) {
    label = String(label || '').trim();
    if (!label) return;
    const c = wpCreateCohort(pid, label);
    go2(H.cohort(c.cohort_id));      // straight into adding groups and students
  }
  $('db-search').value = dashState.q;
  $('db-search').addEventListener('input', e => { dashState.q = e.target.value; paint(); });
  $('db-newbtn').addEventListener('click', () => openNew($('db-newrow').classList.contains('hidden')));
  $('db-cancel').addEventListener('click', () => openNew(false));
  $('db-add').addEventListener('click', () => create($('db-new').value));
  $('db-new').addEventListener('keydown', e => { if (e.key === 'Enter') create($('db-new').value); if (e.key === 'Escape') openNew(false); });
  paint();
}

// ═══ 3. MANAGE ONE COHORT — groups & students ════════════════════════════════
function viewCohort(cid) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  if (!cohort) return go2(H.dashboard());

  show('v-cohort');
  $('mc-provider').textContent = user.provider_name;
  $('mc-title').textContent = cohort.label;
  $('mc-label').value = cohort.label;
  $('mc-crumb').setAttribute('href', H.dashboard());
  $('mc-label').addEventListener('change', () => {
    wpRenameCohort(pid, cid, $('mc-label').value.trim() || cohort.label);
    $('mc-title').textContent = wpGetCohort(pid, cid).label;
  });
  $('mc-addgroup').addEventListener('click', () => { wpAddGroup(pid, cid); paint(); });
  $('mc-done').addEventListener('click', async () => {
    $('mc-done').disabled = true; $('mc-done').textContent = 'Saving…';
    await mirrorCohort(pid, cid);
    go2(H.sessions(cid));
  });

  function paint() {
    const groups = wpGroups(pid, cid);
    $('mc-groups').innerHTML = groups.map(g => {
      const students = wpRoster(pid, cid, g.id);
      const soleGroupHint = groups.length === 1 ? ' <span class="muted" style="font-weight:400">· whole cohort</span>' : '';
      return `<div class="group-card" data-group="${esc(g.id)}">
        <div class="group-head">
          <input value="${esc(g.label)}" data-rename="${esc(g.id)}" aria-label="Group name">
          ${soleGroupHint}
          <span class="pill ${students.length ? 'ok' : 'none'}">${students.length}</span>
          ${groups.length > 1 ? `<button class="btn ghost" data-delgroup="${esc(g.id)}">Remove</button>` : ''}
        </div>
        <div class="group-body">
          ${students.map(s => `
            <div class="stu">
              <span class="av">${esc(initial(s.display_name))}</span>
              <span class="nm">${esc(s.display_name)}</span>
              <span class="ref">${esc(s.student_ref)}</span>
              <button class="x" data-del="${esc(s.student_ref)}" title="Remove">✕</button>
            </div>`).join('')}
          <div class="add-row">
            <input type="text" placeholder="Add student to ${esc(g.label)}…" data-add="${esc(g.id)}">
            <button class="btn secondary" data-addbtn="${esc(g.id)}">Add</button>
          </div>
        </div>
      </div>`;
    }).join('');

    const total = wpRoster(pid, cid).length;
    $('mc-count').textContent = `${total} student${total === 1 ? '' : 's'} across ${groups.length} group${groups.length === 1 ? '' : 's'}`;
    $('mc-done').disabled = total === 0;
    $('mc-done').textContent = 'Deliver sessions →';

    const cap = wpCapStatus(pid, cid);
    const msgs = [];
    cap.overSizedGroups.forEach(g => msgs.push(`${g.label} has ${g.count} students — more than the expected ${cap.groupSizeCap}.`));
    if (cap.tooManyGroups) msgs.push(`${cap.groups} groups — more than the expected ${EXPECTED_GROUPS}.`);
    if (msgs.length) {
      $('mc-warn').textContent = msgs.join(' ') + ' That is fine — these are soft limits, not blocks.';
      $('mc-warn').classList.remove('hidden');
    } else { $('mc-warn').classList.add('hidden'); }

    appEl.querySelectorAll('[data-addbtn]').forEach(b => b.addEventListener('click', () => addTo(b.dataset.addbtn)));
    appEl.querySelectorAll('[data-add]').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') addTo(i.dataset.add); }));
    appEl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { wpRemoveStudent(pid, cid, b.dataset.del); paint(); }));
    appEl.querySelectorAll('[data-delgroup]').forEach(b => b.addEventListener('click', () => {
      if (confirm('Remove this group? Its students move to the first remaining group.')) { wpRemoveGroup(pid, cid, b.dataset.delgroup); paint(); }
    }));
    appEl.querySelectorAll('[data-rename]').forEach(i => i.addEventListener('change', () => { wpRenameGroup(pid, cid, i.dataset.rename, i.value.trim() || 'Group'); paint(); }));
  }

  function addTo(groupId) {
    const input = appEl.querySelector(`[data-add="${groupId}"]`);
    const name = input.value.trim();
    if (!name) return;
    wpAddStudent(pid, cid, name, groupId);
    paint();
    const again = appEl.querySelector(`[data-add="${groupId}"]`);
    if (again) again.focus();
  }
  paint();
}

/**
 * Mirror one cohort to the Firebase side — PSEUDONYMOUS SLOTS ONLY. The cohort
 * label, the group labels, and one empty document per student_ref. Display names
 * stay in the WordPress store; firestore.rules would reject them anyway.
 */
async function mirrorCohort(pid, cid) {
  const cohort = wpGetCohort(pid, cid);
  if (!cohort) return;
  const base = ['providers', pid, 'cohorts', cid];
  await setDoc(doc(db, ...base), { label: cohort.label, active: true, student_count: cohort.students.length }, { merge: true });
  for (const g of wpGroups(pid, cid)) {
    await setDoc(doc(db, ...base, 'groups', g.id), { label: g.label, size: wpRoster(pid, cid, g.id).length }, { merge: true });
  }
  for (const s of cohort.students) {
    await setDoc(doc(db, ...base, 'students', s.student_ref), { group_id: s.group_id, active: true, created_at: serverTimestamp() }, { merge: true });
  }
}

// ═══ 4. SESSION SELECTION ════════════════════════════════════════════════════
async function viewSessions(cid) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  if (!cohort) return go2(H.dashboard());
  if (wpRoster(pid, cid).length === 0) return go2(H.cohort(cid));   // nothing to deliver yet

  show('v-sessions');
  const groups = wpGroups(pid, cid);
  $('se-provider').textContent = user.provider_name;
  $('se-title').textContent    = cohort.label;
  $('se-cohort').textContent   = `${wpRoster(pid, cid).length} students in ${groups.length} group${groups.length === 1 ? '' : 's'}`;
  $('se-students').textContent = wpRoster(pid, cid).length;
  $('se-groups').textContent   = groups.length;
  $('se-crumb').setAttribute('href', H.dashboard());
  $('se-setup').addEventListener('click', () => go2(H.cohort(cid)));

  const allOfMine = await allRuns();
  const runs = allOfMine.filter(r => r.cohort_id === cid);
  const groupIds = new Set(groups.map(g => g.id));
  const prog = cohortProgress(cid, groups, allOfMine);
  let totalRuns = 0, totalPledges = 0;

  $('se-list').innerHTML = wpSessionPages().map(p => {
    const sRuns = runs.filter(r => r.session === p.n);
    const pledges = sRuns.reduce((a, r) => a + (r.pledge_count || 0), 0);
    totalRuns += sRuns.length; totalPledges += pledges;
    const doneGroups = new Set(sRuns.filter(r => delivered(r) && groupIds.has(r.group_id)).map(r => r.group_id));
    const live = sRuns.some(r => r.status === 'open');
    const state = prog.perSession[p.n - 1];
    const isNext = prog.next === p.n;
    const dots = groups.map(g => `<i class="${doneGroups.has(g.id) ? 'done' : ''}" title="${esc(g.label)}"></i>`).join('');
    const pill = live ? '<span class="pill live">in progress</span>'
               : isNext ? '<span class="pill next">Next up</span>'
               : state === 'done' ? '<span class="pill ok">Delivered</span>'
               : '<span class="pill none">Not yet</span>';
    return `<a class="session-row ${state === 'done' ? 'done' : ''} ${isNext ? 'next' : ''}" href="${H.detail(cid, p.n)}">
        <div class="num">${state === 'done' ? '✓' : p.n}</div>
        <div class="grow">
          <div class="ttl">Session ${p.n} · ${esc(p.title)}</div>
          <div class="sub">${pledges} pledge${pledges === 1 ? '' : 's'} · ${doneGroups.size}/${groups.length} group${groups.length === 1 ? '' : 's'} delivered</div>
        </div>
        <div class="grp-dots">${dots}</div>
        ${pill}
      </a>`;
  }).join('');

  $('se-runs').textContent    = totalRuns;
  $('se-pledges').textContent = totalPledges;
}

async function allRuns() {
  const snap = await getDocs(collection(db, 'providers', user.provider_id, 'runs'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ═══ 5. SESSION DETAILS ══════════════════════════════════════════════════════
async function viewDetail(cid, n) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  const page = wpSessionPage(n);
  if (!cohort || !page) return go2(H.dashboard());

  show('v-detail');
  rail($('sd-rail'), 0);
  $('sd-crumb').setAttribute('href', H.sessions(cid));
  $('sd-eyebrow').textContent  = `${cohort.label} · Session ${n} of ${SESSION_COUNT}`;
  $('sd-title').textContent    = page.title;
  $('sd-blurb').textContent    = [page.theme_note, page.summary].filter(Boolean).join(' — ');
  $('sd-outcomes').innerHTML   = (page.outcomes || []).map(o => `<li>${esc(o)}</li>`).join('');
  $('sd-plan').innerHTML = [
    [SESSION_PARTS.film.label,      page.film ? `Film: ${page.film.title}` : 'Session film'],
    [SESSION_PARTS.classroom.label, page.classroom?.title || ''],
    [SESSION_PARTS.physical.label,  page.physical?.title || ''],
    [SESSION_PARTS.pledge.label,    page.question]
  ].map(([l, t]) => `<li><div><small>${esc(l)}</small>${esc(t)}</div></li>`).join('');

  const runs = (await allRuns()).filter(r => r.cohort_id === cid && r.session === n);
  const doneGroups = new Set(runs.filter(delivered).map(r => r.group_id));
  const openGroups = new Set(runs.filter(r => r.status === 'open').map(r => r.group_id));   // multi-facilitator presence
  const groups = wpGroups(pid, cid);

  // A group picked on the dashboard wins; otherwise default to the first group
  // not yet delivered and not currently in progress.
  let picked = null;
  try { picked = JSON.parse(sessionStorage.getItem(LS_PICK)); sessionStorage.removeItem(LS_PICK); } catch {}
  let chosen = (picked && picked.cid === cid && groups.some(g => g.id === picked.gid)) ? picked.gid : groups.find(g => !doneGroups.has(g.id) && !openGroups.has(g.id))?.id
            || groups.find(g => !doneGroups.has(g.id))?.id || groups[0]?.id || null;

  // Rendered ONCE; selection only toggles classes and the start button.
  $('sd-groups').innerHTML = groups.map(g => {
    const count = wpRoster(pid, cid, g.id).length;
    const status = openGroups.has(g.id) ? '<span class="pill live">in progress</span>'
                 : doneGroups.has(g.id) ? '<span class="pill ok">delivered</span>'
                 : '<span class="pill none">not yet</span>';
    return `<label class="roster-item ${chosen === g.id ? 'active' : ''}" data-grow="${esc(g.id)}" style="cursor:pointer">
        <input type="radio" name="grp" value="${esc(g.id)}" ${chosen === g.id ? 'checked' : ''} style="width:auto">
        <span class="nm"><strong>${esc(g.label)}</strong> · ${count} student${count === 1 ? '' : 's'}</span>
        ${status}
      </label>`;
  }).join('');

  function syncStart() {
    appEl.querySelectorAll('[data-grow]').forEach(el => el.classList.toggle('active', el.dataset.grow === chosen));
    const count = chosen ? wpRoster(pid, cid, chosen).length : 0;
    $('sd-start').disabled = !chosen || count === 0;
    $('sd-start').textContent = count === 0 ? 'That group has no students yet'
                              : openGroups.has(chosen) ? 'Start another run for this group →'
                              : 'Start session →';
  }
  appEl.querySelectorAll('input[name=grp]').forEach(r => r.addEventListener('change', () => { chosen = r.value; syncStart(); }));
  syncStart();

  if (runs.length) {
    $('sd-runs-pill').className = 'pill ok';
    $('sd-runs-pill').textContent = `Run ${runs.length}×`;
    $('sd-runs').innerHTML = runs.map(r => {
      const g = groups.find(x => x.id === r.group_id);
      return `<div>· ${esc(g ? g.label : r.group_id)} — ${r.pledge_count || 0} pledges
        <span class="pill ${r.status === 'open' ? 'live' : 'none'}">${esc(r.status)}</span></div>`;
    }).join('');
  }

  $('sd-start').addEventListener('click', () => beginDelivery(cid, n, chosen));
}

// ═══ 6. VIDEO ════════════════════════════════════════════════════════════════
function viewVideo(cid, n) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  const page = wpSessionPage(n);
  if (!cohort || !page) return go2(H.dashboard());
  const run = activeRun.get();
  if (!run || run.cohortId !== cid || run.session !== n) return go2(H.detail(cid, n));

  show('v-video');
  rail($('vd-rail'), 1);
  const group = wpGroups(pid, cid).find(g => g.id === run.groupId);
  $('vd-eyebrow').textContent  = `${cohort.label} · Session ${n} of ${SESSION_COUNT}`;
  $('vd-title').textContent    = page.title;
  $('vd-sub').textContent      = group ? `Delivering to ${group.label} — work through the four parts in order.` : '';
  $('vd-film').textContent     = page.film?.title || 'Session film';
  $('vd-film-how').textContent = SESSION_PARTS.film.how;
  $('vd-questions').innerHTML  = (page.film?.questions || []).map(q => `<li>${esc(q)}</li>`).join('');
  $('vd-classroom').textContent      = page.classroom?.title || '';
  $('vd-classroom-how').textContent  = SESSION_PARTS.classroom.how;
  $('vd-classroom-body').innerHTML   = renderBlocks(page.classroom?.blocks);
  $('vd-physical').textContent       = page.physical?.title || '';
  $('vd-physical-how').textContent   = SESSION_PARTS.physical.how;
  $('vd-physical-body').innerHTML    = renderBlocks(page.physical?.blocks);
  $('vd-question').textContent = page.question;
  $('vd-pledge-how').textContent = SESSION_PARTS.pledge.how;
  $('vd-citizen').textContent  = page.citizen || '';
  if (page.video_url) $('vd-videonote').textContent = page.video_url;
  appEl.querySelectorAll('[data-part]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    $(a.dataset.part)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('vd-back').addEventListener('click', e => { e.preventDefault(); go2(H.detail(cid, n)); });
  $('vd-next').addEventListener('click', async () => {
    const btn = $('vd-next');
    btn.disabled = true; btn.textContent = 'Starting…';
    try { await openRun(); go2(H.pledge(cid, n)); }
    catch (e) {
      console.error('[TFT26] could not start the run', e);
      btn.disabled = false; btn.textContent = 'Continue to pledges →';
      alert('Could not start the session — check the connection and try again.');
    }
  });
}

// ═══ 7. PLEDGE CAPTURE ═══════════════════════════════════════════════════════
/**
 * Begin delivering session n to one group on this device and go to the video.
 * Nothing is written yet — the run is created by openRun() when pledges start,
 * so opening a session to look at it and backing out leaves nothing half-open.
 */
function beginDelivery(cid, n, groupId) {
  const pid = user.provider_id;
  const cur = activeRun.get();
  const same = cur && cur.cohortId === cid && cur.session === n && cur.groupId === groupId;
  if (cur?.runId && !same) {
    const c = wpGetCohort(pid, cur.cohortId);
    const g = wpGroups(pid, cur.cohortId).find(x => x.id === cur.groupId);
    if (!confirm(`This device is still collecting pledges for ${c ? c.label : ''} · ${g ? g.label : ''} (Session ${cur.session}). Leave that open and start this one?`)) return;
  }
  if (!same) activeRun.set({ runId: null, cohortId: cid, session: n, groupId, done: [], skipped: [] });
  go2(H.video(cid, n));
}

/** Create the run (pledges are starting), mirror the cohort, roll up counters. */
async function openRun() {
  const pid = user.provider_id;
  const run = activeRun.get();
  if (!run || run.runId) return;
  const { cohortId: cid, session: n, groupId } = run;
  await mirrorCohort(pid, cid);                  // labels + pseudonymous slots, never names
  const ref = await addDoc(collection(db, 'providers', pid, 'runs'), {
    session: n, cohort_id: cid, group_id: groupId,
    status: 'open', pledge_count: 0, started_at: serverTimestamp(), ended_at: null
  });

  // session_stats is a NESTED map — increment() would replace the whole map and
  // wipe the other five sessions, so read-modify-write inside a transaction.
  await runTransaction(db, async (tx) => {
    const pref = doc(db, 'providers', pid);
    const snap = await tx.get(pref);
    const stats = (snap.exists() ? snap.data().session_stats : null) || {};
    const key = 's' + n;
    const cur = stats[key] || { runs: 0, pledges: 0, last_run_at: null };
    // Concrete timestamp, not serverTimestamp(): sentinels only resolve at the
    // top level of a write, so a nested one would store the raw sentinel.
    const nowTs = { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 };
    tx.set(pref, {
      session_stats: { ...stats, [key]: { ...cur, runs: (cur.runs || 0) + 1, last_run_at: nowTs } },
      updated_at: serverTimestamp()
    }, { merge: true });
  });
  // Flat top-level field, so increment() is correct and race-free here.
  await setDoc(doc(db, 'public', 'session-totals'), { ['s' + n + '_runs']: increment(1) }, { merge: true });

  activeRun.set({ ...activeRun.get(), runId: ref.id });
}

function viewPledge(cid, n) {
  const run = activeRun.get();
  if (!run || run.cohortId !== cid || run.session !== n) return go2(H.detail(cid, n));   // refreshed with no run
  if (!run.runId) return go2(H.video(cid, n));                                           // not started yet

  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  const page = wpSessionPage(n);
  if (!cohort || !page) return go2(H.dashboard());

  show('v-pledge');
  rail($('dl-rail'), 2);
  const group = wpGroups(pid, cid).find(g => g.id === run.groupId);
  $('dl-eyebrow').textContent   = `${cohort.label} · Session ${n} · ${page.title}`;
  $('dl-crumb').textContent     = `${cohort.label} · ${group ? group.label : ''} · live`;
  $('dl-groupname').textContent = group ? group.label : 'Students';
  $('dl-back').addEventListener('click', e => { e.preventDefault(); go2(H.video(cid, n)); });
  $('dl-finish').addEventListener('click', () => finishRun(cid, n));

  // Routing context only — provider / session / run / cohort are non-identifying.
  const qs = `?provider=${encodeURIComponent(pid)}&session=${n}&run=${encodeURIComponent(run.runId)}&cohort=${encodeURIComponent(cid)}`;
  $('dl-frame').src = `../public_widget/pledge-widget.html${qs}`;
  // Show the production-style embed URL in the boundary chrome so it is clear this
  // iframe is served from GitHub Pages in production, not from WordPress.
  $('dl-embed-url').textContent = `rtfgit.github.io/TFT/pledge-widget.html${qs}`;
  paintRoster();
}

/**
 * The turn order. Students go in roster order; anyone skipped drops to the back
 * (they can still be tapped). `next` is who comes up after the current player.
 */
function turnOrder(run) {
  const roster = wpRoster(user.provider_id, run.cohortId, run.groupId);
  const done = new Set(run.done), skipped = new Set(run.skipped || []);
  const waiting = roster.filter(s => !done.has(s.student_ref) && !skipped.has(s.student_ref) && s.student_ref !== run.current);
  return { roster, done, skipped, next: waiting[0] || null };
}

function paintRoster() {
  const run = activeRun.get();
  if (!run || !$('dl-roster')) return;
  const { roster, done, skipped, next } = turnOrder(run);
  $('dl-progress').textContent = `${done.size} / ${roster.length}`;
  $('dl-bar').style.width = roster.length ? `${Math.round(done.size / roster.length * 100)}%` : '0%';
  $('dl-roster').innerHTML = roster.map(s => {
    const isDone = done.has(s.student_ref), isNow = run.current === s.student_ref;
    const st = isDone ? '✓ pledged' : isNow ? 'Now' : skipped.has(s.student_ref) ? 'skipped'
             : next && next.student_ref === s.student_ref ? 'Up next' : '';
    return `<button class="roster-item ${isDone ? 'done' : ''} ${isNow ? 'active' : ''} ${skipped.has(s.student_ref) ? 'skipped' : ''}"
        data-ref="${esc(s.student_ref)}" ${isDone ? 'disabled' : ''}>
      <span class="av">${isDone ? '✓' : esc(initial(s.display_name))}</span>
      <span class="nm">${esc(s.display_name)}</span>
      <span class="st">${st}</span>
    </button>`;
  }).join('');
  const everyone = roster.length > 0 && done.size + skipped.size >= roster.length && !run.current;
  $('dl-alldone').classList.toggle('hidden', !everyone);
  $('dl-finish').classList.toggle('big', everyone);
  appEl.querySelectorAll('[data-ref]').forEach(b => b.addEventListener('click', () => selectStudent(b.dataset.ref)));
  appEl.querySelector('.roster-item.active')?.scrollIntoView({ block: 'nearest' });
}

/** Hand a student to the widget: ref for storage, name for on-screen display only. */
function selectStudent(ref) {
  const run = activeRun.get();
  const frame = $('dl-frame');
  if (!run || !frame) return;
  const s = wpRoster(user.provider_id, run.cohortId, run.groupId).find(x => x.student_ref === ref);
  if (!s) return;
  frame.contentWindow.postMessage({
    type: 'TFT_SET_STUDENT', student_ref: s.student_ref, display_name: s.display_name
  }, '*');
  activeRun.set({ ...run, current: ref, skipped: (run.skipped || []).filter(x => x !== ref) });
  paintRoster();
}

/** Bring up the next player automatically — or tell the widget that's everyone. */
function selectNext() {
  const run = activeRun.get();
  if (!run) return;
  const { next } = turnOrder(run);
  if (next) selectStudent(next.student_ref);
  else { $('dl-frame')?.contentWindow.postMessage({ type: 'TFT_ALL_DONE' }, '*'); paintRoster(); }
}

window.addEventListener('message', (e) => {
  const t = e.data?.type;
  if (!t || !t.startsWith('TFT_') || !$('dl-frame')) return;
  const run = activeRun.get();
  if (t === 'TFT_HEIGHT') { $('dl-frame').style.height = e.data.height + 'px'; return; }
  if (!run) return;
  if (t === 'TFT_WIDGET_READY') {
    // Fresh load (or a refresh mid-turn): re-hand the current player, else start the queue.
    if (run.current) selectStudent(run.current); else selectNext();
  } else if (t === 'TFT_PLEDGE_SAVED' && run.current) {
    activeRun.set({ ...run, done: [...new Set([...run.done, run.current])], current: null });
    paintRoster();
  } else if (t === 'TFT_READY_FOR_NEXT') {
    selectNext();
  } else if (t === 'TFT_STUDENT_SKIPPED') {
    const skipped = run.current ? [...new Set([...(run.skipped || []), run.current])] : (run.skipped || []);
    activeRun.set({ ...run, current: null, skipped });
    selectNext();
  }
});

// ═══ 8. COMPLETE ═════════════════════════════════════════════════════════════
async function finishRun(cid, n) {
  const run = activeRun.get();
  if (run) {
    const { roster, done } = turnOrder(run);
    const left = roster.length - done.size;
    if (left > 0 && !confirm(`${left} student${left === 1 ? " hasn't" : "s haven't"} pledged yet. Finish the session anyway?`)) return;
  }
  if (run?.runId) {
    await updateDoc(doc(db, 'providers', user.provider_id, 'runs', run.runId), { status: 'closed', ended_at: serverTimestamp() });
  }
  sessionStorage.setItem('tft26_last_run', JSON.stringify(run || {}));
  activeRun.clear();
  go2(H.complete(cid, n));
}

async function viewComplete(cid, n) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  const page = wpSessionPage(n);
  show('v-complete');
  rail($('cp-rail'), 3);
  let last = {};
  try { last = JSON.parse(sessionStorage.getItem('tft26_last_run')) || {}; } catch {}
  const group = wpGroups(pid, cid).find(g => g.id === last.groupId);
  const total = last.groupId ? wpRoster(pid, cid, last.groupId).length : 0;

  $('cp-title').textContent   = `Session ${n} complete!`;
  $('cp-sub').textContent     = `${cohort ? cohort.label + ' · ' : ''}${page ? page.title : ''}${group ? ' · ' + group.label : ''}`;
  $('cp-pledges').textContent = (last.done || []).length;
  $('cp-of').textContent      = total;
  $('cp-own').textContent     = '–';
  $('cp-cohorts').addEventListener('click', () => go2(H.dashboard()));
  $('cp-back').addEventListener('click', () => go2(H.sessions(cid)));

  // Up next — straight on to planning the following session.
  const nextPage = n < SESSION_COUNT ? wpSessionPage(n + 1) : null;
  if (nextPage) {
    $('cp-next-num').textContent = n + 1;
    $('cp-next-title').textContent = `Session ${n + 1} · ${nextPage.title}`;
    $('cp-next').addEventListener('click', () => last.groupId ? openSessionFor(cid, last.groupId, n + 1) : go2(H.detail(cid, n + 1)));
  } else {
    $('cp-next-num').textContent = '★';
    $('cp-next-title').textContent = 'That was the final session — the programme is complete for this group.';
    $('cp-next').textContent = 'All sessions →';
    $('cp-next').addEventListener('click', () => go2(H.sessions(cid)));
  }

  // What the group pledged — read back from the run itself (pseudonymous
  // pledges; the facilitator was in the room, so the text is no surprise).
  if (!last.runId) { $('cp-bk-card').classList.add('hidden'); return; }
  let pledges = [];
  try {
    const snap = await getDocs(collection(db, 'providers', pid, 'runs', last.runId, 'pledges'));
    pledges = snap.docs.map(d => d.data());
  } catch (e) { console.warn('[TFT26] could not read run pledges', e); }
  if (!$('cp-breakdown')) return;                                  // navigated away meanwhile
  $('cp-pledges').textContent = pledges.length;
  const own = pledges.filter(p => p.option === OWN_SUGGESTION_INDEX);
  $('cp-own').textContent = own.length;
  if (!pledges.length) { $('cp-breakdown').innerHTML = '<div class="muted" style="font-size:.85rem">No pledges were captured in this run.</div>'; return; }

  const options = (page?.options || []).map((text, i) => ({
    text, count: pledges.filter(p => p.option === i + 1).length }));
  if (own.length) options.push({ text: 'Their own idea', count: own.length });
  options.sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...options.map(o => o.count));
  $('cp-breakdown').innerHTML = options.map((o, i) => `
    <div class="bk ${i === 0 && o.count ? 'top' : ''}">
      <div class="t">${i === 0 && o.count ? '🏆 ' : ''}${esc(o.text)}</div><div class="c">${o.count}</div>
      <div class="bar-track"><div class="bar-fill" style="width:0%" data-w="${Math.round(o.count / max * 100)}"></div></div>
    </div>`).join('');
  requestAnimationFrame(() => appEl.querySelectorAll('[data-w]').forEach(b => { b.style.width = b.dataset.w + '%'; }));
  if (own.length) {
    $('cp-own-wrap').classList.remove('hidden');
    $('cp-own-list').innerHTML = own.map(p => `<div>“${esc(p.pledge_text)}”</div>`).join('');
  }
}

// ═══ ROUTER ══════════════════════════════════════════════════════════════════
function go2(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function route() {
  user = wpCurrentUser();
  setChrome();
  if (!user) { if (location.hash !== '#/login') return go2(H.login()); return viewLogin(); }
  // LIVE needs a Firebase session too. If it's missing (e.g. they signed in while
  // in Sandbox, then switched), sign out of the emulated WordPress and start again.
  if (MODE === 'live' && !currentUser()) {
    wpSignOut(); user = null; setChrome();
    return location.hash === '#/login' ? viewLogin() : go2(H.login());
  }

  const h = location.hash || '';
  const mSession = h.match(/^#\/cohort\/([^/]+)\/session\/(\d+)(?:\/(video|pledge|complete))?$/);
  if (mSession) {
    const cid = decodeURIComponent(mSession[1]);
    const n = Number(mSession[2]);
    if (n < 1 || n > SESSION_COUNT) return go2(H.sessions(cid));
    if (!wpGetCohort(user.provider_id, cid)) return go2(H.dashboard());
    if (mSession[3] === 'video')    return viewVideo(cid, n);
    if (mSession[3] === 'pledge')   return viewPledge(cid, n);
    if (mSession[3] === 'complete') return viewComplete(cid, n);
    return viewDetail(cid, n);
  }
  const mSessions = h.match(/^#\/cohort\/([^/]+)\/sessions$/);
  if (mSessions) return viewSessions(decodeURIComponent(mSessions[1]));
  const mCohort = h.match(/^#\/cohort\/([^/]+)$/);
  if (mCohort) return viewCohort(decodeURIComponent(mCohort[1]));
  if (h === '#/dashboard') return viewDashboard();
  if (h === '#/cohorts') return go2(H.dashboard());          // old permalink

  // Default landing after login: the dashboard.
  return go2(H.dashboard());
}

$('wp-signout').addEventListener('click', (e) => {
  e.preventDefault();
  wpSignOut(); activeRun.clear(); user = null;
  if (MODE === 'live') signOut(getAuth());
  go2(H.login());
});

const modePill = $('wp-mode');
modePill.textContent = MODE === 'live' ? 'LIVE' : 'SANDBOX';
modePill.classList.toggle('live', MODE === 'live');

window.addEventListener('hashchange', route);
route();
