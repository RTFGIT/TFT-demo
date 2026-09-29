/**
 * doc-store.js — the session worksheet PDFs, kept in the GitHub repo.
 *
 * The worksheets aren't sensitive, so they live alongside the site (for now —
 * the team may move them later) rather than in Firebase Storage:
 *
 *   worksheets/manifest.json         which PDF is current for each session,
 *                                    plus every earlier version
 *   worksheets/pdf/session-N-vX.pdf  the files — a new version is a new file
 *
 * Add a version with   npm run worksheets:add -- --session N --file <pdf>
 * then commit and publish. Facilitators (Download buttons, Document hub) and the
 * admin console (Session documents) read the manifest, so everyone sees the same
 * current version in Sandbox and Live alike.
 *
 * Manifest shape:
 *   { "sessions": { "1": { "current": { version, file, name, size, added } | null,
 *                          "history": [ …earlier versions, oldest first ] }, … } }
 */

// Paths in the manifest are relative to the site root, which is where this file lives.
const ROOT = new URL('./', import.meta.url);

/** All sessions' document entries, keyed by session number ('1'..'6'). */
export async function listSessionDocs() {
  try {
    const res = await fetch(new URL('worksheets/manifest.json', ROOT), { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    return (await res.json()).sessions || {};
  } catch (e) {
    console.warn('[TFT26] worksheet manifest unavailable', e);
    return {};
  }
}

/** Absolute URL of one version's PDF ({file} from the manifest), or null. */
export function versionUrl(v) {
  return v?.file ? new URL(v.file, ROOT).href : null;
}

/** Where session n's projector page lives, relative to the site root. */
export const projectorPagePath = (n) => `worksheets/html/session-${n}.html`;

/**
 * A projector page's status, from its meta tags:
 *   <meta name="tft-worksheet" content="holder|final">
 *   <meta name="tft-matches-pdf" content="<PDF version it matches>">
 */
export function projectorPageStatus(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const get = (name) => d.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
  return { kind: get('tft-worksheet') || 'final', matchesPdf: Number(get('tft-matches-pdf')) || null };
}
