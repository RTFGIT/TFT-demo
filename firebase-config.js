/**
 * firebase-config.js — the real Firebase project used by LIVE mode.
 *
 * Project: RTF-TFT (rtf-tft), Firestore in europe-west2 (London).
 * Web app: "Try for Tomorrow demo" (registered 29 Sep 2026).
 *
 * These values are NOT secrets. A Firebase web config is designed to be public
 * and must ship in the page: it only identifies the project. What protects the
 * data is firestore.rules (tested in tests/firestore.rules.test.mjs) plus
 * Firebase Auth. Recommended hardening: restrict this API key to the demo's
 * HTTP referrers in Google Cloud console → APIs & Services → Credentials.
 *
 * Set to null to disable Live mode (every page then stays in Sandbox).
 */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCqXzsUs0RNptYiF2_pzpbx_9Gaf56JkNE',
  authDomain: 'rtf-tft.firebaseapp.com',
  projectId: 'rtf-tft',
  storageBucket: 'rtf-tft.firebasestorage.app',
  messagingSenderId: '883229730442',
  appId: '1:883229730442:web:32f76f5414cc9238eb6f73'
};
