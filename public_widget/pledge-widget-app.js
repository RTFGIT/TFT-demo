/**
 * pledge-widget-app.js — the merged capture form + run counter.
 *
 * THE PRIVACY CONTRACT THIS WIDGET IMPLEMENTS
 * ───────────────────────────────────────────
 * The widget is told two things about the student:
 *
 *   student_ref   pseudonymous, e.g. p_a7f3c21b   -> WRITTEN to the database
 *   display_name  the real name, e.g. "Jack S."   -> RENDERED ON SCREEN ONLY
 *
 * The display name exists so the facilitator can see who is at the device. It
 * is held in a local variable, never persisted, never sent onward. Only the ref
 * reaches Firestore — and firestore.rules independently hard-rejects any write
 * carrying an identifying field, so this is belt AND braces.
 *
 * WHY THE NAME ARRIVES BY postMessage AND NOT IN THE URL
 * URLs end up in browser history, server logs, referrer headers and analytics.
 * Putting a real name in a query string leaks it into all of them. So the URL
 * carries only non-identifying routing (provider / session / run / cohort) and
 * the name is passed in-memory from the embedding page:
 *
 *     iframe.contentWindow.postMessage(
 *       { type:'TFT_SET_STUDENT', student_ref:'p_…', display_name:'Jack S.' }, '*');
 *
 * In production the embedding page is WordPress, which is the only system that
 * knows the mapping. Here it is the emulated WordPress facilitator site.
 */

import {
  initializeApp, getFirestore, doc, getDoc, setDoc, updateDoc, addDoc,
  collection, onSnapshot, increment, serverTimestamp, runTransaction
} from '../local-firebase.js';
import { sessionByNumber, isValidSession, isStudentRef, OWN_SUGGESTION_INDEX } from './session-config.js';

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
  count: $('count'), countSub: $('count-sub'), chip: $('session-chip'),
  pitch: $('pitch'), posts: $('posts'),
  whoName: $('who-name'), whoRef: $('who-ref'), whoInitial: $('who-initial'),
  question: $('question'), prompt: $('prompt'), pledge: $('pledge'),
  options: $('options'), ownWrap: $('own-wrap'),
  charCount: $('char-count'), submit: $('submit'), skip: $('skip'),
  err: $('err'), formView: $('form-view'), thanksView: $('thanks-view'), next: $('next')
};

// ─── Pledge selection state ──────────────────────────────────────────────────
let sessionOptions = [];        // the 5 predefined option strings for this session
let chosenOption = null;        // 1..6 (6 = own suggestion)

// ─── Counter ─────────────────────────────────────────────────────────────────
let pledgeCount = 0;

/**
 * The single token: the rugby-ball artwork (assets/rugby-ball.png, 96px; hi-res source in design/).
 * To swap it, change TOKEN_SRC — nothing else references the file.
 * Set it to null to fall back to the inline placeholder SVG in the HTML.
 */
const TOKEN_SRC = 'assets/rugby-ball.png';

function tokenSvg(cls) {
  return TOKEN_SRC
    ? `<img class="${cls}" src="${TOKEN_SRC}" alt="">`
    : `<svg class="${cls}" viewBox="0 0 40 40"><use href="#tft-token"/></svg>`;
}

function renderCounter(n, { animate = false } = {}) {
  pledgeCount = n;
  els.count.textContent = n;
  els.countSub.textContent = n === 0 ? 'No pledges yet'
                           : n === 1 ? '1 pledge recorded'
                           : `${n} pledges recorded`;

  if (animate) {
    els.count.classList.add('bump');
    setTimeout(() => els.count.classList.remove('bump'), 320);
  }
}

/**
 * Kick a ball over the posts — a conversion. The single visual reward for a
 * pledge landing. The ball arcs up and over the crossbar; the posts flash as it
 * passes through them.
 */
function kickBall() {
  const pitch = els.pitch;
  if (!pitch) return;
  const el = document.createElement('div');
  el.className = 'kick';
  el.innerHTML = `<div class="arc">${tokenSvg('ball')}</div>`;
  pitch.appendChild(el);

  // Flash the posts around the point the ball crosses the crossbar (~mid-arc).
  const posts = els.posts;
  if (posts) {
    setTimeout(() => posts.classList.add('flash'), 430);
    setTimeout(() => posts.classList.remove('flash'), 720);
  }
  setTimeout(() => el.remove(), 1250);
}

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

/**
 * Render the five predefined pledges plus the sixth "own idea" option. Choosing
 * the sixth reveals the free-text box; choosing any other hides it.
 */
function renderOptions() {
  const rows = sessionOptions.map((text, i) => {
    const n = i + 1;
    return `<button type="button" class="opt" role="radio" aria-checked="false" data-opt="${n}">
        <span class="n">${n}</span><span class="txt">${escapeHtml(text)}</span>
      </button>`;
  });
  rows.push(`<button type="button" class="opt own" role="radio" aria-checked="false" data-opt="${OWN_SUGGESTION_INDEX}">
      <span class="n">${OWN_SUGGESTION_INDEX}</span><span class="txt">My own idea…</span>
    </button>`);
  els.options.innerHTML = rows.join('');
  els.options.querySelectorAll('[data-opt]').forEach(b =>
    b.addEventListener('click', () => chooseOption(Number(b.dataset.opt))));
}

function chooseOption(n) {
  chosenOption = n;
  els.options.querySelectorAll('.opt').forEach(b => {
    const on = Number(b.dataset.opt) === n;
    b.classList.toggle('sel', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  const own = n === OWN_SUGGESTION_INDEX;
  els.ownWrap.classList.toggle('hidden', !own);
  if (own) { els.pledge.focus(); }
  updateSubmitState();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ─── Live run counter ────────────────────────────────────────────────────────
function watchRun() {
  if (!PROVIDER || !RUN_ID) return;
  onSnapshot(doc(db, 'providers', PROVIDER, 'runs', RUN_ID), (snap) => {
    if (!snap.exists()) return;
    const n = snap.data().pledge_count || 0;
    if (n !== pledgeCount) renderCounter(n, { animate: n > pledgeCount });
  });
}

// ─── Student handoff from the embedding page ─────────────────────────────────
function setStudent(ref, displayName) {
  if (!isStudentRef(ref)) {
    showError('Invalid student reference — expected the p_… pseudonymous form.');
    return;
  }
  student = { ref, name: displayName || null };
  els.whoName.textContent    = displayName || 'Student';
  els.whoRef.textContent     = ref;
  els.whoInitial.textContent = (displayName || '?').trim().charAt(0).toUpperCase();
  resetSelection();
  showForm();
}

/** Clear the option choice and free-text box for the next student. */
function resetSelection() {
  chosenOption = null;
  els.pledge.value = '';
  els.ownWrap.classList.add('hidden');
  els.options.querySelectorAll('.opt').forEach(b => {
    b.classList.remove('sel');
    b.setAttribute('aria-checked', 'false');
  });
  updateCharCount();
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'TFT_SET_STUDENT') return;
  setStudent(d.student_ref, d.display_name);
});

// A ref in the URL is acceptable (it is pseudonymous); a NAME never is.
if (qs.get('ref')) setStudent(qs.get('ref'), null);

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
  const ok = !!student.ref && chosenOption != null
          && (!own || (textLen > 0 && els.pledge.value.length <= 1000));
  els.submit.disabled = !ok;
}
els.pledge.addEventListener('input', updateCharCount);

function showError(msg) { els.err.textContent = msg; els.err.classList.remove('hidden'); }
function clearError()   { els.err.classList.add('hidden'); }
function showForm()   { els.formView.classList.remove('hidden'); els.thanksView.classList.add('hidden'); }
function showThanks() { els.formView.classList.add('hidden'); els.thanksView.classList.remove('hidden'); }

/**
 * Write the pledge.
 *
 * Note what goes into the document: student_ref, session, cohort_id, text,
 * status, timestamp. There is no name field — and could not be, because
 * firestore.rules would reject the write.
 */
async function submitPledge() {
  clearError();
  if (!student.ref || chosenOption == null) return;
  if (!PROVIDER || !RUN_ID) { showError('No active run — start a session from the facilitator site.'); return; }

  // Resolve the stored text. Options 1-5 store the canonical option string
  // (denormalised so reporting/export needs no lookup); option 6 stores the
  // student's own words.
  const own = chosenOption === OWN_SUGGESTION_INDEX;
  const text = own ? els.pledge.value.trim() : (sessionOptions[chosenOption - 1] || '');
  if (!text) return;

  els.submit.disabled = true;
  els.submit.textContent = 'Submitting…';

  try {
    await addDoc(collection(db, 'providers', PROVIDER, 'runs', RUN_ID, 'pledges'), {
      student_ref: student.ref,
      session:     SESSION,
      cohort_id:   COHORT_ID,
      option:      chosenOption,     // 1-5 predefined, 6 = own suggestion
      pledge_text: text,
      status:      'pending',        // moderation workflow still to be decided
      created_at:  serverTimestamp()
    });

    // Roll the counters up: run -> provider session_stats -> all-provider totals.
    await updateDoc(doc(db, 'providers', PROVIDER, 'runs', RUN_ID), {
      pledge_count: increment(1)
    });

    // session_stats is a NESTED map, so increment() cannot be used directly on
    // it — a merge write would replace the whole map and wipe the other five
    // sessions. Read-modify-write inside a transaction instead.
    await runTransaction(db, async (tx) => {
      const ref  = doc(db, 'providers', PROVIDER);
      const snap = await tx.get(ref);
      const stats = (snap.exists() ? snap.data().session_stats : null) || {};
      const key = 's' + SESSION;
      const cur = stats[key] || { runs: 0, pledges: 0, last_run_at: null };
      tx.set(ref, {
        session_stats: { ...stats, [key]: { ...cur, pledges: (cur.pledges || 0) + 1 } },
        updated_at: serverTimestamp()
      }, { merge: true });
    });

    // These ARE flat top-level fields, so increment() is correct here.
    await setDoc(doc(db, 'public', 'session-totals'), {
      ['s' + SESSION + '_pledges']: increment(1),
      total_pledges: increment(1)
    }, { merge: true });

    // Kick the ball over the posts for immediate feedback, but do NOT bump the
    // number here — the run's onSnapshot listener owns the count. Incrementing
    // in both places double-counts every pledge.
    kickBall();
    document.getElementById('thanks-sub').textContent =
      student.name ? `Thanks ${student.name.split(' ')[0]} — pass the device to the next student.`
                   : 'Pass the device to the next student.';
    showThanks();

    // Drop the name from memory AND from the DOM the moment it stops being
    // needed. It has already been read into `thanks-sub` above; leaving it
    // sitting in the markup until the next click serves no purpose.
    student = { ref: null, name: null };
    clearWhoPanel();
    notifyParent('TFT_PLEDGE_SAVED');
  } catch (err) {
    console.error('[TFT26] Pledge submit failed:', err);
    showError('Could not save that pledge. Please try again.');
  } finally {
    els.submit.disabled = false;
    els.submit.textContent = 'Submit pledge';
  }
}

els.submit.addEventListener('click', submitPledge);
els.skip.addEventListener('click', () => notifyParent('TFT_STUDENT_SKIPPED'));
function clearWhoPanel() {
  els.whoName.textContent    = 'No student selected';
  els.whoRef.textContent     = '—';
  els.whoInitial.textContent = '?';
}

els.next.addEventListener('click', () => {
  clearWhoPanel();
  resetSelection();
  showForm();
  notifyParent('TFT_READY_FOR_NEXT');
});

function notifyParent(type) {
  if (window.parent !== window) window.parent.postMessage({ type }, '*');
}

// Keep the embedding iframe sized to content (same contract JOM used).
function notifyHeight() {
  const h = document.querySelector('.widget').getBoundingClientRect().height + 8;
  if (window.parent !== window) window.parent.postMessage({ type: 'TFT_HEIGHT', height: h }, '*');
}
new ResizeObserver(notifyHeight).observe(document.querySelector('.widget'));

// ─── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  await loadSession();
  if (PROVIDER && RUN_ID) {
    const snap = await getDoc(doc(db, 'providers', PROVIDER, 'runs', RUN_ID));
    renderCounter(snap.exists() ? (snap.data().pledge_count || 0) : 0);
    watchRun();
  } else {
    renderCounter(0);
  }
  updateCharCount();
  notifyHeight();
  console.log('[TFT26] Pledge widget ready —',
    { provider: PROVIDER, session: SESSION, run: RUN_ID, cohort: COHORT_ID });
})();
