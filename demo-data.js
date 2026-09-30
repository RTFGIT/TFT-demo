/**
 * demo-data.js — the "lived-in programme" used by BOTH demo modes.
 * ---------------------------------------------------------------------------
 * One deterministic generator feeds:
 *
 *   local-firebase.js        Sandbox Firestore stand-in (pseudonymous data only)
 *   wp-emulator.js           Sandbox WordPress rosters (the ONLY place names live)
 *   scripts/live/seed.mjs    the Live Firebase project (pseudonymous data only)
 *
 * so Sandbox and Live show the same programme, and the student refs on the
 * WordPress roster match the pledges stored on the Firebase side.
 *
 * `buildDemoProgramme(nowSecs)` returns plain JSON. Every timestamp is a number
 * of EPOCH SECONDS relative to `nowSecs`; callers convert them to whatever
 * timestamp type their backend uses. Everything except the timestamps is
 * identical on every call (seeded PRNG, hashed ids).
 *
 * PRIVACY: `display_name` exists only on `cohorts[].students[]`, which is for
 * the WordPress roster. Nothing that is written to Firebase carries a name.
 *
 * Pure ES module — no browser or Node APIs, so both can import it.
 * ---------------------------------------------------------------------------
 */

import { SESSIONS } from './public_widget/session-config.js';
import { SURVEY, surveyId, tallyLabels } from './public_widget/survey-config.js';

/** Bump when the generated programme changes, so stored seeds refresh. */
export const DEMO_SEED_VERSION = 6;

// ─── Deterministic helpers ───────────────────────────────────────────────────
/** 32-bit FNV-1a with a murmur3 finaliser (good avalanche, tiny). */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
/** mulberry32 — small seeded PRNG returning [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Salt fixed at v3 so later version bumps (new fields) keep the same names and data.
const rngFor = (key) => mulberry32(hash32('tft-demo-v3/' + key));
const hex8 = (n) => n.toString(16).padStart(8, '0');
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const intBetween = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
function shuffled(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function weightedIndex(rng, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r < 0) return i; }
  return weights.length - 1;
}

/** Deterministic pseudonymous ref: 'p_' + 16 hex. Matches ^p_[a-z0-9]{6,32}$. */
function demoStudentRef(providerId, cohortId, index) {
  const key = `${providerId}/${cohortId}/${index}`;
  return 'p_' + hex8(hash32(key + '#a')) + hex8(hash32(key + '#b'));
}

// ─── Fake UK-style names (WordPress roster only) ─────────────────────────────
const GIRLS = ['Ava', 'Olivia', 'Amelia', 'Isla', 'Freya', 'Mia', 'Poppy', 'Evie', 'Ruby', 'Sophia',
  'Aisha', 'Zara', 'Maryam', 'Amara', 'Priya', 'Nia', 'Imani', 'Chloe', 'Ella', 'Lily', 'Harper',
  'Maisie', 'Leah', 'Esme', 'Niamh', 'Saoirse', 'Ffion', 'Megan', 'Holly', 'Jasmine', 'Layla',
  'Hana', 'Mei', 'Aaliyah', 'Keira', 'Iqra', 'Thandi', 'Zofia', 'Anya', 'Kiera'];
const BOYS = ['Oliver', 'Noah', 'Leo', 'Oscar', 'Harry', 'Jack', 'Charlie', 'George', 'Alfie',
  'Muhammad', 'Arthur', 'Theo', 'Jacob', 'Ethan', 'Kai', 'Reuben', 'Ibrahim', 'Yusuf', 'Arjun',
  'Rohan', 'Kofi', 'Tariq', 'Callum', 'Rhys', 'Finlay', 'Lewis', 'Owen', 'Dylan', 'Tyler', 'Riley',
  'Jayden', 'Mason', 'Logan', 'Ollie', 'Zain', 'Hamza', 'Emeka', 'Tomasz', 'Jakub', 'Luca',
  'Mateo', 'Ciaran', 'Declan', 'Bilal', 'Samir'];
const INITIALS = 'ABCDEFGHJKLMNOPRSTWY'.split('');
/** Every first name the generator can use — exported so checks can scan for leaks. */
export const DEMO_FIRST_NAMES = [...GIRLS, ...BOYS];

// ─── Pledge behaviour ────────────────────────────────────────────────────────
/** Relative popularity of predefined options 1–5, per session (a favourite or two). */
const OPTION_WEIGHTS = {
  1: [6, 2, 3, 2, 3],   // walking is the easy win
  2: [6, 3, 2, 1, 3],   // trying a new food
  3: [3, 3, 6, 3, 1],   // chocolate → fruit swap
  4: [2, 6, 4, 2, 1],   // water as the go-to drink
  5: [3, 4, 6, 1, 4],   // reusing a water bottle
  6: [3, 5, 1, 6, 2]    // litter picking, wild flowers
};
const OWN_IDEA_RATE = 0.125;

/** Option 6: short first-person own ideas, age 9–15 voice. Never a person's name. */
const OWN_IDEAS = {
  1: ['I will ask if we can car share to training with my teammates.',
      'I will turn the heating down a bit and wear a jumper instead.',
      'I will get the bus to the match on Saturday instead of a lift.',
      'I will have a meat free day with my family this week.',
      'I will make a poster about climate change for our classroom.',
      'I will scoot to school every day this week.'],
  2: ['I will take my leftovers home in a tub instead of binning them.',
      'I will help make soup with the veg that is going soft.',
      'I will only put on my plate what I know I can eat.',
      'I will check the fridge before we go shopping so we don’t buy double.',
      'I will freeze the bread so it doesn’t go mouldy.',
      'I will make smoothies with the old bananas.'],
  3: ['I will have a banana before training instead of crisps.',
      'I will help cook a veg curry at home.',
      'I will try a smoothie with spinach in it.',
      'I will bring carrot sticks in my lunchbox.',
      'I will ask if we can grow tomatoes in the garden.',
      'I will add frozen peas to my pasta.'],
  4: ['I will have porridge for breakfast before school.',
      'I will swap my fizzy drink for water with fruit in it.',
      'I will eat a proper breakfast on match days.',
      'I will try wholemeal pasta at tea time.',
      'I will take a bottle of water to every training session.',
      'I will have beans on toast instead of a takeaway.'],
  5: ['I will make a recycling box for my bedroom.',
      'I will use a lunchbox instead of cling film.',
      'I will take a bag for life when we go shopping.',
      'I will have shorter showers after training.',
      'I will fix my old boots instead of getting new ones.',
      'I will give my old books to the school library.'],
  6: ['I will make a bird feeder for the garden.',
      'I will build a bug hotel with my little brother.',
      'I will put a bowl of water out for the hedgehogs.',
      'I will pick up litter after training at the club.',
      'I will leave a bit of the garden to grow wild.',
      'I will plant sunflower seeds in a pot.']
};

// ─── The programme plan ──────────────────────────────────────────────────────
// Per group: `day` is the weekday it is taught (1 = Mon … 5 = Fri) and
// `weeks[i]` is how many weeks back session i+1 was delivered (0 = the most
// recent such weekday before today). 'open' = in progress right now.
// Runs with weeks <= 1 (i.e. within the last fortnight) are "recent" and still
// have some pledges awaiting moderation.
const PLAN = [
  { id: 'demo-college', name: 'Demo College', login: true, foundation: 'Northvale RL Foundation',
    contact_name: 'Alex Facilitator', contact_email: 'lead@democollege.ac.uk',
    cohorts: [
      { id: 'year9-rugby', label: 'Year 9 Rugby', groups: [
        { id: 'g1', label: 'Boys',  sex: 'm', size: 14, day: 2, weeks: [4, 3, 2, 1, 0] },
        { id: 'g2', label: 'Girls', sex: 'f', size: 12, day: 4, weeks: [4, 3, 2, 1] }] },
      { id: 'year10-enrichment', label: 'Year 10 Enrichment', groups: [
        { id: 'g1', label: 'Group 1', size: 16, day: 3, weeks: [1, 0] }] },
      { id: 'year8-taster', label: 'Year 8 Taster', groups: [
        { id: 'g1', label: 'Group 1', size: 12, day: 5, weeks: [] }] },
      // Finished the whole programme last term.
      { id: 'year7-tag-rugby', label: 'Year 7 Tag Rugby', groups: [
        { id: 'g1', label: 'Group 1', size: 15, day: 1, weeks: [11, 10, 9, 8, 7, 6] }] },
      // Groups that started in different weeks — then went quiet (dashboard: needs attention).
      { id: 'after-school-club', label: 'After-School Club', groups: [
        { id: 'g1', label: 'Juniors', size: 10, day: 3, weeks: [8, 7, 6] },
        { id: 'g2', label: 'Inters',  size: 11, day: 3, weeks: [7, 6] },
        { id: 'g3', label: 'Seniors', size: 9,  day: 3, weeks: [6] }] },
      // Mid-session right now on a colleague's device (dashboard: live now).
      { id: 'year8-pe', label: 'Year 8 PE', groups: [
        { id: 'g1', label: 'Group A', size: 13, day: 2, weeks: [2, 1, 'open'] },
        { id: 'g2', label: 'Group B', size: 12, day: 4, weeks: [2, 1, 0] }] }
    ] },
  { id: 'demo-academy', name: 'Demo Academy', login: true, foundation: 'Eastbrook Community Foundation',
    contact_name: 'Sam Coordinator', contact_email: 'programme@demoacademy.ac.uk',
    cohorts: [
      { id: 'year7-healthy-futures', label: 'Year 7 Healthy Futures', groups: [
        { id: 'g1', label: 'Group A', size: 13, day: 1, weeks: [1, 0] },
        { id: 'g2', label: 'Group B', size: 12, day: 5, weeks: [1, 0] }] },
      { id: 'year10-sports-leaders', label: 'Year 10 Sports Leaders', groups: [
        { id: 'g1', label: 'Group 1', size: 14, day: 3, weeks: [6, 5, 4, 2, 1] }] }
    ] },
  { id: 'demo-northfield', name: 'Northfield Academy', login: false, foundation: 'Northvale RL Foundation',
    contact_name: 'Jordan Blake', contact_email: 'pe.department@northfield-academy.example',
    cohorts: [
      { id: 'year9-pe', label: 'Year 9 PE', groups: [
        { id: 'g1', label: 'Boys',  sex: 'm', size: 11, day: 2, weeks: [2, 1, 0] },
        { id: 'g2', label: 'Girls', sex: 'f', size: 10, day: 3, weeks: [2, 1, 'open'] }] },
      // Finished last term — baseline and final surveys both in.
      { id: 'year8-pe-summer', label: 'Year 8 PE (summer)', groups: [
        { id: 'g1', label: 'Boys',  sex: 'm', size: 12, day: 2, weeks: [17, 16, 15, 14, 13, 12] },
        { id: 'g2', label: 'Girls', sex: 'f', size: 11, day: 3, weeks: [17, 16, 15, 14, 13, 12] }] }
    ] },
  { id: 'demo-riverside', name: 'Riverside Juniors RLFC', login: false, foundation: 'Riverside RL Foundation',
    contact_name: 'Chris Walker', contact_email: 'juniors@riverside-rlfc.example',
    cohorts: [
      { id: 'u12s', label: 'U12s', school: 'Riverside Primary School', groups: [
        { id: 'g1', label: 'Group 1', size: 12, day: 4, weeks: [9, 8, 7, 6, 5, 4] }] }
    ] },
  { id: 'demo-hillcrest', name: 'Hillcrest Primary School', login: false, foundation: 'Eastbrook Community Foundation',
    contact_name: 'Rachel Okafor', contact_email: 'office@hillcrest-primary.example',
    cohorts: [
      { id: 'year6', label: 'Year 6', groups: [
        { id: 'g1', label: 'Group A', size: 11, day: 1, weeks: [0] },
        { id: 'g2', label: 'Group B', size: 10, day: 2, weeks: [0] }] },
      { id: 'year5', label: 'Year 5', groups: [
        { id: 'g1', label: 'Group A', size: 12, day: 3, weeks: [14, 13, 12, 11, 10, 9] },
        { id: 'g2', label: 'Group B', size: 11, day: 4, weeks: [14, 13, 12, 11, 10, 9] }] }
    ] },
  { id: 'demo-westgate', name: 'Westgate Community Trust', login: false, foundation: 'Riverside RL Foundation',
    contact_name: 'Dan Hughes', contact_email: 'schools@westgate-trust.example',
    cohorts: [
      { id: 'girls-academy-squad', label: 'Girls’ Academy Squad', school: 'Westgate Academy', groups: [
        { id: 'g1', label: 'Group 1', sex: 'f', size: 10, day: 4, weeks: [5, 4, 2] }] },
      { id: 'u13-girls', label: 'U13 Girls', school: 'Westgate Academy', groups: [
        { id: 'g1', label: 'Group 1', sex: 'f', size: 12, day: 2, weeks: [15, 14, 13, 11, 10, 9] }] }
    ] }
];

// ─── Group surveys ────────────────────────────────────────────────────────────
/**
 * Demo only: for each question, which end of its options a group drifts
 * towards as its `level` rises (0 = the first option, e.g. "Yes"; otherwise
 * the last, e.g. "Very confident"), so baseline → final shows some change.
 * It isn't a right answer — the tool itself has none.
 */
const SURVEY_TOWARDS_FIRST = new Set(['interested', 'action_important', 'know_what_to_do']);

/**
 * A group's survey response: how many hands went up for each answer. `level`
 * is where the group stands (0–1) at that point; `offsets` nudge each question
 * so they don't all move in step. A group's baseline and final share the same
 * offsets, so the change between them is (roughly) the programme's effect.
 */
function surveyResponse(rng, phase, level, offsets, size) {
  const present = Math.max(1, size - intBetween(rng, 0, 2));
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const answers = {};
  for (const q of SURVEY.questions) {
    const l = clamp01(level + (offsets[q.id] || 0));
    if (q.type === 'poll') {
      // Each young person picks an option near the group's level (a few don't answer).
      const k = q.options.length;
      const centre = SURVEY_TOWARDS_FIRST.has(q.id) ? 1 - l : l;
      const weights = q.options.map((_, i) => Math.exp(-(((i / (k - 1)) - centre) ** 2) / 0.3));
      const counts = new Array(k).fill(0);
      const answering = present - (rng() < 0.3 ? 1 : 0);
      for (let p = 0; p < answering; p++) counts[weightedIndex(rng, weights)]++;
      answers[q.id] = counts;
    } else if (q.type === 'counts') {
      answers[q.id] = tallyLabels(q).map((_, i) =>
        Math.round(present * clamp01(l + [0.1, 0.25, -0.1][i % 3] + (rng() - 0.5) * 0.15)));
    } else if (q.type === 'text') {
      answers[q.id] = '';
    }
  }
  return { present, answers };
}

/** Session start times, minutes after 00:00 UTC (≈ 09:50–14:15 UK summer time). */
const START_SLOTS = [530, 580, 645, 695, 795];
const DAY = 86400;
const MIN = 60;

// ─── Generator ───────────────────────────────────────────────────────────────
/**
 * Build the whole demo programme.
 * @param {number} nowSecs  "now" in epoch seconds; all timestamps are relative to it.
 */
export function buildDemoProgramme(nowSecs) {
  nowSecs = Math.floor(Number(nowSecs));
  const today0 = Math.floor(nowSecs / DAY) * DAY;          // 00:00 UTC today
  const todayDow = (Math.floor(nowSecs / DAY) + 4) % 7;    // 1 Jan 1970 was a Thursday
  /** 00:00 UTC of the given weekday, `weeksBack` weeks before its last occurrence before today. */
  const dayStart = (dow, weeksBack) => {
    const back = ((todayDow - dow + 7) % 7) || 7;
    return today0 - (back + 7 * weeksBack) * DAY;
  };

  const providers = PLAN.map(plan => {
    const rng = rngFor(plan.id);
    const cohorts = [];
    const runs = [];
    const surveys = [];

    for (const c of plan.cohorts) {
      // ── Roster: unique display names within the cohort ──
      const nameRng = rngFor(plan.id + '/' + c.id + '/names');
      const used = new Set();
      const students = [];
      for (const g of c.groups) {
        const pool = g.sex === 'm' ? BOYS : g.sex === 'f' ? GIRLS : DEMO_FIRST_NAMES;
        for (let i = 0; i < g.size; i++) {
          let name;
          do { name = pick(nameRng, pool) + ' ' + pick(nameRng, INITIALS) + '.'; } while (used.has(name));
          used.add(name);
          students.push({
            student_ref: demoStudentRef(plan.id, c.id, students.length),
            display_name: name,
            group_id: g.id
          });
        }
      }

      // ── Runs: one per (group, session delivered), in session order ──
      const cohortRuns = [];
      for (const g of c.groups) {
        const slot = pick(rng, START_SLOTS);
        const groupStudents = students.filter(s => s.group_id === g.id);
        g.weeks.forEach((w, i) => {
          const session = i + 1;
          const open = w === 'open';
          const started_at = open
            ? nowSecs - 40 * MIN
            : dayStart(g.day, w) + (slot + intBetween(rng, 0, 6)) * MIN;
          const ended_at = open ? null : started_at + intBetween(rng, 35, 55) * MIN;
          const recent = open || w <= 1;
          const runId = `${plan.id}-${c.id}-${g.id}-s${session}`;

          // 75–100% of the group pledges, in a shuffled order.
          const n = groupStudents.length;
          const count = intBetween(rng, Math.ceil(n * 0.75), n);
          const who = shuffled(rng, groupStudents).slice(0, count);
          // Pledges start after the video (~15 min in) and run to the end.
          const from = started_at + intBetween(rng, 13, 18) * MIN;
          const to = open ? nowSecs - MIN : ended_at - 2 * MIN;
          const step = (to - from) / count;

          const pledges = who.map((st, k) => {
            const own = rng() < OWN_IDEA_RATE;
            const option = own ? 6 : 1 + weightedIndex(rng, OPTION_WEIGHTS[session]);
            const pledge_text = own ? pick(rng, OWN_IDEAS[session]) : SESSIONS[session - 1].options[option - 1];
            let status = 'approved';
            if (recent) status = rng() < (own ? 0.85 : 0.04) ? 'pending' : 'approved';
            return {
              id: `pl-${runId}-${k + 1}`,
              student_ref: st.student_ref,
              session,
              cohort_id: c.id,
              option,
              pledge_text,
              status,
              created_at: Math.floor(from + step * k + rng() * step * 0.8)
            };
          });

          cohortRuns.push({
            id: runId, session, cohort_id: c.id, group_id: g.id,
            status: open ? 'open' : 'closed',
            // Most groups do the physical task; some sessions skip it (weather, space).
            physical_done: rngFor(runId + '/physical')() < 0.85,
            started_at, ended_at,
            pledge_count: pledges.length,
            pledges
          });
        });
      }

      // ── Surveys: a baseline for every group that has started (done at the
      // start of its first session); a final for every group that has finished
      // all six, just after the last one. A group that hasn't started has none —
      // its sessions are still locked.
      for (const g of c.groups) {
        const gRuns = cohortRuns.filter(r => r.group_id === g.id);
        if (!gRuns.length) continue;
        const srng = rngFor(`${plan.id}/${c.id}/${g.id}/survey`);
        const size = students.filter(s => s.group_id === g.id).length;
        const level = 0.2 + srng() * 0.3;
        const lift = 0.18 + srng() * 0.22;
        const offsets = Object.fromEntries(SURVEY.questions.map(q => [q.id, (srng() - 0.5) * 0.3]));
        const first = Math.min(...gRuns.map(r => r.started_at));
        const base = { cohort_id: c.id, group_id: g.id, survey_version: SURVEY.version,
                       facilitator: plan.contact_name, foundation: plan.foundation, school: c.school || plan.name };
        surveys.push({ id: surveyId(c.id, g.id, 'baseline'), ...base, phase: 'baseline',
          ...surveyResponse(srng, 'baseline', level, offsets, size),
          created_at: first - intBetween(srng, 1, 2) * MIN });
        const finished = new Set(gRuns.filter(r => r.status === 'closed' && r.pledge_count > 0).map(r => r.session));
        if (finished.size === SESSIONS.length) {
          surveys.push({ id: surveyId(c.id, g.id, 'final'), ...base, phase: 'final',
            ...surveyResponse(srng, 'final', level + lift, offsets, size),
            created_at: Math.max(...gRuns.map(r => r.ended_at)) + intBetween(srng, 1, 4) * MIN });
        }
      }

      // Cohort (and its student slots) created a couple of days before its
      // first delivery; a cohort with no runs yet was set up a few days ago.
      const firstRun = cohortRuns.length ? Math.min(...cohortRuns.map(r => r.started_at)) : null;
      const created_at = firstRun != null
        ? Math.floor(firstRun / DAY) * DAY - intBetween(rng, 2, 4) * DAY + intBetween(rng, 15, 17) * 3600
        : today0 - 3 * DAY + 15 * 3600;

      cohorts.push({
        cohort_id: c.id,
        label: c.label,
        foundation: plan.foundation,
        school: c.school || plan.name,
        created_at,
        groups: c.groups.map(g => ({ id: g.id, label: g.label })),
        students
      });
      runs.push(...cohortRuns);
    }

    const session_stats = {};
    for (let n = 1; n <= 6; n++) {
      const rs = runs.filter(r => r.session === n);
      session_stats['s' + n] = {
        runs: rs.length,
        pledges: rs.reduce((a, r) => a + r.pledge_count, 0),
        last_run_at: rs.length ? Math.max(...rs.map(r => r.started_at)) : null
      };
    }

    const created_at = Math.min(...cohorts.map(c => c.created_at)) - intBetween(rng, 5, 12) * DAY;
    const updated_at = runs.length ? Math.max(...runs.map(r => r.started_at)) : created_at;

    return {
      id: plan.id, name: plan.name,
      contact_name: plan.contact_name, contact_email: plan.contact_email,
      login: plan.login,
      created_at, updated_at,
      cohorts, runs, surveys, session_stats
    };
  });

  const totals = { total_pledges: 0 };
  for (let n = 1; n <= 6; n++) {
    const runsN = providers.reduce((a, p) => a + p.session_stats['s' + n].runs, 0);
    const pledgesN = providers.reduce((a, p) => a + p.session_stats['s' + n].pledges, 0);
    totals['s' + n + '_runs'] = runsN;
    totals['s' + n + '_pledges'] = pledgesN;
    totals.total_pledges += pledgesN;
  }

  return { providers, totals };
}
