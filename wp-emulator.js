/**
 * wp-emulator.js — EMULATED WORDPRESS layer for the local testing environment.
 * ---------------------------------------------------------------------------
 * There is no WordPress here and no Firebase. This module stands in for the
 * WordPress side so the *methodology* can be tested end to end.
 *
 * WHY IT IS A SEPARATE MODULE WITH ITS OWN STORAGE KEY:
 *
 *   wp-emulator.js    -> localStorage['tft26_wp_emulator_v1']   HOLDS REAL NAMES
 *   local-firebase.js -> localStorage['tft26_localdb_v1']       NEVER HOLDS NAMES
 *
 * That split is the whole point. In production the first is a WordPress database
 * behind institutional logins and the second is Firestore. Keeping them as two
 * genuinely separate stores makes the privacy boundary *demonstrable* rather
 * than asserted. Call `__wp.boundaryReport()` to check it at any time.
 *
 * ── THE COHORT / GROUP MODEL ────────────────────────────────────────────────
 * A PROVIDER (institution / club) has many COHORTS. A cohort is a class, year
 * group, school or club intake — "Year 9 Rugby", "Castleford RFL Juniors",
 * "Cohort 1 – July 26". Each cohort has one or more GROUPS (teams). By default
 * a cohort has ONE group holding everyone; the facilitator adds groups to split
 * a cohort into teams (Boys / Girls, age brackets, or just smaller units so two
 * facilitators can each take a group at the same time).
 *
 *   provider ── cohorts[] ── groups[]      (a team)
 *                         └─ students[]    (each assigned to a group)
 *
 * ── WORDPRESS COMPATIBILITY ────────────────────────────────────────────────
 * Every function is shaped like something WordPress can actually provide, so
 * porting is a swap not a rewrite: wpCurrentUser() -> wp_get_current_user() +
 * provider_id user meta; wpSessionPage(n) -> a WP page per session via REST;
 * wpCohorts/wpGroups/wpAddStudent -> a custom REST namespace
 * (/wp-json/tft/v1/…), nonce-protected and capability-checked to the provider.
 * All roster calls return plain JSON-serialisable objects for the same reason.
 */

import { mintStudentRef, SESSIONS, EXPECTED_GROUP_SIZE, EXPECTED_GROUPS } from './public_widget/session-config.js';
import { buildDemoProgramme, DEMO_SEED_VERSION } from './demo-data.js';

const LS_WP      = 'tft26_wp_emulator_v1';
const LS_WP_AUTH = 'tft26_wp_session_v1';

function load()  { try { return JSON.parse(localStorage.getItem(LS_WP)) || {}; } catch { return {}; } }
function save(s) { localStorage.setItem(LS_WP, JSON.stringify(s)); }

/**
 * The permalink each step of the facilitator pathway maps to in production. The
 * emulator uses the hash equivalent. `:c` is the cohort id, `:n` the session.
 */
export const WP_ROUTES = {
  login:    { hash: '#/login',                        permalink: '/facilitator/'                                 },
  dashboard:{ hash: '#/dashboard',                    permalink: '/facilitator/dashboard/'                       },
  cohort:   { hash: '#/cohort/:c',                    permalink: '/facilitator/cohort/:c/'                       },
  sessions: { hash: '#/cohort/:c/sessions',           permalink: '/facilitator/cohort/:c/sessions/'              },
  detail:   { hash: '#/cohort/:c/session/:n',         permalink: '/facilitator/cohort/:c/session/:n/'            },
  video:    { hash: '#/cohort/:c/session/:n/video',   permalink: '/facilitator/cohort/:c/session/:n/video/'      },
  pledge:   { hash: '#/cohort/:c/session/:n/pledge',  permalink: '/facilitator/cohort/:c/session/:n/pledge/'     },
  complete: { hash: '#/cohort/:c/session/:n/complete',permalink: '/facilitator/cohort/:c/session/:n/complete/'   }
};

// ─── Seed ────────────────────────────────────────────────────────────────────
const WP_USERS = [
  { email: 'alex@democollege.ac.uk', password: 'tftdemo', display_name: 'Alex Facilitator', provider_id: 'demo-college', provider_name: 'Demo College' },
  { email: 'sam@demoacademy.ac.uk',  password: 'tftdemo', display_name: 'Sam Coordinator',  provider_id: 'demo-academy', provider_name: 'Demo Academy' }
];

(function seed() {
  const s = load();
  if (s.__seeded && s.__roster_v === DEMO_SEED_VERSION) return;

  // Demo rosters for the providers with a login, from the shared demo programme
  // (demo-data.js) — the same student refs the Firebase-side seed wrote pledges
  // for. Re-applied whenever DEMO_SEED_VERSION changes: demo cohorts are replaced
  // by cohort_id, and any cohort the visitor created themselves is kept.
  if (s.__roster_v !== DEMO_SEED_VERSION) {
    // rosters[providerId] = { cohorts: [ {cohort_id, label, groups[], students[]} ] }
    if (!s.rosters) s.rosters = {};
    const prog = buildDemoProgramme(Math.floor(Date.now() / 1000));
    for (const p of prog.providers.filter(x => x.login)) {
      const demoIds = new Set(p.cohorts.map(c => c.cohort_id));
      const own = providerCohorts(s, p.id).filter(c => !demoIds.has(c.cohort_id));
      s.rosters[p.id].cohorts = [
        ...p.cohorts.map(c => ({
          cohort_id: c.cohort_id,
          label: c.label,
          groups: c.groups.map(g => ({ id: g.id, label: g.label })),
          students: c.students.map(st => ({ student_ref: st.student_ref, display_name: st.display_name, group_id: st.group_id }))
        })),
        ...own
      ];
    }
    s.__roster_v = DEMO_SEED_VERSION;
  }

  if (s.__seeded) { save(s); return; }
  s.session_pages = SESSIONS.map(x => ({
    n: x.n,
    title: x.title,
    theme_note: x.theme_note || '',
    blurb: x.theme_note
      ? `This session explores ${x.title.toLowerCase()} (${x.theme_note.toLowerCase()}). Watch the video together, then each student makes a pledge.`
      : `This session explores ${x.title.toLowerCase()}. Watch the video together, then each student makes a pledge.`,
    objectives: [
      'Understand the theme through the session video.',
      'Choose one realistic pledge to act on this week.'
    ],
    duration_mins: 45,
    video_url: x.video_url || '',
    video_length: '—',
    question: x.question,
    prompt: x.prompt,
    options: x.options.slice()
  }));
  s.__seeded = true;
  save(s);
})();

// ─── Auth (stands in for the WordPress login) ────────────────────────────────
export function wpSignIn(email, password) {
  const u = WP_USERS.find(x => x.email === email && x.password === password);
  if (!u) throw new Error('Invalid WordPress credentials');
  localStorage.setItem(LS_WP_AUTH, u.email);
  return publicUser(u);
}
export function wpCurrentUser() {
  const email = localStorage.getItem(LS_WP_AUTH);
  const u = email && WP_USERS.find(x => x.email === email);
  return u ? publicUser(u) : null;
}
export function wpSignOut() { localStorage.removeItem(LS_WP_AUTH); }
export function wpAccounts() { return WP_USERS.map(u => ({ email: u.email, password: u.password, provider: u.provider_name, display_name: u.display_name })); }
function publicUser(u) {
  return { email: u.email, display_name: u.display_name, provider_id: u.provider_id, provider_name: u.provider_name };
}

// ─── Session page content (WP pages) ─────────────────────────────────────────
export function wpSessionPage(n)  { return load().session_pages.find(p => p.n === Number(n)) || null; }
export function wpSessionPages()  { return load().session_pages; }

// ═══ Cohorts ═════════════════════════════════════════════════════════════════
function providerCohorts(store, providerId) {
  if (!store.rosters[providerId]) store.rosters[providerId] = { cohorts: [] };
  if (!store.rosters[providerId].cohorts) store.rosters[providerId].cohorts = [];
  return store.rosters[providerId].cohorts;
}

function slugId(label) {
  const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'cohort';
  return base + '-' + Math.random().toString(36).slice(2, 6);
}

/** All cohorts for a provider, each with light counts for list display. */
export function wpCohorts(providerId) {
  return providerCohorts(load(), providerId).map(c => ({
    cohort_id: c.cohort_id,
    label: c.label,
    groups: (c.groups || []).length,
    students: (c.students || []).length
  }));
}
export function wpHasAnyCohort(providerId) { return providerCohorts(load(), providerId).length > 0; }
export function wpGetCohort(providerId, cohortId) {
  return providerCohorts(load(), providerId).find(c => c.cohort_id === cohortId) || null;
}

/** Create a cohort with a generated id and one default group holding everyone. */
export function wpCreateCohort(providerId, label) {
  const s = load();
  const cohorts = providerCohorts(s, providerId);
  const cohort = {
    cohort_id: slugId(label || 'cohort'),
    label: (label || '').trim() || `Cohort ${cohorts.length + 1}`,
    groups: [{ id: 'g1', label: 'Group 1' }],
    students: []
  };
  cohorts.push(cohort);
  save(s);
  return cohort;
}

export function wpRenameCohort(providerId, cohortId, label) {
  const s = load();
  const c = providerCohorts(s, providerId).find(x => x.cohort_id === cohortId);
  if (!c) return false;
  c.label = String(label).trim() || c.label;
  save(s);
  return true;
}

export function wpDeleteCohort(providerId, cohortId) {
  const s = load();
  const r = s.rosters[providerId];
  if (!r) return false;
  r.cohorts = (r.cohorts || []).filter(c => c.cohort_id !== cohortId);
  save(s);
  return true;
}

// ═══ Groups (within a cohort) ═════════════════════════════════════════════════
export function wpGroups(providerId, cohortId) {
  const c = wpGetCohort(providerId, cohortId);
  return c ? (c.groups || []).slice() : [];
}

export function wpAddGroup(providerId, cohortId, label) {
  const s = load();
  const c = providerCohorts(s, providerId).find(x => x.cohort_id === cohortId);
  if (!c) throw new Error('No such cohort: ' + cohortId);
  const n = (c.groups || []).length + 1;
  const g = { id: 'g' + n + '_' + Math.random().toString(36).slice(2, 6), label: label || ('Group ' + n) };
  c.groups = [...(c.groups || []), g];
  save(s);
  return g;
}

export function wpRenameGroup(providerId, cohortId, groupId, label) {
  const s = load();
  const c = providerCohorts(s, providerId).find(x => x.cohort_id === cohortId);
  const g = c && (c.groups || []).find(x => x.id === groupId);
  if (!g) return false;
  g.label = String(label).trim() || g.label;
  save(s);
  return true;
}

/** Removing a group reassigns its students to the first remaining group. */
export function wpRemoveGroup(providerId, cohortId, groupId) {
  const s = load();
  const c = providerCohorts(s, providerId).find(x => x.cohort_id === cohortId);
  if (!c || (c.groups || []).length <= 1) return false;
  c.groups = c.groups.filter(g => g.id !== groupId);
  const fallback = c.groups[0].id;
  c.students.forEach(st => { if (st.group_id === groupId) st.group_id = fallback; });
  save(s);
  return true;
}

// ═══ Students (within a cohort, assigned to a group) ══════════════════════════
/**
 * Add a student. The ONLY place a real name is recorded and the only place a
 * student_ref is minted. Returns the ref — all the caller should pass onward.
 */
export function wpAddStudent(providerId, cohortId, displayName, groupId) {
  const s = load();
  const c = providerCohorts(s, providerId).find(x => x.cohort_id === cohortId);
  if (!c) throw new Error('No such cohort: ' + cohortId);
  const ref = mintStudentRef();
  c.students.push({
    student_ref: ref,
    display_name: String(displayName).trim(),
    group_id: groupId || (c.groups[0] && c.groups[0].id) || 'g1'
  });
  save(s);
  return ref;
}

export function wpUpdateStudent(providerId, cohortId, ref, patch) {
  const s = load();
  const c = providerCohorts(s, providerId).find(x => x.cohort_id === cohortId);
  const st = c && (c.students || []).find(x => x.student_ref === ref);
  if (!st) return false;
  if (patch.display_name != null) st.display_name = String(patch.display_name).trim();
  if (patch.group_id != null)     st.group_id     = patch.group_id;
  save(s);
  return true;
}

export function wpRemoveStudent(providerId, cohortId, ref) {
  const s = load();
  const c = providerCohorts(s, providerId).find(x => x.cohort_id === cohortId);
  if (!c) return false;
  c.students = (c.students || []).filter(st => st.student_ref !== ref);
  save(s);
  return true;
}

/** The roster for a cohort (optionally one group). Names included, client-side only. */
export function wpRoster(providerId, cohortId, groupId) {
  const c = wpGetCohort(providerId, cohortId);
  if (!c) return [];
  const all = (c.students || []).slice();
  return groupId ? all.filter(s => s.group_id === groupId) : all;
}

/**
 * Resolve a pseudonymous ref back to a human name. Searches every cohort of the
 * provider (refs are globally unique).
 *
 * ⚠ This is the re-identification step. In production it exists ONLY inside
 * WordPress, behind the institutional login. The admin console and the Firebase
 * data can never call it — which is why pledges stay pseudonymous in reporting.
 */
export function wpResolveName(providerId, ref) {
  for (const c of providerCohorts(load(), providerId)) {
    const hit = (c.students || []).find(s => s.student_ref === ref);
    if (hit) return hit.display_name;
  }
  return null;
}

/** Soft caps for one cohort — warn, never block. */
export function wpCapStatus(providerId, cohortId) {
  const groups = wpGroups(providerId, cohortId);
  const overSized = groups
    .map(g => ({ ...g, count: wpRoster(providerId, cohortId, g.id).length }))
    .filter(g => g.count > EXPECTED_GROUP_SIZE);
  return {
    students: wpRoster(providerId, cohortId).length,
    groups: groups.length,
    groupSizeCap: EXPECTED_GROUP_SIZE,
    groupCap: EXPECTED_GROUPS,
    overSizedGroups: overSized,
    tooManyGroups: groups.length > EXPECTED_GROUPS
  };
}

// ─── Boundary inspector (dev tool) ───────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.__wp = {
    dump: () => load(),
    accounts: wpAccounts(),
    routes: WP_ROUTES,
    reset() { localStorage.removeItem(LS_WP); localStorage.removeItem(LS_WP_AUTH); location.reload(); },

    /** Prove the boundary holds: scan BOTH stores and report where names appear. */
    boundaryReport() {
      const wpRaw = localStorage.getItem(LS_WP) || '';
      const fbRaw = localStorage.getItem('tft26_localdb_v1') || '';
      const names = [];
      Object.values(load().rosters || {}).forEach(r =>
        (r.cohorts || []).forEach(c =>
          (c.students || []).forEach(s => names.push(s.display_name))));
      const leaked = names.filter(n => n && fbRaw.includes(n));
      return {
        namesOnRecord: names.length,
        wordpressStoreBytes: wpRaw.length,
        firebaseStoreBytes: fbRaw.length,
        namesFoundInFirebaseStore: leaked,
        verdict: leaked.length === 0
          ? 'PASS — no student name appears in the Firebase-side store'
          : 'FAIL — names leaked across the boundary: ' + leaked.join(', ')
      };
    }
  };
}
