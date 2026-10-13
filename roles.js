/**
 * roles.js — who someone is in the tool: admin, manager, guest, or no access.
 * Used by the sign-in gate (auth-gate.js) and the admin console. It mirrors
 * role() in firestore.rules, which is what actually protects the data:
 *
 *   1. On the people list (staff/{email}, managed on the admin console's Users
 *      page)? Then the entry decides: its role — if it's switched on and the
 *      email is verified (set when they choose their password from the emailed
 *      link). Otherwise no access.
 *   2. Not on the list? Their custom claims (seed and test accounts, and
 *      anyone added before the list existed).
 *
 *   admin    everything, including Session videos and Users
 *   manager  read-only: sees everything, changes nothing
 *   guest    the shared demo, on the demo organisations
 */
export const ROLES = ['admin', 'manager', 'guest'];
export const ROLE_LABEL = { admin: 'Admin', manager: 'Manager · read-only', guest: 'Guest', none: 'No access' };
export const ROLE_HELP = {
  admin: 'Everything, including Session videos and Users',
  manager: 'Sees everything, changes nothing',
  guest: 'The shared demo only'
};

export function claimRole(claims = {}) {
  return claims.admin === true ? 'admin' : claims.manager === true ? 'manager' : claims.demo === true ? 'guest' : 'none';
}

/**
 * The signed-in person's role. `readEntry(email)` returns their staff/{email}
 * entry (or null). Resolves { role, reason } — reason says why there's no
 * access: 'off' (switched off), 'unverified' (hasn't set their password from
 * the link yet), or 'no-role'.
 */
export async function resolveRole(user, claims, readEntry) {
  let entry = null;
  try { entry = user?.email ? await readEntry(user.email.toLowerCase()) : null; }
  catch (e) { console.warn('[TFT] people list unreadable; using account claims', e); }
  if (entry) {
    if (entry.active !== true) return { role: 'none', reason: 'off' };
    if (!user.emailVerified) return { role: 'none', reason: 'unverified' };
    return { role: ROLES.includes(entry.role) ? entry.role : 'none', reason: '' };
  }
  const role = claimRole(claims);
  return { role, reason: role === 'none' ? 'no-role' : '' };
}

/** What to tell someone who signed in but can't get in. */
export const NO_ACCESS_NOTE = {
  off: 'That account has been switched off. Ask a Rethink Food admin if you need access.',
  unverified: 'Nearly there: set your password using the link we emailed you (or “Forgot your password?” below), then sign in with it.',
  'no-role': 'That account hasn’t been given access to the demo.'
};
