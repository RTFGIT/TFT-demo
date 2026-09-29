/**
 * session-config.js — shared model for the Try for Tomorrow programme.
 *
 * The programme is 6 sessions. Each session is: watch a video, then make a
 * thematic pledge in answer to a question about what was watched.
 *
 * These are the BUILT-IN DEFAULTS. In production each session document lives at
 * `sessions/{n}` in Firestore and is admin-editable, so copy and video URLs can
 * change without a redeploy. Anything here is only the fallback when that
 * document is missing.
 *
 * PRIVACY: nothing in this module ever handles a student's real name. Students
 * are represented by a pseudonymous `student_ref`; the name behind it is
 * resolvable only via the WordPress roster. See TFT_STEERING_HANDOVER.md.
 */

export const SESSION_COUNT = 6;

/**
 * The 6 sessions and their pledge options — the real RTFxRFL programme content.
 *
 * Each session offers FIVE predefined pledges plus a sixth "own suggestion"
 * free-text option (OWN_SUGGESTION_INDEX). The five are stored in `options`;
 * the sixth is not a stored string — the student writes their own.
 *
 * `question` is the on-screen framing shown after the video; `prompt` is the
 * short instruction under it. Both are editable per session in production via
 * the `sessions/{n}` Firestore document — these are the built-in fallbacks.
 */
export const OWN_SUGGESTION_INDEX = 6;

export const SESSIONS = [
  {
    n: 1, title: 'Greenhouse Gases & Climate Change', theme_note: '', video_url: '',
    question: 'After this session, what will you try to help with climate change?',
    prompt: 'Choose the pledge you’ll try this week.',
    options: [
      'I will walk to or from school and/or Rugby training at least once this week.',
      'I will cycle to or from school and/or Rugby training at least once this week.',
      'I will try a vegan or vegetarian option for my school meal at least once this week.',
      'I will swap a meat based meal for one that has beans, lentils or chickpeas.',
      'I will talk to my family, coach or teacher about greenhouse gases and climate change.'
    ]
  },
  {
    n: 2, title: 'Food Waste', theme_note: '', video_url: '',
    question: 'After this session, what will you try to reduce food waste?',
    prompt: 'Choose the pledge you’ll try this week.',
    options: [
      'I will try a new food.',
      'I will eat up everything on my plate at least 3 times this week.',
      'I will help put the food shopping away making sure that it is stored in the right place.',
      'I will choose the food I eat by date rather than what I want.',
      'I will talk to my family / carer about food labels – ‘use by dates’ and ‘best before’ dates.'
    ]
  },
  {
    n: 3, title: 'Eat More Fruit and Veg', theme_note: 'Water in food production', video_url: '',
    question: 'After this session, what will you try to eat more fruit and veg?',
    prompt: 'Choose the pledge you’ll try this week.',
    options: [
      'I will try a new fruit or vegetable.',
      'I will eat 1 more fruit or vegetable on at least 2 days this week.',
      'I will swap a chocolate bar for a piece of fruit.',
      'I will eat the salad, vegetables or fruit option as part of my school meal at least once this week.',
      'I will tell my family or friends about a surprising fact I have learnt about water in food production.'
    ]
  },
  {
    n: 4, title: 'Eat Foods That Keep You Fuller and More Energised For Longer', theme_note: '', video_url: '',
    question: 'After this session, what will you try to stay fuller and more energised for longer?',
    prompt: 'Choose the pledge you’ll try this week.',
    options: [
      'I will swap white bread to brown bread.',
      'I will make water my go to drink instead of something sugary.',
      'I will swap a chocolate bar for a piece of fruit or vegetable snack.',
      'I will eat the skin on a baked potato.',
      'I will tell my family or carer about 3 foods which are good to eat to feel fuller and more energised for longer.'
    ]
  },
  {
    n: 5, title: 'Reduce, Reuse, Recycle', theme_note: '', video_url: '',
    question: 'After this session, what will you try to reduce, reuse and recycle?',
    prompt: 'Choose the pledge you’ll try this week.',
    options: [
      'I will reduce water waste by making sure taps are turned off when they are not in use.',
      'I will reduce electricity waste by turning off lights and electronics when they are not in use.',
      'I will reuse my water bottle.',
      'I will donate my kit or uniform that no longer fits me, to other people so it can be reused.',
      'I will recycle paper, plastic, glass and cans.'
    ]
  },
  {
    n: 6, title: 'Nurture Nature', theme_note: '', video_url: '',
    question: 'After this session, what will you try to nurture nature?',
    prompt: 'Choose the pledge you’ll try this week.',
    options: [
      'I will grow some herbs.',
      'I will plant some wild flowers.',
      'I will plant a tree.',
      'I will do some litter picking.',
      'I will turn off electronics and lights when they are not in use.'
    ]
  }
];

/** Look up a session definition by number (1-6). */
export function sessionByNumber(n) {
  return SESSIONS.find(s => s.n === Number(n)) || null;
}

/** True if `n` is a valid session number. Mirrors the isSession() rule. */
export function isValidSession(n) {
  return Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= SESSION_COUNT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Student references
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected group sizes. This is a SOFT cap: the facilitator is warned when they
 * pass it, never blocked. A 26-pupil class or a 5th group must not hit a wall
 * mid-session with students waiting.
 */
export const EXPECTED_GROUP_SIZE = 24;
export const EXPECTED_GROUPS     = 4;
export const SOFT_STUDENT_CAP    = EXPECTED_GROUP_SIZE * EXPECTED_GROUPS; // 96

/**
 * Mint a pseudonymous student reference.
 *
 * Generated on demand when a facilitator adds a student — not drawn from a
 * pre-allocated pool, so there is no ceiling to collide with. Must match the
 * isStudentRef() pattern in firestore.rules: ^p_[a-z0-9]{6,32}$
 *
 * This value is the ONLY student identifier that ever reaches Firebase.
 */
export function mintStudentRef() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return 'p_' + hex;
}

/** Mirrors the isStudentRef() rule so the UI can reject bad input early. */
export function isStudentRef(v) {
  return typeof v === 'string' && /^p_[a-z0-9]{6,32}$/.test(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cohorts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Student refs are scoped to a cohort (one intake). A provider re-running the
 * programme next year gets a fresh pool, so a given student_ref always means
 * exactly one human and progression reporting stays trustworthy.
 */
export function emptyCohort(label) {
  return { label: label || 'Default cohort', active: true, student_count: 0 };
}

/** Per-provider, per-session rollup. Answers "ever run? how many times?". */
export function emptySessionStats() {
  const stats = {};
  for (let n = 1; n <= SESSION_COUNT; n++) {
    stats['s' + n] = { runs: 0, pledges: 0, last_run_at: null };
  }
  return stats;
}

/** The flat cross-provider aggregate document (`public/session-totals`). */
export function emptySessionTotals() {
  const totals = { total_pledges: 0 };
  for (let n = 1; n <= SESSION_COUNT; n++) {
    totals['s' + n + '_runs']    = 0;
    totals['s' + n + '_pledges'] = 0;
  }
  return totals;
}
