/**
 * local-firebase.js — LOCAL-TESTING-ONLY Firebase shim for TFT26
 * ---------------------------------------------------------------------------
 * A tiny, dependency-free re-implementation of the *subset* of the Firebase
 * 10.12 modular SDK that the TFT26 widgets and admin console actually call
 * (Firestore doc/collection/query/onSnapshot/runTransaction/writeBatch + a
 * mock Email/Password Auth with custom claims). Data lives in localStorage, so
 * it behaves like a simple persistent database and survives page reloads, and
 * changes propagate across same-origin tabs/iframes via the `storage` event.
 *
 * WHY THIS EXISTS: this tree has no Firebase project of its own, and the
 * codebase it was forked from shared a project with a live campaign. Routing
 * everything through a local shim means concept work cannot reach real data.
 * The widgets import from here instead of `https://www.gstatic.com/...`.
 *
 * ⚠ NOT FOR PRODUCTION. Not atomic, not secure, no rules enforcement. When
 * reconnecting real Firebase, revert the import lines back to the gstatic CDN
 * (see TFT_STEERING_HANDOVER.md for the exact checklist).
 * ---------------------------------------------------------------------------
 */

import { SESSIONS } from './public_widget/session-config.js';

const LS_DB   = 'tft26_localdb_v1';
const LS_AUTH = 'tft26_localauth_v1';

// ── Store (flat map keyed by document path "col/id" or "col/id/sub/id2") ─────
function loadStore() { try { return JSON.parse(localStorage.getItem(LS_DB)) || {}; } catch { return {}; } }
function saveStore(s) { localStorage.setItem(LS_DB, JSON.stringify(s)); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

// ── Field-value sentinels (increment / arrayUnion / serverTimestamp) ─────────
class Sentinel { constructor(type, operand) { this._type = type; this._operand = operand; } }
export function increment(n)     { return new Sentinel('increment', n); }
export function arrayUnion(...v) { return new Sentinel('arrayUnion', v); }
export function serverTimestamp(){ return new Sentinel('serverTimestamp'); }

function resolveValue(existing, value) {
  if (value instanceof Sentinel) {
    if (value._type === 'increment') return (typeof existing === 'number' ? existing : 0) + value._operand;
    if (value._type === 'arrayUnion') {
      const arr = Array.isArray(existing) ? existing.slice() : [];
      for (const item of value._operand) {
        if (!arr.some(e => JSON.stringify(e) === JSON.stringify(item))) arr.push(item);
      }
      return arr;
    }
    if (value._type === 'serverTimestamp') {
      // Firestore Timestamp shape — admin console reads `.seconds`.
      return { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 };
    }
  }
  return value;
}

// ── References ───────────────────────────────────────────────────────────────
class DocRef  { constructor(path) { this.path = path; this.id = path.split('/').pop(); } }
class CollRef { constructor(path) { this.path = path; } }
class Query   { constructor(collPath, constraints) { this.collPath = collPath; this.constraints = constraints; } }

export function doc(dbOrColl, ...segs) {
  if (dbOrColl instanceof CollRef) return new DocRef(dbOrColl.path + '/' + (segs[0] || genId()));
  return new DocRef(segs.join('/'));
}
export function collection(db, ...segs) { return new CollRef(segs.join('/')); }
export function query(collRef, ...constraints) { return new Query(collRef.path, constraints); }
export function orderBy(field, dir = 'asc') { return { _c: 'orderBy', field, dir }; }
export function where(field, op, val)        { return { _c: 'where', field, op, val }; }
export function limit(n)                      { return { _c: 'limit', n }; }

// ── Snapshots ────────────────────────────────────────────────────────────────
function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
function docSnap(path, data) {
  return {
    id: path.split('/').pop(),
    ref: new DocRef(path),
    exists() { return data !== undefined; },
    data() { return clone(data); },
    get(f) { return data ? data[f] : undefined; }
  };
}
function makeDocSnap(path) { return docSnap(path, loadStore()[path]); }

// ── Reads ────────────────────────────────────────────────────────────────────
export async function getDoc(ref) { return makeDocSnap(ref.path); }

function childDocsOf(collPath) {
  const store = loadStore();
  const prefix = collPath + '/';
  const out = [];
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
      out.push({ id: key.slice(prefix.length), path: key, data: store[key] });
    }
  }
  return out;
}
function cmp(a, b) {
  if (a && b && typeof a === 'object' && 'seconds' in a) { a = a.seconds; b = b?.seconds ?? 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}
function applyOp(v, op, val) {
  switch (op) {
    case '==': return v === val;
    case '!=': return v !== val;
    case '>':  return v > val;
    case '>=': return v >= val;
    case '<':  return v < val;
    case '<=': return v <= val;
    case 'in': return Array.isArray(val) && val.includes(v);
    default:   return true;
  }
}
export async function getDocs(qOrColl) {
  const collPath = qOrColl instanceof Query ? qOrColl.collPath : qOrColl.path;
  const constraints = qOrColl instanceof Query ? qOrColl.constraints : [];
  let docs = childDocsOf(collPath);
  for (const c of constraints) if (c._c === 'where') docs = docs.filter(d => applyOp(d.data[c.field], c.op, c.val));
  for (const c of constraints) if (c._c === 'orderBy') docs.sort((a, b) => cmp(a.data[c.field], b.data[c.field]) * (c.dir === 'desc' ? -1 : 1));
  for (const c of constraints) if (c._c === 'limit') docs = docs.slice(0, c.n);
  const snaps = docs.map(d => docSnap(d.path, d.data));
  return { docs: snaps, empty: snaps.length === 0, size: snaps.length, forEach(cb) { snaps.forEach(cb); } };
}

// ── Writes ───────────────────────────────────────────────────────────────────
function writeDoc(path, data, merge) {
  const store = loadStore();
  const existing = store[path] || {};
  const result = merge ? { ...existing } : {};
  for (const [k, v] of Object.entries(data)) result[k] = resolveValue(existing[k], v);
  store[path] = result;
  saveStore(store);
  scheduleNotify(path);
}
export async function setDoc(ref, data, options) { writeDoc(ref.path, data, !!(options && options.merge)); }
export async function updateDoc(ref, data)       { writeDoc(ref.path, data, true); }
export async function addDoc(collRef, data)      { const id = genId(); writeDoc(collRef.path + '/' + id, data, false); return new DocRef(collRef.path + '/' + id); }
export async function deleteDoc(ref)             { const s = loadStore(); delete s[ref.path]; saveStore(s); scheduleNotify(ref.path); }

export async function runTransaction(db, updateFn) {
  // Not truly isolated/atomic — adequate for single-user local testing.
  const t = {
    get:    async (ref) => makeDocSnap(ref.path),
    set:    (ref, data, options) => writeDoc(ref.path, data, !!(options && options.merge)),
    update: (ref, data) => writeDoc(ref.path, data, true),
    delete: (ref) => { const s = loadStore(); delete s[ref.path]; saveStore(s); scheduleNotify(ref.path); }
  };
  return updateFn(t);
}

export function writeBatch(db) {
  const ops = [];
  return {
    set:    (ref, data, options) => { ops.push(() => writeDoc(ref.path, data, !!(options && options.merge))); },
    update: (ref, data) => { ops.push(() => writeDoc(ref.path, data, true)); },
    delete: (ref) => { ops.push(() => { const s = loadStore(); delete s[ref.path]; saveStore(s); scheduleNotify(ref.path); }); },
    commit: async () => { for (const op of ops) op(); }
  };
}

// ── Realtime listeners (in-tab microtask + cross-tab storage event) ──────────
const listeners = [];
export function onSnapshot(refOrQuery, cb) {
  let entry;
  if (refOrQuery instanceof DocRef) {
    entry = { test: p => p === refOrQuery.path, emit: () => cb(makeDocSnap(refOrQuery.path)) };
  } else {
    const collPath = refOrQuery instanceof Query ? refOrQuery.collPath : refOrQuery.path;
    entry = { test: p => p.startsWith(collPath + '/'), emit: async () => cb(await getDocs(refOrQuery)) };
  }
  listeners.push(entry);
  entry.emit();
  return () => { const i = listeners.indexOf(entry); if (i >= 0) listeners.splice(i, 1); };
}
function scheduleNotify(path) {
  Promise.resolve().then(() => { for (const l of listeners.slice()) if (l.test(path)) l.emit(); });
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => { if (e.key === LS_DB) for (const l of listeners.slice()) l.emit(); });
}

// ── App / Firestore / App Check (no-ops) ─────────────────────────────────────
export function initializeApp(config) { return { __app: true, options: config }; }
export function getFirestore(app)      { return { __db: true }; }
export function initializeAppCheck()   { return { __appcheck: true }; }
export class ReCaptchaEnterpriseProvider { constructor() {} }

// ── Mock Auth (Email/Password + custom claims) ───────────────────────────────
// Seeded local accounts. `admin` mirrors the production admin custom claim; the
// facilitator account carries `provider: <providerId>`, binding it to exactly
// one institution (production equivalent is minted by set-provider-claim.js).
//
// NOTE: students are NOT accounts. They never authenticate. A student is only
// ever a pseudonymous `student_ref`; the facilitator is the only signed-in
// human in the room.
const LS_USERS = 'tft26_localusers_v1';
const SEED_USERS = [
  { uid: 'admin-local',       email: 'admin@local',       password: 'admin',       claims: { admin: true } },
  { uid: 'facilitator-local', email: 'facilitator@local', password: 'facilitator', claims: { provider: 'demo-college' } },
  // Capture-device account — locked down: can ONLY run the pledge capture page,
  // never the provider dashboard. This is what stays signed in on the shared iPad.
  { uid: 'capture-local',     email: 'capture@local',     password: 'capture',     claims: { provider: 'demo-college', capture: true } }
];
// Accounts created at runtime (e.g. providers provisioned via the admin console).
function loadUsers() { try { return JSON.parse(localStorage.getItem(LS_USERS)) || []; } catch { return []; } }
function saveUsers(u) { localStorage.setItem(LS_USERS, JSON.stringify(u)); }
function allUsers() { return [...SEED_USERS, ...loadUsers()]; }

function makeUser(u) {
  return {
    uid: u.uid,
    email: u.email,
    getIdToken: async () => 'local-token',
    getIdTokenResult: async () => ({ claims: { ...u.claims } })
  };
}
let currentUser = null;
const authListeners = [];
(function restoreSession() {
  const uid = localStorage.getItem(LS_AUTH);
  const u = allUsers().find(x => x.uid === uid);
  if (u) currentUser = makeUser(u);
})();

export function getAuth(app) { return { __auth: true }; }
export async function signInWithEmailAndPassword(auth, email, password) {
  const u = allUsers().find(x => x.email === email && x.password === password);
  if (!u) { const err = new Error('Invalid credentials (local)'); err.code = 'auth/invalid-credential'; throw err; }
  currentUser = makeUser(u);
  localStorage.setItem(LS_AUTH, u.uid);
  authListeners.slice().forEach(cb => cb(currentUser));
  return { user: currentUser };
}
export async function signOut(auth) {
  currentUser = null;
  localStorage.removeItem(LS_AUTH);
  authListeners.slice().forEach(cb => cb(null));
}
export function onAuthStateChanged(auth, cb) {
  authListeners.push(cb);
  Promise.resolve().then(() => cb(currentUser));
  return () => { const i = authListeners.indexOf(cb); if (i >= 0) authListeners.splice(i, 1); };
}

// ── First-run seed data (so widgets render meaningfully offline) ─────────────
(function seedIfEmpty() {
  const store = loadStore();
  if (store.__seeded) return;
  const now = Math.floor(Date.now() / 1000);
  const ts  = (agoSecs) => ({ seconds: now - agoSecs, nanoseconds: 0 });

  // ── The 6 session definitions (admin-editable in production) ───────────────
  // Seeded from the single source of truth in session-config.js so the stored
  // sessions/{n} documents and the widget's built-in fallback never drift.
  // Real video URLs still need to be added by the programme team.
  SESSIONS.forEach(s => {
    store['sessions/' + s.n] = {
      n: s.n,
      title: s.title,
      theme_note: s.theme_note || '',
      video_url: s.video_url || '',
      question: s.question,
      prompt: s.prompt,
      options: s.options.slice(),
      active: true
    };
  });

  // ── Cross-provider aggregate: the "All Providers" per-session totals ───────
  store['public/session-totals'] = {
    s1_runs: 3, s1_pledges: 61, s2_runs: 2, s2_pledges: 44, s3_runs: 1, s3_pledges: 18,
    s4_runs: 0, s4_pledges: 0,  s5_runs: 0, s5_pledges: 0,  s6_runs: 0, s6_pledges: 0,
    total_pledges: 123
  };
  store['public/banned-words'] = { words: [] };

  // ── Demo provider — matches the seeded `facilitator@local` account whose
  //    custom claim is `provider: 'demo-college'`. NOT public; owner + admin.
  store['providers/demo-college'] = {
    name: 'Demo College',
    active: true,
    max_students: 96,          // soft cap — warns, never blocks
    session_stats: {
      s1: { runs: 2, pledges: 41, last_run_at: ts(86400 * 14) },
      s2: { runs: 1, pledges: 22, last_run_at: ts(86400 * 7) },
      s3: { runs: 1, pledges: 18, last_run_at: ts(3600) },
      s4: { runs: 0, pledges: 0,  last_run_at: null },
      s5: { runs: 0, pledges: 0,  last_run_at: null },
      s6: { runs: 0, pledges: 0,  last_run_at: null }
    },
    created_at: ts(86400 * 30),
    updated_at: ts(3600)
  };
  // Adult contact details live OUTSIDE the provider doc so a facilitator's own
  // read of /providers/{id} never returns them. Admin-only.
  store['providers_private/demo-college'] = {
    contact_name: 'Alex Facilitator',
    contact_email: 'lead@democollege.ac.uk',
    registered_at: ts(86400 * 30)
  };

  // A second provider, so "All Providers" totals have something to aggregate.
  store['providers/demo-academy'] = {
    name: 'Demo Academy',
    active: true,
    max_students: 96,
    session_stats: {
      s1: { runs: 1, pledges: 20, last_run_at: ts(86400 * 3) },
      s2: { runs: 1, pledges: 22, last_run_at: ts(86400 * 2) },
      s3: { runs: 0, pledges: 0, last_run_at: null },
      s4: { runs: 0, pledges: 0, last_run_at: null },
      s5: { runs: 0, pledges: 0, last_run_at: null },
      s6: { runs: 0, pledges: 0, last_run_at: null }
    },
    created_at: ts(86400 * 20),
    updated_at: ts(86400 * 2)
  };
  store['providers_private/demo-academy'] = {
    contact_name: 'Sam Coordinator',
    contact_email: 'programme@demoacademy.ac.uk',
    registered_at: ts(86400 * 20)
  };

  // ── Cohort — one intake. Re-running the programme next year creates a NEW
  //    cohort with a fresh ID pool, so a student_ref always means one human.
  store['providers/demo-college/cohorts/intake-2026'] = {
    label: '2026/27 intake', active: true, student_count: 3
  };
  // Groups mirror the WordPress-side roster structure. A run is one session
  // delivered to ONE group, which is why the same session can run 4×.
  store['providers/demo-college/cohorts/intake-2026/groups/g1'] = { label: 'Group 1' };
  store['providers/demo-college/cohorts/intake-2026/groups/g2'] = { label: 'Group 2' };
  // Student slots: pseudonymous only. The real names live in WordPress and are
  // never written here — firestore.rules hard-rejects identifying fields.
  store['providers/demo-college/cohorts/intake-2026/students/p_a7f3c21b'] = { group: 1, active: true, created_at: ts(86400 * 21) };
  store['providers/demo-college/cohorts/intake-2026/students/p_4e9d0f76'] = { group: 1, active: true, created_at: ts(86400 * 21) };
  store['providers/demo-college/cohorts/intake-2026/students/p_b2c85a14'] = { group: 2, active: true, created_at: ts(86400 * 21) };

  // ── Runs — one delivery of one session to one GROUP. Session 1 was delivered
  //    twice, to two different groups: the normal case for a provider running
  //    the same session with each of their groups in turn.
  store['providers/demo-college/runs/run-s1-a'] = {
    session: 1, cohort_id: 'intake-2026', group_id: 'g1', status: 'closed',
    pledge_count: 21, started_at: ts(86400 * 21), ended_at: ts(86400 * 21 - 3600)
  };
  store['providers/demo-college/runs/run-s1-b'] = {
    session: 1, cohort_id: 'intake-2026', group_id: 'g2', status: 'closed',
    pledge_count: 20, started_at: ts(86400 * 14), ended_at: ts(86400 * 14 - 3600)
  };
  store['providers/demo-college/runs/run-s3-a'] = {
    session: 3, cohort_id: 'intake-2026', group_id: 'g1', status: 'open',
    pledge_count: 3, started_at: ts(3600), ended_at: null
  };

  // ── Pledges — the captured data. student_ref only; never a name.
  //    `option` 1-5 is a predefined choice (pledge_text is the canonical option
  //    text); option 6 is the student's own free-text suggestion.
  const s3opts = SESSIONS[2].options;   // session 3 predefined options
  store['providers/demo-college/runs/run-s3-a/pledges/pl1'] = {
    student_ref: 'p_a7f3c21b', session: 3, cohort_id: 'intake-2026',
    option: 1, pledge_text: s3opts[0],
    status: 'approved', created_at: ts(3400)
  };
  store['providers/demo-college/runs/run-s3-a/pledges/pl2'] = {
    student_ref: 'p_4e9d0f76', session: 3, cohort_id: 'intake-2026',
    option: 3, pledge_text: s3opts[2],
    status: 'pending', created_at: ts(3300)
  };
  store['providers/demo-college/runs/run-s3-a/pledges/pl3'] = {
    student_ref: 'p_b2c85a14', session: 3, cohort_id: 'intake-2026',
    option: 6, pledge_text: 'I will ask my family to buy loose fruit and veg instead of packaged.',
    status: 'pending', created_at: ts(3200)
  };

  store.__seeded = true;
  saveStore(store);
})();

// ── Dev helpers (console: __localdb.reset() / .dump()) ───────────────────────
if (typeof window !== 'undefined') {
  window.__localdb = {
    reset() { localStorage.removeItem(LS_DB); localStorage.removeItem(LS_AUTH); localStorage.removeItem(LS_USERS); location.reload(); },
    dump()  { return loadStore(); },
    users() { return allUsers().map(u => ({ email: u.email, password: u.password, claims: u.claims })); },
    accounts: SEED_USERS.map(u => ({ email: u.email, password: u.password, claims: u.claims })),
    // LOCAL-ONLY facilitator provisioning. In production the provider→claim
    // binding must be done server-side with set-provider-claim.js (the client
    // SDK cannot set custom claims) — see TFT_STEERING_HANDOVER.md.
    createProviderAccount(email, password, providerId) {
      const users = loadUsers();
      const existing = users.find(u => u.email === email);
      if (existing) { existing.password = password; existing.claims = { provider: providerId }; }
      else { users.push({ uid: 'provider-' + providerId, email, password, claims: { provider: providerId } }); }
      saveUsers(users);
      return true;
    },
    removeProviderAccount(providerId) {
      saveUsers(loadUsers().filter(u => !(u.claims && u.claims.provider === providerId)));
      return true;
    }
  };
}
