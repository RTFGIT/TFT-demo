/**
 * data-layer.js — the one seam between the app and its database.
 *
 * Every page imports its Firebase functions from HERE, never directly. This
 * module decides, once at load, which backend to use:
 *
 *   SANDBOX (default)  local-firebase.js — a localStorage stand-in. Everything
 *                      stays in the visitor's browser; nothing is shared.
 *   LIVE               the real Firebase project (firebase-config.js), loaded
 *                      from Google's CDN. Data is shared across every device.
 *
 * The shim was written to mirror the real modular SDK, so both backends expose
 * the same functions with the same shapes — pages don't know which one they got.
 *
 * Choosing the mode:
 *   ?mode=live / ?mode=sandbox   switch, and remember it (localStorage)
 *   ?mode_once=sandbox           force a mode for this page only (used by the
 *                                integration explainer, which must stay offline)
 * Pages in iframes (the pledge widget) inherit the remembered mode, because
 * they share the same origin and storage.
 *
 * In LIVE mode the module also waits for Firebase Auth to restore any signed-in
 * user before exporting, so a page's first read or write already carries the
 * user's token (and with it their `provider` / `admin` claims).
 */

import { FIREBASE_CONFIG } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';   // pinned; matches npm + tests
const MODE_KEY = 'tft26_mode';

function resolveMode() {
  const qs = new URLSearchParams(location.search);
  const once = qs.get('mode_once');
  if (once === 'live' || once === 'sandbox') return once;
  const q = qs.get('mode');
  if (q === 'live' || q === 'sandbox') { try { localStorage.setItem(MODE_KEY, q); } catch {} return q; }
  try { return localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'sandbox'; } catch { return 'sandbox'; }
}

const requested = resolveMode();
/** True if Live was requested but no Firebase project is configured yet. */
export const LIVE_UNAVAILABLE = requested === 'live' && !FIREBASE_CONFIG;
/** The mode actually in force: 'live' or 'sandbox'. */
export const MODE = LIVE_UNAVAILABLE ? 'sandbox' : requested;
if (LIVE_UNAVAILABLE) console.warn('[TFT26] Live mode requested but firebase-config.js is empty — using Sandbox.');

let api;
if (MODE === 'live') {
  const [appM, fsM, authM] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-auth.js`)
  ]);
  const app  = appM.getApps().length ? appM.getApp() : appM.initializeApp(FIREBASE_CONFIG);
  const db   = fsM.getFirestore(app);
  const auth = authM.getAuth(app);
  // Wait for Auth to restore a persisted session before any page code runs.
  await new Promise(res => { const off = authM.onAuthStateChanged(auth, () => { off(); res(); }); });

  /**
   * Create someone's account and email them a link to set their own password
   * (admin console → Users). A second, private Firebase app does the creating,
   * so the admin stays signed in as themselves. Nobody ever knows the random
   * starting password. If the account already exists (e.g. added in the Firebase
   * console), it's left as it is and they're just sent the link.
   */
  async function inviteAccount(email) {
    const other = appM.getApps().find(a => a.name === 'tft-invite') || appM.initializeApp(FIREBASE_CONFIG, 'tft-invite');
    const otherAuth = authM.getAuth(other);
    const random = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
    let created = false;
    try {
      await authM.createUserWithEmailAndPassword(otherAuth, email, random);
      created = true;
    } catch (e) {
      if (e?.code !== 'auth/email-already-in-use') throw e;
    } finally {
      await authM.signOut(otherAuth).catch(() => {});
    }
    await authM.sendPasswordResetEmail(auth, email);
    return { created };
  }
  const sendPasswordReset = (email) => authM.sendPasswordResetEmail(auth, email);

  api = {
    ...fsM, ...authM, inviteAccount, sendPasswordReset,
    // Pages call initializeApp()/getFirestore()/getAuth() with sandbox-style
    // arguments; in Live mode they always get the one real app instance.
    initializeApp: () => app,
    getFirestore:  () => db,
    getAuth:       () => auth
  };
} else {
  api = await import('./local-firebase.js');
}

export const {
  initializeApp, getFirestore, getAuth,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  doc, collection, query, orderBy, where, limit,
  getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  onSnapshot, runTransaction, writeBatch, increment, serverTimestamp, arrayUnion,
  inviteAccount, sendPasswordReset
} = api;

/** The currently signed-in Firebase user (Live) or shim user (Sandbox), if any. */
export function currentUser() { return getAuth().currentUser ?? null; }
