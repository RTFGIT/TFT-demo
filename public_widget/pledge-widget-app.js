/**
 * pledge-widget-app.js — the pledge widget: pick a pledge, kick it over the posts.
 *
 * THE PRIVACY CONTRACT THIS WIDGET IMPLEMENTS
 * ───────────────────────────────────────────
 * The widget is told two things about the student:
 *
 *   student_ref   pseudonymous, e.g. p_a7f3c21b   -> WRITTEN to the database
 *   display_name  the real name, e.g. "Jack S."   -> RENDERED ON SCREEN ONLY
 *
 * The display name exists so the student can see it's their turn. It is held in
 * a local variable, never persisted, never sent onward, and dropped as soon as
 * their pledge card has been shown. Only the ref reaches Firestore — and
 * firestore.rules independently hard-rejects any write carrying an identifying
 * field, so this is belt AND braces.
 *
 * WHY THE NAME ARRIVES BY postMessage AND NOT IN THE URL
 * URLs end up in browser history, server logs, referrer headers and analytics.
 * So the URL carries only non-identifying routing (provider / session / run /
 * cohort) and the name is passed in-memory from the embedding page:
 *
 *     iframe.contentWindow.postMessage(
 *       { type:'TFT_SET_STUDENT', student_ref:'p_…', display_name:'Jack S.' }, '*');
 *
 * MESSAGES THE WIDGET SENDS TO ITS PARENT
 *   TFT_WIDGET_READY     loaded and listening — safe to send the first student
 *   TFT_PLEDGE_SAVED     the current student's pledge is stored
 *   TFT_STUDENT_SKIPPED  the current student chose not to pledge
 *   TFT_READY_FOR_NEXT   "Next player" pressed — send the next student
 *   TFT_HEIGHT           { height } so the iframe can size itself
 */

import {
  initializeApp, getFirestore, doc, getDoc, setDoc, updateDoc, addDoc,
  collection, onSnapshot, increment, serverTimestamp, runTransaction
} from '../data-layer.js';
import { sessionByNumber, isValidSession, isStudentRef, OWN_SUGGESTION_INDEX } from './session-config.js';
import { createKickScene } from './kick-scene.js';
import { sound, warm, thump, cheer } from './sfx.js';

const app = initializeApp({ projectId: 'tft26-local' });
const db  = getFirestore(app);

// ─── Routing context (non-identifying only) ──────────────────────────────────
const qs         = new URLSearchParams(location.search);
const PROVIDER   = qs.get('provider') || '';
const RUN_ID     = qs.get('run') || '';
const COHORT_ID  = qs.get('cohort') || '';
const SESSION    = Number(qs.get('session') || 0);

// ─── Student context — held in memory ONLY ───────────────────────────────────
let student = { ref: null, name: null };

const $ = (id) => document.getElementById(id);
const els = {
  count: $('count'), countSub: $('count-sub'), chip: $('session-chip'), sound: $('sound'),
  goal: $('goal'), goalBig: $('goal-big'), goalSmall: $('goal-small'),
  idleView: $('idle-view'), idleTitle: $('idle-title'), idleSub: $('idle-sub'),
  formView: $('form-view'), thanksView: $('thanks-view'),
  whoName: $('who-name'), whoRef: $('who-ref'), whoInitial: $('who-initial'),
  question: $('question'), prompt: $('prompt'), pledge: $('pledge'),
  options: $('options'), ownWrap: $('own-wrap'), charCount: $('char-count'),
  submit: $('submit'), submitLabel: $('submit-label'), skip: $('skip'), hint: $('hint'), err: $('err'),
  cardWho: $('card-who'), cardText: $('card-text'), thanksTitle: $('thanks-title'),
  thanksSub: $('thanks-sub'), next: $('next')
};

let sessionOptions = [];        // the 5 predefined option strings for this session
let chosenOption = null;        // 1..6 (6 = own suggestion)
let kicking = false;            // a pledge is being saved / celebrated

// ─── The kick scene ──────────────────────────────────────────────────────────
let onGoalOnce = null;
const scene = createKickScene($('scene'), {
  ballSrc: 'assets/rugby-ball@2x.png',
  onContact: () => thump(),
  onGoal: ({ big }) => {
    cheer(big);
    showGoalBanner(big);
    releaseCount();
    onGoalOnce?.(); onGoalOnce = null;
  }
});
window.addEventListener('tft-theme', () => scene.refresh());
window.__kick = scene;                              // dev: __kick.preview(ms)

const CALLS = ['Converted!', 'Split the posts!', 'Right down the middle!', 'What a kick!', 'Over it goes!'];
function showGoalBanner(big) {
  // Called just before the held score is released, so heldCount is the new
  // total if the database has already confirmed it.
  const n = heldCount ?? pledgeCount + 1;
  els.goalBig.textContent   = big ? `${n} pledges!` : CALLS[Math.floor(Math.random() * CALLS.length)];
  els.goalSmall.textContent = big ? 'Milestone!' : '+1 pledge';
  els.goal.classList.remove('show'); void els.goal.offsetWidth; els.goal.classList.add('show');
}

// ─── Score ───────────────────────────────────────────────────────────────────
// The run's pledge_count (from Firestore) owns the number. While a kick is in
// the air the new value is held back, so the score ticks over at the exact
// moment the ball clears the crossbar.
let pledgeCount = 0;
let holding = false, heldCount = null;

function setCount(n, animate) {
  if (n === pledgeCount && els.count.textContent.trim() === String(n)) return;
  pledgeCount = n;
  if (!animate) { els.count.innerHTML = `<span>${n}</span>`; return; }
  const old = els.count.querySelector('span:last-child');
  if (old) { old.className = 'out'; setTimeout(() => old.remove(), 460); }
  const s = document.createElement('span');
  s.className = 'in'; s.textContent = n;
  els.count.appendChild(s);
}
function onRunCount(n) {
  if (holding) { heldCount = n; return; }
  setCount(n, n > pledgeCount);
}
function releaseCount() {
  holding = false;
  if (heldCount != null) { setCount(heldCount, true); heldCount = null; }
}

function watchRun() {
  if (!PROVIDER || !RUN_ID) return;
  onSnapshot(doc(db, 'providers', PROVIDER, 'runs', RUN_ID), (snap) => {
    if (snap.exists()) onRunCount(snap.data().pledge_count || 0);
  });
}

/** The programme-wide total (public, anonymous aggregate) — "you're part of something". */
function watchProgramme() {
  onSnapshot(doc(db, 'public', 'session-totals'), (snap) => {
    const n = snap.exists() ? (snap.data().total_pledges || 0) : 0;
    els.countSub.textContent = n ? `${n.toLocaleString('en-GB')} across the whole programme` : 'Kick-off!';
  }, () => {});
}

// ─── Sound toggle (per device) ───────────────────────────────────────────────
function paintSound() { els.sound.setAttribute('aria-pressed', sound.on ? 'true' : 'false');
                        els.sound.title = sound.on ? 'Sound on — click to mute' : 'Sound off — click to unmute'; }
els.sound.addEventListener('click', () => { sound.on = !sound.on; paintSound(); if (sound.on) warm(); });
paintSound();

// ─── Session content ─────────────────────────────────────────────────────────
async function loadSession() {
  els.chip.textContent = isValidSession(SESSION) ? `Session ${SESSION}` : 'Session —';
  let content = sessionByNumber(SESSION);                    // built-in fallback
  try {
    const snap = await getDoc(doc(db, 'sessions', String(SESSION)));
    if (snap.exists()) content = { ...content, ...snap.data() };
  } catch { /* fall back to the built-in definition */ }

  els.question.textContent = content?.question || 'No session selected.';
  els.prompt.textContent   = content?.prompt   || '';
  sessionOptions = Array.isArray(content?.options) ? content.options : [];
  renderOptions();
}

const TICK = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function renderOptions() {
  const rows = sessionOptions.map((text, i) => `
    <button type="button" class="opt" role="radio" aria-checked="false" data-opt="${i + 1}">
      <span class="n">${i + 1}</span><span class="txt">${escapeHtml(text)}</span>${TICK}
    </button>`);
  rows.push(`
    <button type="button" class="opt own" role="radio" aria-checked="false" data-opt="${OWN_SUGGESTION_INDEX}">
      <span class="n">${OWN_SUGGESTION_INDEX}</span><span class="txt">My own idea…</span>${TICK}
    </button>`);
  els.options.innerHTML = rows.join('');
  els.options.querySelectorAll('[data-opt]').forEach(b =>
    b.addEventListener('click', () => chooseOption(Number(b.dataset.opt))));
}

function chooseOption(n) {
  if (kicking) return;
  chosenOption = n;
  els.options.querySelectorAll('.opt').forEach(b => {
    const on = Number(b.dataset.opt) === n;
    b.classList.toggle('sel', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  const own = n === OWN_SUGGESTION_INDEX;
  els.ownWrap.classList.toggle('hidden', !own);
  if (own) els.pledge.focus();
  updateSubmitState();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
const firstName = (s) => (s || '').trim().split(/\s+/)[0] || '';

// ─── Views ───────────────────────────────────────────────────────────────────
function showView(which) {
  for (const [k, el] of [['idle', els.idleView], ['form', els.formView], ['thanks', els.thanksView]]) {
    const on = k === which;
    el.classList.toggle('hidden', !on);
    if (on) { el.classList.remove('view'); void el.offsetWidth; el.classList.add('view'); }
  }
}

// ─── Student handoff from the embedding page ─────────────────────────────────
function setStudent(ref, displayName) {
  if (kicking) return;                          // never swap players mid-kick
  if (!isStudentRef(ref)) {
    showView('form');
    showError('Invalid student reference — expected the p_… pseudonymous form.');
    return;
  }
  student = { ref, name: displayName || null };
  els.idleTitle.textContent  = 'Ready for the next player';
  els.idleSub.textContent    = 'Your facilitator will choose who’s up next.';
  els.whoName.textContent    = displayName || 'Player';
  els.whoRef.textContent     = ref;
  els.whoInitial.textContent = (displayName || '?').trim().charAt(0).toUpperCase();
  resetSelection();
  clearError();
  showView('form');
}

function resetSelection() {
  chosenOption = null;
  els.pledge.value = '';
  els.ownWrap.classList.add('hidden');
  els.options.querySelectorAll('.opt').forEach(b => {
    b.classList.remove('sel'); b.disabled = false;
    b.setAttribute('aria-checked', 'false');
  });
  updateCharCount();
}

/** Forget the student: memory AND DOM. */
function forgetStudent() {
  student = { ref: null, name: null };
  els.whoName.textContent = 'Player';
  els.whoRef.textContent = '—';
  els.whoInitial.textContent = '?';
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (d?.type === 'TFT_SET_STUDENT') setStudent(d.student_ref, d.display_name);
  else if (d?.type === 'TFT_ALL_DONE' && !kicking && els.thanksView.classList.contains('hidden')) {
    els.idleTitle.textContent = 'That’s the whole team!';
    els.idleSub.textContent   = 'Every player has had their turn. Your facilitator will wrap up.';
    showView('idle');
  }
});

// ─── Form behaviour ──────────────────────────────────────────────────────────
function updateCharCount() {
  const n = els.pledge.value.length;
  els.charCount.textContent = `${n} / 1000`;
  els.charCount.classList.toggle('over', n > 1000);
  updateSubmitState();
}

/**
 * Submit is enabled when a student is selected AND either a predefined option
 * is chosen, or the "own idea" option is chosen with non-empty, in-range text.
 */
function updateSubmitState() {
  const own = chosenOption === OWN_SUGGESTION_INDEX;
  const textLen = els.pledge.value.trim().length;
  const ok = !!student.ref && chosenOption != null && !kicking
          && (!own || (textLen > 0 && els.pledge.value.length <= 1000));
  els.submit.disabled = !ok;
  els.hint.textContent = chosenOption == null ? 'Pick one to kick for goal'
                       : own && textLen === 0 ? 'Write your idea, then kick for goal'
                       : 'Ready? Take the kick!';
}
els.pledge.addEventListener('input', updateCharCount);

function showError(msg) { els.err.textContent = msg; els.err.classList.remove('hidden'); }
function clearError()   { els.err.classList.add('hidden'); }

// Number keys pick an option; Enter kicks. (Handy on a laptop at the front.)
document.addEventListener('keydown', (e) => {
  if (els.formView.classList.contains('hidden') || kicking) return;
  if (e.target === els.pledge) return;
  const n = Number(e.key);
  if (n >= 1 && n <= OWN_SUGGESTION_INDEX && n <= sessionOptions.length + 1) {
    chooseOption(n === sessionOptions.length + 1 ? OWN_SUGGESTION_INDEX : n);
  } else if (e.key === 'Enter' && !els.submit.disabled) {
    submitPledge();
  }
});

/**
 * Save the pledge. Note what goes into the document: student_ref, session,
 * cohort_id, option, text, status, timestamp. There is no name field — and
 * could not be, because firestore.rules would reject the write.
 */
async function savePledge(text) {
  await addDoc(collection(db, 'providers', PROVIDER, 'runs', RUN_ID, 'pledges'), {
    student_ref: student.ref,
    session:     SESSION,
    cohort_id:   COHORT_ID,
    option:      chosenOption,     // 1-5 predefined, 6 = own suggestion
    pledge_text: text,
    status:      'pending',
    created_at:  serverTimestamp()
  });
}

/** Roll the counters up: run → provider session_stats → all-provider totals. */
function rollUp() {
  return Promise.all([
    updateDoc(doc(db, 'providers', PROVIDER, 'runs', RUN_ID), { pledge_count: increment(1) }),
    // session_stats is a NESTED map, so increment() cannot be used on it — a
    // merge write would replace the whole map. Read-modify-write in a transaction.
    runTransaction(db, async (tx) => {
      const ref  = doc(db, 'providers', PROVIDER);
      const snap = await tx.get(ref);
      const stats = (snap.exists() ? snap.data().session_stats : null) || {};
      const key = 's' + SESSION;
      const cur = stats[key] || { runs: 0, pledges: 0, last_run_at: null };
      tx.set(ref, {
        session_stats: { ...stats, [key]: { ...cur, pledges: (cur.pledges || 0) + 1 } },
        updated_at: serverTimestamp()
      }, { merge: true });
    }),
    // Flat top-level fields, so increment() is correct here.
    setDoc(doc(db, 'public', 'session-totals'), {
      ['s' + SESSION + '_pledges']: increment(1),
      total_pledges: increment(1)
    }, { merge: true })
  ]);
}

async function submitPledge() {
  clearError();
  if (!student.ref || chosenOption == null || kicking) return;
  if (!PROVIDER || !RUN_ID) { showError('No active run — start a session from the facilitator site.'); return; }

  // Options 1-5 store the canonical option string (so reporting needs no
  // lookup); option 6 stores the student's own words.
  const own  = chosenOption === OWN_SUGGESTION_INDEX;
  const text = own ? els.pledge.value.trim() : (sessionOptions[chosenOption - 1] || '');
  if (!text) return;

  kicking = true;
  warm();                                              // unlock audio on this click
  els.options.querySelectorAll('.opt').forEach(b => { b.disabled = true; });
  els.submit.disabled = true;
  els.submitLabel.textContent = 'Lining it up…';

  try {
    await savePledge(text);                            // the pledge itself is safe
  } catch (err) {
    console.error('[TFT26] Pledge submit failed:', err);
    kicking = false;
    els.options.querySelectorAll('.opt').forEach(b => { b.disabled = false; });
    els.submitLabel.textContent = 'Make my pledge';
    updateSubmitState();
    showError('Could not save that pledge — check the connection and try again.');
    return;
  }

  // Stored — tell the embedding page straight away, so the roster is right even
  // if the page is refreshed mid-kick. The counters roll up behind.
  notifyParent('TFT_PLEDGE_SAVED');

  // Take the kick. The score holds until the ball clears the bar.
  const big = (pledgeCount + 1) % 10 === 0;
  holding = true;
  const rolled = rollUp().catch(err => console.error('[TFT26] Counter roll-up failed:', err));
  const who = firstName(student.name);
  onGoalOnce = () => {
    setTimeout(() => {
      els.cardWho.textContent   = who ? `${who}’s pledge` : 'Your pledge';
      els.cardText.textContent  = text;
      els.thanksTitle.textContent = big ? 'Milestone kick!' : who ? `Great kick, ${who}!` : 'Great kick!';
      els.thanksSub.textContent = 'Pass the device back to your facilitator.';
      showView('thanks');
      // Drop the name from memory AND the turn panel now it has been used.
      forgetStudent();
      els.submitLabel.textContent = 'Make my pledge';
      kicking = false;
    }, 350);
  };
  scene.kick({ big });
}

els.submit.addEventListener('click', submitPledge);
els.skip.addEventListener('click', () => {
  if (kicking) return;
  forgetStudent(); resetSelection(); showView('idle');
  notifyParent('TFT_STUDENT_SKIPPED');
});

els.next.addEventListener('click', () => {
  els.cardWho.textContent = ''; els.cardText.textContent = '';
  resetSelection();
  showView('idle');
  notifyParent('TFT_READY_FOR_NEXT');
});

function notifyParent(type, extra = {}) {
  if (window.parent !== window) window.parent.postMessage({ type, ...extra }, '*');
}

// Keep the embedding iframe sized to content.
function notifyHeight() {
  const h = document.querySelector('.widget').getBoundingClientRect().height + 8;
  notifyParent('TFT_HEIGHT', { height: h });
}
new ResizeObserver(notifyHeight).observe(document.querySelector('.widget'));

// ─── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  await loadSession();
  if (PROVIDER && RUN_ID) {
    try {
      const snap = await getDoc(doc(db, 'providers', PROVIDER, 'runs', RUN_ID));
      setCount(snap.exists() ? (snap.data().pledge_count || 0) : 0, false);
    } catch { setCount(0, false); }
    watchRun();
  } else {
    setCount(0, false);
    els.idleTitle.textContent = 'Pledge widget';
    els.idleSub.textContent   = 'Start a session from the facilitator portal to collect pledges here.';
  }
  watchProgramme();
  updateCharCount();

  // A ref in the URL is acceptable (it is pseudonymous); a NAME never is.
  if (qs.get('ref')) setStudent(qs.get('ref'), null);

  notifyHeight();
  notifyParent('TFT_WIDGET_READY');
  console.log('[TFT26] Pledge widget ready —',
    { provider: PROVIDER, session: SESSION, run: RUN_ID, cohort: COHORT_ID });
})();
