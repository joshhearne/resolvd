// Unified directory lookup. Tries Microsoft Graph first (graphUsers),
// then Google Admin Directory (googleUsers). Returns the first non-null
// result, or null when neither directory resolves the address.
//
// Used by auto-provision and the submitter-change path to enrich a user
// record (displayName, office location, department, job title) without
// the caller having to know which directory backend is configured. A
// tenant with only Microsoft 365 connected will see Graph hits; a
// Workspace tenant will see Google hits; a tenant with neither sees
// null and we fall back to the raw email.

const graphUsers = require('./graphUsers');
const googleUsers = require('./googleUsers');

// Shape: { displayName, officeLocation, department, jobTitle, mail,
// userPrincipalName, source }. source is 'graph' or 'google' so callers
// can route follow-up actions (audit text, auth_provider hint).
async function lookupByEmail(email) {
  if (!email) return null;
  const g = await graphUsers.lookupUserByEmail(email).catch(() => null);
  if (g && (g.displayName || g.officeLocation || g.department || g.jobTitle)) {
    return { ...g, source: 'graph' };
  }
  const goog = await googleUsers.lookupUserByEmail(email).catch(() => null);
  if (goog && (goog.displayName || goog.officeLocation || goog.department || goog.jobTitle)) {
    return { ...goog, source: 'google' };
  }
  return null;
}

module.exports = { lookupByEmail };
