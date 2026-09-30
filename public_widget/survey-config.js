/**
 * survey-config.js — the evaluation survey, answered ONCE PER GROUP, twice:
 *
 *   baseline  when a group is set up, before its first session. The group's
 *             sessions unlock once it's done.
 *   final     straight after the group finishes its sixth session (whichever
 *             order the six were delivered in).
 *
 * Same questions both times, so each group's baseline and final can be compared.
 * There are no right or wrong answers — it only captures what the group says.
 *
 * Source: the evaluation team's SmartSurvey "RFL Try for Tomorrow Pre/Post Survey"
 * (https://www.smartsurvey.co.uk/s/UCRQPI/). Its first four questions are filled
 * in by the tool rather than asked:
 *   1 full name   → the facilitator's name (the signed-in facilitator)
 *   2 foundation  → the cohort's Foundation (set up with the cohort)
 *   3 school      → the cohort's school (set up with the cohort)
 *   4 pre / post  → the phase (baseline / final)
 * so its question 5 is question 1 here.
 *
 * ONE RESPONSE PER GROUP. The questions are asked of each young person ("Are you
 * interested…?"), so the facilitator records a SHOW OF HANDS: how many chose each
 * answer. Nothing about any individual is recorded.
 *
 * Question types
 *   poll    hands up for each option          answer: [count per option]     (total ≤ taking part)
 *   counts  hands up "yes" for each item      answer: [count per item]       (each ≤ taking part)
 *   text    a short written answer            answer: string                 (`optional` allowed)
 *
 * CHANGING QUESTIONS: bump `version`. Every response stores the version it was
 * answered with, and the admin Evaluation page only compares like with like.
 * Keep `id`s stable for questions that don't change.
 */
const YES_NO = ['Yes', 'No'];
const CONFIDENT = ['Not at all confident', 'Somewhat confident', 'Very confident'];

export const SURVEY = {
  version: 2,
  placeholder: false,
  title: 'RFL Try for Tomorrow Pre/Post Survey',
  phases: {
    baseline: { label: 'Baseline survey', short: 'Baseline',
      intro: 'Before the first session. Put each question on screen, ask for a show of hands for each answer, and record the numbers.' },
    final: { label: 'Final survey', short: 'Final',
      intro: 'All six sessions done. The same questions as the baseline, so you can see what’s changed.' }
  },
  questions: [
    { id: 'interested', type: 'poll', options: YES_NO,
      text: 'Are you interested in climate change?' },
    { id: 'spoken_with', type: 'counts', items: ['Friends', 'Family', 'Teachers'],
      text: 'Have you ever spoken about climate change with…',
      hint: 'Hands up for each one: who has?' },
    { id: 'action_important', type: 'poll', options: YES_NO,
      text: 'Do you think climate action is important?' },
    { id: 'know_amount', type: 'poll', options: ['Very little', 'A small amount', 'A moderate amount', 'A lot'],
      text: 'How much do you know about climate change?' },
    { id: 'confident_talking', type: 'poll', options: CONFIDENT,
      text: 'How confident are you in talking to others about climate change?' },
    { id: 'confident_understanding', type: 'poll', options: CONFIDENT,
      text: 'How confident are you in understanding climate change topics?' },
    { id: 'confident_tackling', type: 'poll', options: CONFIDENT,
      text: 'How confident are you in tackling climate change?' },
    { id: 'know_what_to_do', type: 'poll', options: YES_NO,
      text: 'Do you know what you can do to combat climate change?' },
    { id: 'role_importance', type: 'poll', options: ['Not important', 'Somewhat important', 'Very important'],
      text: 'How important do you think your role is in tackling climate change?' }
  ]
};

export const SURVEY_PHASES = ['baseline', 'final'];

/** The one survey document per group per phase: providers/{p}/surveys/{surveyId}. */
export const surveyId = (cohortId, groupId, phase) => `${cohortId}__${groupId}__${phase}`;

/** The labels a question counts hands for (poll options, or counts items). */
export const tallyLabels = (q) => q.type === 'poll' ? q.options : q.type === 'counts' ? q.items : [];

const isCount = (n, max) => Number.isInteger(n) && n >= 0 && (max == null || n <= max);

/**
 * Is an answer complete (and possible, given how many are taking part)? At
 * least one count must be entered; any left blank count as 0.
 */
export function answered(q, a, present) {
  if (q.type === 'text') return q.optional || (typeof a === 'string' && a.trim().length > 0);
  const labels = tallyLabels(q);
  if (!Array.isArray(a) || a.length !== labels.length || !a.some(n => n != null)) return false;
  if (!a.every(n => n == null || isCount(n, present))) return false;
  return q.type !== 'poll' || present == null || a.reduce((s, n) => s + (n || 0), 0) <= present;
}

/** An answer as readable text (review screens, tables). */
export function answerText(q, a) {
  if (a == null || a === '') return '';
  if (q.type === 'text') return String(a);
  return tallyLabels(q).map((l, i) => `${l} ${a[i] ?? '–'}`).join(', ');
}
