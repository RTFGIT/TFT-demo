/**
 * facilitator-app.js — the facilitator pathway, start to finish.
 *
 *   #/login
 *   #/cohorts                              manage cohorts (a class / year / club)
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
  collection, getDocs, serverTimestamp, runTransaction, increment
} from '../local-firebase.js';
import { SESSION_COUNT, EXPECTED_GROUPS } from '../public_widget/session-config.js';

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
  cohorts:  ()      => '#/cohorts',
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
  $('wp-route').textContent = permalinkForHash(location.hash || '');
}
function show(templateId) {
  appEl.innerHTML = '';
  appEl.appendChild(document.getElementById(templateId).content.cloneNode(true));
  setChrome();
}

/** The 4-step rail across details → video → pledge → complete. */
function rail(el, step) {
  if (!el) return;
  const steps = ['Details', 'Video', 'Pledges', 'Done'];
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
  $('li-accounts').innerHTML = wpAccounts().map(a =>
    `<tr><td><code>${esc(a.email)}</code></td><td><code>${esc(a.password)}</code></td><td>${esc(a.provider)}</td></tr>`).join('');
  const go = () => {
    try {
      user = wpSignIn($('li-email').value.trim(), $('li-pass').value);
      setChrome();
      go2(H.cohorts());
    } catch {
      $('li-err').textContent = 'Those credentials were not recognised.';
      $('li-err').classList.remove('hidden');
    }
  };
  $('li-go').addEventListener('click', go);
  $('li-pass').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// ═══ 2. COHORTS ══════════════════════════════════════════════════════════════
function viewCohorts() {
  show('v-cohorts');
  const pid = user.provider_id;
  $('co-provider').textContent = user.provider_name;

  function paint() {
    const cohorts = wpCohorts(pid);
    $('co-list').innerHTML = cohorts.length === 0
      ? '<div class="empty">No cohorts yet. Create your first one above.</div>'
      : cohorts.map(c => `
        <div class="cohort-card" data-cohort="${esc(c.cohort_id)}">
          <div class="icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div class="grow">
            <div class="ttl">${esc(c.label)}</div>
            <div class="sub">${c.students} student${c.students === 1 ? '' : 's'} · ${c.groups} group${c.groups === 1 ? '' : 's'}</div>
          </div>
          <div class="acts">
            <button class="btn secondary" data-manage="${esc(c.cohort_id)}">Manage</button>
            <button class="btn" data-deliver="${esc(c.cohort_id)}" ${c.students === 0 ? 'disabled title="Add students first"' : ''}>Deliver →</button>
            <button class="btn ghost" data-delcohort="${esc(c.cohort_id)}" title="Delete cohort">✕</button>
          </div>
        </div>`).join('');

    appEl.querySelectorAll('[data-manage]').forEach(b => b.addEventListener('click', () => go2(H.cohort(b.dataset.manage))));
    appEl.querySelectorAll('[data-deliver]').forEach(b => b.addEventListener('click', () => go2(H.sessions(b.dataset.deliver))));
    appEl.querySelectorAll('[data-delcohort]').forEach(b => b.addEventListener('click', () => {
      const c = cohorts.find(x => x.cohort_id === b.dataset.delcohort);
      if (confirm(`Delete "${c.label}" and its roster? This does not remove any pledges already captured.`)) {
        wpDeleteCohort(pid, b.dataset.delcohort); paint();
      }
    }));
  }

  const add = () => {
    const label = $('co-new').value.trim();
    if (!label) return;
    const c = wpCreateCohort(pid, label);
    go2(H.cohort(c.cohort_id));      // straight into managing the new cohort
  };
  $('co-add').addEventListener('click', add);
  $('co-new').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  paint();
}

// ═══ 3. MANAGE ONE COHORT — groups & students ════════════════════════════════
function viewCohort(cid) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  if (!cohort) return go2(H.cohorts());

  show('v-cohort');
  $('mc-provider').textContent = user.provider_name;
  $('mc-title').textContent = cohort.label;
  $('mc-label').value = cohort.label;
  $('mc-crumb').setAttribute('href', H.cohorts());
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
  if (!cohort) return go2(H.cohorts());
  if (wpRoster(pid, cid).length === 0) return go2(H.cohort(cid));   // nothing to deliver yet

  show('v-sessions');
  const groups = wpGroups(pid, cid);
  $('se-provider').textContent = user.provider_name;
  $('se-title').textContent    = cohort.label;
  $('se-cohort').textContent   = `${wpRoster(pid, cid).length} students in ${groups.length} group${groups.length === 1 ? '' : 's'}`;
  $('se-students').textContent = wpRoster(pid, cid).length;
  $('se-groups').textContent   = groups.length;
  $('se-crumb').setAttribute('href', H.cohorts());
  $('se-setup').addEventListener('click', () => go2(H.cohort(cid)));

  const runs = (await allRuns()).filter(r => r.cohort_id === cid);
  const groupIds = new Set(groups.map(g => g.id));
  let totalRuns = 0, totalPledges = 0;

  $('se-list').innerHTML = wpSessionPages().map(p => {
    const sRuns = runs.filter(r => r.session === p.n);
    const pledges = sRuns.reduce((a, r) => a + (r.pledge_count || 0), 0);
    totalRuns += sRuns.length; totalPledges += pledges;
    const doneGroups = new Set(sRuns.filter(r => groupIds.has(r.group_id)).map(r => r.group_id));
    const dots = groups.map(g => `<i class="${doneGroups.has(g.id) ? 'done' : ''}" title="${esc(g.label)}"></i>`).join('');
    return `<a class="session-row" href="${H.detail(cid, p.n)}">
        <div class="num">${p.n}</div>
        <div class="grow">
          <div class="ttl">${esc(p.title)}</div>
          <div class="sub">${pledges} pledge${pledges === 1 ? '' : 's'} · ${doneGroups.size}/${groups.length} groups done</div>
        </div>
        <div class="grp-dots">${dots}</div>
        ${sRuns.length ? `<span class="pill ok">${sRuns.length}×</span>` : '<span class="pill none">—</span>'}
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
  if (!cohort || !page) return go2(H.cohorts());

  show('v-detail');
  rail($('sd-rail'), 0);
  $('sd-crumb').setAttribute('href', H.sessions(cid));
  $('sd-eyebrow').textContent  = `${cohort.label} · Session ${n} of ${SESSION_COUNT}`;
  $('sd-title').textContent    = page.title;
  $('sd-blurb').textContent    = page.blurb;
  $('sd-question').textContent = page.question;
  $('sd-prompt').textContent   = page.prompt;
  $('sd-duration').textContent = `About ${page.duration_mins} minutes`;
  $('sd-objectives').innerHTML = (page.objectives || []).map(o => `<li>${esc(o)}</li>`).join('');

  const runs = (await allRuns()).filter(r => r.cohort_id === cid && r.session === n);
  const doneGroups = new Set(runs.filter(r => r.status === 'closed').map(r => r.group_id));
  const openGroups = new Set(runs.filter(r => r.status === 'open').map(r => r.group_id));   // multi-facilitator presence
  const groups = wpGroups(pid, cid);

  // Default to the first group not yet delivered and not currently in progress.
  let chosen = groups.find(g => !doneGroups.has(g.id) && !openGroups.has(g.id))?.id
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

  $('sd-start').addEventListener('click', () => startRun(cid, n, chosen));
}

// ═══ 6. VIDEO ════════════════════════════════════════════════════════════════
function viewVideo(cid, n) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  const page = wpSessionPage(n);
  if (!cohort || !page) return go2(H.cohorts());
  const run = activeRun.get();
  if (!run || run.cohortId !== cid || run.session !== n) return go2(H.detail(cid, n));

  show('v-video');
  rail($('vd-rail'), 1);
  const group = wpGroups(pid, cid).find(g => g.id === run.groupId);
  $('vd-eyebrow').textContent  = `${cohort.label} · Session ${n} · ${page.title}`;
  $('vd-sub').textContent      = group ? `Delivering to ${group.label}` : '';
  $('vd-question').textContent = page.question;
  if (page.video_url) $('vd-videonote').textContent = page.video_url;
  $('vd-back').addEventListener('click', e => { e.preventDefault(); go2(H.detail(cid, n)); });
  $('vd-next').addEventListener('click', () => go2(H.pledge(cid, n)));
}

// ═══ 7. PLEDGE CAPTURE ═══════════════════════════════════════════════════════
/** Create the run, roll up counters, and store the per-device active run. */
async function startRun(cid, n, groupId) {
  const pid = user.provider_id;
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

  activeRun.set({ runId: ref.id, cohortId: cid, session: n, groupId, done: [] });
  // The run opens at "Start session" (so the group shows as in progress to other
  // facilitators while the video plays), then the flow continues to the video.
  go2(H.video(cid, n));
}

function viewPledge(cid, n) {
  const run = activeRun.get();
  if (!run || run.cohortId !== cid || run.session !== n) return go2(H.detail(cid, n));   // refreshed with no run

  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  const page = wpSessionPage(n);
  if (!cohort || !page) return go2(H.cohorts());

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

function paintRoster() {
  const run = activeRun.get();
  if (!run) return;
  const roster = wpRoster(user.provider_id, run.cohortId, run.groupId);
  const done = new Set(run.done);
  $('dl-progress').textContent = `${done.size} / ${roster.length}`;
  $('dl-roster').innerHTML = roster.map(s => `
    <div class="roster-item ${done.has(s.student_ref) ? 'done' : ''} ${run.current === s.student_ref ? 'active' : ''}">
      <div class="av">${esc(initial(s.display_name))}</div>
      <div class="nm">${esc(s.display_name)}</div>
      ${done.has(s.student_ref) ? '<span class="pill ok">done</span>'
        : `<button class="btn ghost" data-ref="${esc(s.student_ref)}">Select</button>`}
    </div>`).join('');
  appEl.querySelectorAll('[data-ref]').forEach(b => b.addEventListener('click', () => selectStudent(b.dataset.ref)));
}

/** Hand a student to the widget: ref for storage, name for on-screen display only. */
function selectStudent(ref) {
  const run = activeRun.get();
  const s = wpRoster(user.provider_id, run.cohortId, run.groupId).find(x => x.student_ref === ref);
  if (!s) return;
  $('dl-frame').contentWindow.postMessage({
    type: 'TFT_SET_STUDENT', student_ref: s.student_ref, display_name: s.display_name
  }, '*');
  activeRun.set({ ...run, current: ref });
  paintRoster();
}

window.addEventListener('message', (e) => {
  const t = e.data?.type;
  const run = activeRun.get();
  if (t === 'TFT_PLEDGE_SAVED' && run?.current) {
    activeRun.set({ ...run, done: [...new Set([...run.done, run.current])], current: null });
    paintRoster();
  } else if (t === 'TFT_STUDENT_SKIPPED' && run) {
    activeRun.set({ ...run, current: null });
    paintRoster();
  } else if (t === 'TFT_HEIGHT' && $('dl-frame')) {
    $('dl-frame').style.height = e.data.height + 'px';
  }
});

// ═══ 8. COMPLETE ═════════════════════════════════════════════════════════════
async function finishRun(cid, n) {
  const run = activeRun.get();
  if (run?.runId) {
    await updateDoc(doc(db, 'providers', user.provider_id, 'runs', run.runId), { status: 'closed', ended_at: serverTimestamp() });
  }
  sessionStorage.setItem('tft26_last_run', JSON.stringify(run || {}));
  activeRun.clear();
  go2(H.complete(cid, n));
}

function viewComplete(cid, n) {
  const pid = user.provider_id;
  const cohort = wpGetCohort(pid, cid);
  const page = wpSessionPage(n);
  show('v-complete');
  rail($('cp-rail'), 3);
  let last = {};
  try { last = JSON.parse(sessionStorage.getItem('tft26_last_run')) || {}; } catch {}
  const group = wpGroups(pid, cid).find(g => g.id === last.groupId);
  const total = last.groupId ? wpRoster(pid, cid, last.groupId).length : 0;

  $('cp-title').textContent   = `Session ${n} complete`;
  $('cp-sub').textContent     = `${cohort ? cohort.label + ' · ' : ''}${page ? page.title : ''}${group ? ' · ' + group.label : ''}`;
  $('cp-pledges').textContent = (last.done || []).length;
  $('cp-of').textContent      = total;
  $('cp-cohorts').addEventListener('click', () => go2(H.cohorts()));
  $('cp-back').addEventListener('click', () => go2(H.sessions(cid)));
}

// ═══ ROUTER ══════════════════════════════════════════════════════════════════
function go2(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function route() {
  user = wpCurrentUser();
  setChrome();
  if (!user) { if (location.hash !== '#/login') return go2(H.login()); return viewLogin(); }

  const h = location.hash || '';
  const mSession = h.match(/^#\/cohort\/([^/]+)\/session\/(\d+)(?:\/(video|pledge|complete))?$/);
  if (mSession) {
    const cid = decodeURIComponent(mSession[1]);
    const n = Number(mSession[2]);
    if (n < 1 || n > SESSION_COUNT) return go2(H.sessions(cid));
    if (!wpGetCohort(user.provider_id, cid)) return go2(H.cohorts());
    if (mSession[3] === 'video')    return viewVideo(cid, n);
    if (mSession[3] === 'pledge')   return viewPledge(cid, n);
    if (mSession[3] === 'complete') return viewComplete(cid, n);
    return viewDetail(cid, n);
  }
  const mSessions = h.match(/^#\/cohort\/([^/]+)\/sessions$/);
  if (mSessions) return viewSessions(decodeURIComponent(mSessions[1]));
  const mCohort = h.match(/^#\/cohort\/([^/]+)$/);
  if (mCohort) return viewCohort(decodeURIComponent(mCohort[1]));
  if (h === '#/cohorts') return viewCohorts();

  // Default landing after login: the cohorts list.
  return go2(H.cohorts());
}

$('wp-signout').addEventListener('click', (e) => {
  e.preventDefault();
  wpSignOut(); activeRun.clear(); user = null;
  go2(H.login());
});

window.addEventListener('hashchange', route);
route();
