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
  wpAddStudent, wpUpdateStudent, wpRemoveStudent, wpRoster, wpCapStatus, WP_ROUTES
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
// The group being delivered to rides along as ?g=<groupId> on the sessions and
// session-plan routes, so every link, back button and refresh keeps the same
// cohort AND group (WordPress: ?group=<id> on the permalink).
const withG = (hash, g) => g ? `${hash}?g=${encodeURIComponent(g)}` : hash;
const H = {
  login:    ()         => '#/login',
  dashboard:()         => '#/dashboard',
  cohort:   (c)        => `#/cohort/${c}`,
  sessions: (c, g)     => withG(`#/cohort/${c}/sessions`, g),
  detail:   (c, n, g)  => withG(`#/cohort/${c}/session/${n}`, g),
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
function permalinkForHash(full) {
  const [hash, q] = full.split('?');
  const g = new URLSearchParams(q || '').get('g');
  for (const r of Object.values(WP_ROUTES)) {
    const rx = new RegExp('^' + r.hash.replace(':c', '([^/]+)').replace(':n', '(\\d+)') + '$');
    const m = hash.match(rx);
    if (!m) continue;
    let out = r.permalink, gi = 1;
    if (r.hash.includes(':c')) out = out.replace(':c', decodeURIComponent(m[gi++]));
    if (r.hash.includes(':n')) out = out.replace(':n', m[gi++]);
    return g ? `${out}?group=${g}` : out;
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
 *   "Deliver Session 4 →"   opens that session's plan with THIS group already
 *                           chosen (no second "which group?" question)
 *   any undelivered square  the same, for that session — out of order is fine
 *   a delivered square      the same — to review it, or run it again
 *
 * Anything stalled or left open floats to the top as needing attention. All of
 * it is derived from the WordPress roster + the provider's runs; nothing extra
 * is stored.
 */
const DAY_S = 86400;
const STALE_DAYS = 14;          // no session for this long → needs attention
const LEFT_OPEN_HOURS = 3;      // an open run older than this was probably never finished
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

/** Open a session's plan with a particular group already chosen. */
function openSessionFor(cid, gid, n) { go2(H.detail(cid, n, gid)); }

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
    const students = cohorts.reduce((a, c) => a + c.students, 0);
    const pledges = runs.reduce((a, r) => a + (r.pledge_count || 0), 0);
    $('db-hello').textContent = cohorts.length
      ? `${plural(cohorts.length, 'cohort')} · ${plural(students, 'student')} · ${plural(pledges, 'pledge')}`
      : '';

    const label = (r) => {
      const c = cohorts.find(x => x.cohort_id === r.cohort_id);
      const g = c?.groups.find(x => x.id === r.group_id);
      return `${c ? c.label : r.cohort_id} · ${g ? g.label : r.group_id}`;
    };
    $('db-livestrip').innerHTML = runs.filter(r => r.status === 'open').map(r => {
      const started = r.started_at?.seconds || 0;
      const mins = Math.max(1, Math.round((nowSecs() - started) / 60));
      if (nowSecs() - started > LEFT_OPEN_HOURS * 3600) {
        return `<div class="stale"><span class="dot"></span><span><strong>${esc(label(r))}</strong> · Session ${r.session} started ${fmtDay(started)}, not finished · <a href="${H.detail(r.cohort_id, r.session, r.group_id)}">Open</a></span></div>`;
      }
      const where = here && here.runId === r.id
        ? `this device · <a href="${H.pledge(r.cohort_id, r.session)}">Resume</a>` : 'another device';
      return `<div><span class="dot"></span><span><strong>${esc(label(r))}</strong> · Session ${r.session} in progress (${mins < 90 ? mins + ' min' : Math.round(mins / 60) + ' h'}) · ${where}</span></div>`;
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
      const tip = cell.state === 'done' ? `Session ${cell.n} · ${title(cell.n)}: delivered ${fmtDay(cell.run.started_at?.seconds)}, ${plural(cell.run.pledge_count || 0, 'pledge')}`
                : cell.state === 'live' ? `Session ${cell.n} · ${title(cell.n)}: in progress`
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
        <p>A class, year group or squad.</p>
        <div class="add">
          <input type="text" id="db-first" placeholder="Cohort name, e.g. Year 9 Rugby" aria-label="Cohort name">
          <button class="btn new-btn" id="db-firstadd"><span class="plus" aria-hidden="true">+</span>Add cohort</button>
        </div>
      </div>`
      : list.length === 0 ? '<div class="empty">No cohorts match.</div>'
      : list.map(panel).join('');
    if (empty) {
      const addFirst = () => create($('db-first').value);
      $('db-firstadd').addEventListener('click', addFirst);
      $('db-first').addEventListener('keydown', e => { if (e.key === 'Enter') addFirst(); });
    }

    const parse = (v) => { const [cid, gid, n] = v.split('|'); return [cid, gid, Number(n)]; };
    appEl.querySelectorAll('#db-list [data-deliver]').forEach(b => b.addEventListener('click', () => openSessionFor(...parse(b.dataset.deliver))));
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
let showIds = false;          // "Show IDs" on the cohort screen

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

  $('mc-ids').checked = showIds;
  $('mc-ids').addEventListener('change', () => { showIds = $('mc-ids').checked; $('mc-groups').classList.toggle('show-ids', showIds); });
  $('mc-groups').classList.toggle('show-ids', showIds);

  /**
   * Enrolment is where names get typed in bulk, so: full names in a numbered
   * list (easy to check against a register), click a name to correct it, paste
   * a whole class list in one go, and a flag on any name entered twice.
   */
  function paint(focusGroup, flash) {
    const groups = wpGroups(pid, cid);
    const all = wpRoster(pid, cid);
    const key = (n) => n.trim().toLowerCase().replace(/\s+/g, ' ');
    const seen = {};
    all.forEach(st => { const k = key(st.display_name); seen[k] = (seen[k] || 0) + 1; });

    $('mc-groups').innerHTML = groups.map((g, gi) => {
      const students = wpRoster(pid, cid, g.id);
      const soleGroupHint = groups.length === 1 ? ' <span class="muted" style="font-weight:400">· whole cohort</span>' : '';
      return `<div class="group-card" data-group="${esc(g.id)}" style="--g:var(--group-${(gi % 6) + 1})">
        <div class="group-head">
          <i class="gdot"></i>
          <input value="${esc(g.label)}" data-rename="${esc(g.id)}" aria-label="Group name">
          ${soleGroupHint}
          <span class="pill ${students.length ? 'ok' : 'none'}">${plural(students.length, 'student')}</span>
          ${groups.length > 1 ? `<button class="btn ghost" data-delgroup="${esc(g.id)}">Remove</button>` : ''}
        </div>
        <div class="group-body">
          ${students.length ? `<ol class="stu-list">${students.map(st => {
            const dup = seen[key(st.display_name)] > 1;
            return `<li class="stu ${dup ? 'dup' : ''}">
              <input class="nm" value="${esc(st.display_name)}" data-edit="${esc(st.student_ref)}"
                     aria-label="Student name" title="Click to edit">
              <button class="x" data-del="${esc(st.student_ref)}" title="Remove ${esc(st.display_name)}" aria-label="Remove ${esc(st.display_name)}">✕</button>
              <span class="sub">${dup ? '<span class="dupnote">Duplicate name</span>' : ''}<span class="ref">${esc(st.student_ref)}</span></span>
            </li>`;
          }).join('')}</ol>` : ''}
          <div class="add-box">
            <textarea rows="1" data-add="${esc(g.id)}" aria-label="Add students to ${esc(g.label)}"
              placeholder="Add names, or paste a list"></textarea>
            <button class="btn" data-addbtn="${esc(g.id)}">Add</button>
          </div>
          <div class="add-hint">${flash && focusGroup === g.id ? `<span class="flash">${esc(flash)}</span> · ` : ''}One per line or comma-separated</div>
        </div>
      </div>`;
    }).join('');

    const total = all.length;
    $('mc-count').textContent = `${plural(total, 'student')} across ${plural(groups.length, 'group')}`;
    $('mc-done').disabled = total === 0;
    $('mc-done').textContent = 'Deliver sessions →';

    const cap = wpCapStatus(pid, cid);
    const msgs = [];
    cap.overSizedGroups.forEach(g => msgs.push(`${g.label} has ${g.count} students (usual maximum ${cap.groupSizeCap}).`));
    if (cap.tooManyGroups) msgs.push(`${cap.groups} groups (usual maximum ${EXPECTED_GROUPS}).`);
    if (msgs.length) {
      $('mc-warn').textContent = msgs.join(' ');
      $('mc-warn').classList.remove('hidden');
    } else { $('mc-warn').classList.add('hidden'); }

    // Adding: Enter adds everything in the box (a pasted list included); the
    // button shows how many names it will add.
    appEl.querySelectorAll('[data-add]').forEach(t => {
      const btn = appEl.querySelector(`[data-addbtn="${t.dataset.add}"]`);
      const sync = () => {
        const n = splitNames(t.value).length;
        btn.textContent = n > 1 ? `Add ${n}` : 'Add';
        t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 220) + 'px';
      };
      t.addEventListener('input', sync);
      t.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addTo(t.dataset.add); } });
    });
    appEl.querySelectorAll('[data-addbtn]').forEach(b => b.addEventListener('click', () => addTo(b.dataset.addbtn)));
    // Correcting a name: edit in place; an emptied name reverts.
    appEl.querySelectorAll('[data-edit]').forEach(i => {
      i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); if (e.key === 'Escape') { i.value = i.defaultValue; i.blur(); } });
      i.addEventListener('change', () => {
        const v = i.value.trim();
        if (!v) { i.value = i.defaultValue; return; }
        wpUpdateStudent(pid, cid, i.dataset.edit, { display_name: v });
        paint();
      });
    });
    appEl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { wpRemoveStudent(pid, cid, b.dataset.del); paint(); }));
    appEl.querySelectorAll('[data-delgroup]').forEach(b => b.addEventListener('click', () => {
      if (confirm('Remove this group? Its students move to the first remaining group.')) { wpRemoveGroup(pid, cid, b.dataset.delgroup); paint(); }
    }));
    appEl.querySelectorAll('[data-rename]').forEach(i => i.addEventListener('change', () => { wpRenameGroup(pid, cid, i.dataset.rename, i.value.trim() || 'Group'); paint(); }));

    if (focusGroup) appEl.querySelector(`[data-add="${focusGroup}"]`)?.focus();
  }

  function addTo(groupId) {
    const input = appEl.querySelector(`[data-add="${groupId}"]`);
    const names = splitNames(input.value);
    if (!names.length) return;
    names.forEach(name => wpAddStudent(pid, cid, name, groupId));
    paint(groupId, names.length === 1 ? `Added ${names[0]}` : `Added ${names.length} students`);
  }
  paint();
}

/** Split typed or pasted text into names: one per line, or comma / semicolon separated. */
function splitNames(text) {
  return String(text || '').split(/[\n\r,;\t]+/).map(n => n.replace(/\s+/g, ' ').trim()).filter(Boolean);
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
/**
 * All sessions for ONE group of a cohort — the group is always named on screen
 * and carried into every session link (?g=), so opening a session from here
 * never silently switches to a different group.
 */
async function viewSessions(cid, gParam) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  if (!cohort) return go2(H.dashboard());
  if (wpRoster(pid, cid).length === 0) return go2(H.cohort(cid));   // nothing to deliver yet

  show('v-sessions');
  const groups = wpGroups(pid, cid);
  $('se-provider').textContent = user.provider_name;
  $('se-title').textContent    = cohort.label;
  $('se-setup').addEventListener('click', () => go2(H.cohort(cid)));

  const runs = (await allRuns()).filter(r => r.cohort_id === cid);
  if (!$('se-list')) return;                                  // navigated away while loading
  const progress = Object.fromEntries(groups.map(g => [g.id, groupProgress(cid, g.id, runs)]));
  // Group from the URL; otherwise the first group with a session still to do.
  let gid = (gParam && progress[gParam]) ? gParam
          : (groups.find(g => progress[g.id].next !== null) || groups[0]).id;
  const colourOf = (id) => `var(--group-${(groups.findIndex(g => g.id === id) % 6) + 1})`;

  function paint() {
    const g = groups.find(x => x.id === gid);
    const p = progress[gid];
    const size = wpRoster(pid, cid, gid).length;
    if (location.hash !== H.sessions(cid, gid)) history.replaceState(null, '', H.sessions(cid, gid));
    setChrome();
    $('se-to').style.setProperty('--g', colourOf(gid));
    $('se-cohort').textContent = `${plural(size, 'student')} · ${p.done} of ${SESSION_COUNT} sessions delivered`;
    $('se-groups').innerHTML = groups.length < 2 ? `<strong>${esc(g.label)}</strong>`
      : groups.map(x => `<button class="gchip" data-g="${esc(x.id)}" aria-pressed="${x.id === gid}" style="--g:${colourOf(x.id)}">
          <i></i>${esc(x.label)}</button>`).join('');
    appEl.querySelectorAll('[data-g]').forEach(b => b.addEventListener('click', () => { gid = b.dataset.g; paint(); }));

    $('se-list').innerHTML = p.cells.map(cell => {
      const page = wpSessionPage(cell.n);
      const r = cell.run;
      const pill = cell.state === 'live' ? '<span class="pill live">in progress</span>'
                 : cell.state === 'next' ? '<span class="pill next">Next up</span>'
                 : cell.state === 'done' ? '<span class="pill ok">Delivered</span>'
                 : '<span class="pill none">Not yet</span>';
      const sub = cell.state === 'done' ? `Delivered ${fmtDay(r.started_at?.seconds)} · ${plural(r.pledge_count || 0, 'pledge')}`
                : cell.state === 'live' ? 'Being delivered now'
                : 'Not yet delivered';
      return `<a class="session-row ${cell.state === 'done' ? 'done' : ''} ${cell.state === 'next' ? 'next' : ''}" href="${H.detail(cid, cell.n, gid)}">
          <div class="num">${cell.state === 'done' ? '✓' : cell.n}</div>
          <div class="grow">
            <div class="ttl">Session ${cell.n} · ${esc(page ? page.title : '')}</div>
            <div class="sub">${esc(sub)}</div>
          </div>
          ${pill}
        </a>`;
    }).join('');
  }
  paint();
}

async function allRuns() {
  const snap = await getDocs(collection(db, 'providers', user.provider_id, 'runs'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ═══ 5. SESSION DETAILS ══════════════════════════════════════════════════════
async function viewDetail(cid, n, gParam) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  const page = wpSessionPage(n);
  if (!cohort || !page) return go2(H.dashboard());

  show('v-detail');
  rail($('sd-rail'), 0);
  $('sd-eyebrow').textContent  = `${cohort.label} · Session ${n} of ${SESSION_COUNT}`;
  $('sd-title').textContent    = page.title;
  $('sd-blurb').textContent    = page.summary || '';
  $('sd-outcomes').innerHTML   = (page.outcomes || []).map(o => `<li>${esc(o)}</li>`).join('');
  $('sd-plan').innerHTML = [
    [SESSION_PARTS.film.label,      page.film ? `Film: ${page.film.title}` : 'Session film'],
    [SESSION_PARTS.classroom.label, page.classroom?.title || ''],
    [SESSION_PARTS.physical.label,  page.physical?.title || ''],
    [SESSION_PARTS.pledge.label,    page.question]
  ].map(([l, t]) => `<li><div><small>${esc(l)}</small>${esc(t)}</div></li>`).join('');

  const cohortRuns = (await allRuns()).filter(r => r.cohort_id === cid);
  const runs = cohortRuns.filter(r => r.session === n);
  const doneGroups = new Set(runs.filter(delivered).map(r => r.group_id));
  const openGroups = new Set(runs.filter(r => r.status === 'open').map(r => r.group_id));   // multi-facilitator presence
  const groups = wpGroups(pid, cid);

  // The group in the URL wins (set by the dashboard or the sessions list);
  // otherwise default to the first group not yet delivered and not in progress.
  let chosen = (gParam && groups.some(g => g.id === gParam)) ? gParam : groups.find(g => !doneGroups.has(g.id) && !openGroups.has(g.id))?.id
            || groups.find(g => !doneGroups.has(g.id))?.id || groups[0]?.id || null;

  // "Delivering to" is a confirmation, not a question: the group is already
  // chosen (from the dashboard, or the sensible default above). The full list
  // sits behind "Change group" as a fallback, and isn't offered for one group.
  const colourOf = (gid) => `var(--group-${(groups.findIndex(g => g.id === gid) % 6) + 1})`;
  $('sd-groups').innerHTML = groups.map(g => {
    const count = wpRoster(pid, cid, g.id).length;
    const status = openGroups.has(g.id) ? '<span class="pill live">in progress</span>'
                 : doneGroups.has(g.id) ? '<span class="pill ok">delivered</span>'
                 : '<span class="pill none">not yet</span>';
    return `<label class="roster-item" data-grow="${esc(g.id)}" style="cursor:pointer">
        <input type="radio" name="grp" value="${esc(g.id)}" style="width:auto">
        <i class="gdot" style="width:10px;height:10px;border-radius:50%;background:${colourOf(g.id)};flex:0 0 auto"></i>
        <span class="nm"><strong>${esc(g.label)}</strong> · ${plural(count, 'student')}</span>
        ${status}
      </label>`;
  }).join('');
  if (groups.length < 2) $('sd-change').classList.add('hidden');
  const togglePicker = (open) => {
    $('sd-picker').classList.toggle('hidden', !open);
    $('sd-change').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('sd-change').textContent = open ? 'Done' : 'Change group';
  };
  $('sd-change').addEventListener('click', () => togglePicker($('sd-picker').classList.contains('hidden')));

  function syncStart() {
    const g = groups.find(x => x.id === chosen);
    // Keep the address and the breadcrumb in step with the chosen group.
    if (chosen && location.hash !== H.detail(cid, n, chosen)) history.replaceState(null, '', H.detail(cid, n, chosen));
    // Session switcher: this group's six sessions — tap one to switch.
    const gp = chosen ? groupProgress(cid, chosen, cohortRuns) : null;
    $('sd-switch').style.setProperty('--g', chosen ? colourOf(chosen) : 'var(--accent)');
    $('sd-sw-group').textContent = g ? `${cohort.label} · ${g.label}` : cohort.label;
    $('sd-sw-cells').innerHTML = gp ? gp.cells.map(c => {
      const t = wpSessionPage(c.n)?.title || '';
      const st = c.state === 'done' ? 'delivered' : c.state === 'live' ? 'in progress' : c.state === 'next' ? 'up next' : 'not yet';
      return `<button class="cell ${c.state} ${c.n === n ? 'current' : ''}" data-sw="${c.n}" ${c.n === n ? 'aria-current="page"' : ''}
        title="Session ${c.n} · ${esc(t)}: ${st}">${c.state === 'done' ? '✓' : c.n}</button>`;
    }).join('') : '';
    appEl.querySelectorAll('[data-sw]').forEach(b => b.addEventListener('click', () => {
      if (Number(b.dataset.sw) !== n) go2(H.detail(cid, Number(b.dataset.sw), chosen));
    }));
    $('sd-all').setAttribute('href', H.sessions(cid, chosen));
    $('sd-all').textContent = g ? `All sessions for ${g.label} →` : 'All sessions →';
    setChrome();
    const count = chosen ? wpRoster(pid, cid, chosen).length : 0;
    appEl.querySelectorAll('input[name=grp]').forEach(r => { r.checked = r.value === chosen; });
    appEl.querySelectorAll('[data-grow]').forEach(el => el.classList.toggle('active', el.dataset.grow === chosen));
    $('sd-to').style.setProperty('--g', chosen ? colourOf(chosen) : 'var(--accent)');
    $('sd-to-name').textContent = g ? g.label : 'No group yet';
    $('sd-to-meta').textContent = g ? `· ${plural(count, 'student')}` : '';
    $('sd-to-note').textContent = !g ? 'No groups yet.'
      : count === 0 ? 'No students yet.'
      : openGroups.has(chosen) ? 'In progress on another device.'
      : doneGroups.has(chosen) ? 'Already delivered.'
      : '';
    $('sd-start').disabled = !chosen || count === 0;
    $('sd-start').textContent = count === 0 ? 'That group has no students yet'
                              : openGroups.has(chosen) ? 'Start another run for this group →'
                              : doneGroups.has(chosen) ? 'Run it again →'
                              : 'Start session →';
  }
  appEl.querySelectorAll('input[name=grp]').forEach(r => r.addEventListener('change', () => { chosen = r.value; syncStart(); togglePicker(false); }));
  syncStart();

  if (runs.length) {
    $('sd-runs-pill').className = 'pill ok';
    $('sd-runs-pill').textContent = `Run ${runs.length}×`;
    $('sd-runs').innerHTML = runs.map(r => {
      const g = groups.find(x => x.id === r.group_id);
      return `<div>${esc(g ? g.label : r.group_id)} · ${plural(r.pledge_count || 0, 'pledge')}
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
  $('vd-sub').textContent      = group ? `Delivering to ${group.label}` : '';
  $('vd-film').textContent     = page.film?.title || 'Session film';
  $('vd-questions').innerHTML  = (page.film?.questions || []).map(q => `<li>${esc(q)}</li>`).join('');
  $('vd-classroom').textContent      = page.classroom?.title || '';
  $('vd-classroom-body').innerHTML   = renderBlocks(page.classroom?.blocks);
  $('vd-physical').textContent       = page.physical?.title || '';
  $('vd-physical-body').innerHTML    = renderBlocks(page.physical?.blocks);
  $('vd-question').textContent = page.question;
  $('vd-citizen').textContent  = page.citizen || '';
  if (page.video_url) $('vd-videonote').textContent = page.video_url;
  appEl.querySelectorAll('[data-part]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    $(a.dataset.part)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('vd-back').addEventListener('click', e => { e.preventDefault(); go2(H.detail(cid, n, run.groupId)); });
  $('vd-next').addEventListener('click', async () => {
    const btn = $('vd-next');
    btn.disabled = true; btn.textContent = 'Starting…';
    try { await openRun(); go2(H.pledge(cid, n)); }
    catch (e) {
      console.error('[TFT26] could not start the run', e);
      btn.disabled = false; btn.textContent = 'Continue to pledges →';
      alert('Could not start the session. Check the connection and try again.');
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
  $('cp-back').addEventListener('click', () => go2(H.sessions(cid, last.groupId)));

  // Up next — straight on to planning the following session.
  const nextPage = n < SESSION_COUNT ? wpSessionPage(n + 1) : null;
  if (nextPage) {
    $('cp-next-num').textContent = n + 1;
    $('cp-next-title').textContent = `Session ${n + 1} · ${nextPage.title}`;
    $('cp-next').addEventListener('click', () => go2(H.detail(cid, n + 1, last.groupId)));
  } else {
    $('cp-next-num').textContent = '★';
    $('cp-next-title').textContent = 'Programme complete for this group.';
    $('cp-next').textContent = 'All sessions →';
    $('cp-next').addEventListener('click', () => go2(H.sessions(cid, last.groupId)));
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

  const [h, q] = (location.hash || '').split('?');
  const gParam = new URLSearchParams(q || '').get('g');
  const mSession = h.match(/^#\/cohort\/([^/]+)\/session\/(\d+)(?:\/(video|pledge|complete))?$/);
  if (mSession) {
    const cid = decodeURIComponent(mSession[1]);
    const n = Number(mSession[2]);
    if (n < 1 || n > SESSION_COUNT) return go2(H.sessions(cid));
    if (!wpGetCohort(user.provider_id, cid)) return go2(H.dashboard());
    if (mSession[3] === 'video')    return viewVideo(cid, n);
    if (mSession[3] === 'pledge')   return viewPledge(cid, n);
    if (mSession[3] === 'complete') return viewComplete(cid, n);
    return viewDetail(cid, n, gParam);
  }
  const mSessions = h.match(/^#\/cohort\/([^/]+)\/sessions$/);
  if (mSessions) return viewSessions(decodeURIComponent(mSessions[1]), gParam);
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
