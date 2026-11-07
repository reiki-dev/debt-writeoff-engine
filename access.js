'use strict';

// ----------------------------------------------------------------------------
// Access permissions. The single source of truth for what each role can do.
//
// Role -> capability list. Check capabilities rather than roles: if another
// role is added or write-off is split into preview and apply, update this table
// instead of a dozen conditions throughout the code.
//
// The frontend gets its list from GET /api/me and renders tabs from it, keeping
// the interface aligned with the server.
//
// A hidden tab is not security. Every route checks the capability itself;
// otherwise the mail role could invoke write-off with curl and its own token.
// ----------------------------------------------------------------------------

const CAPS = {
  PREHLED: 'prehled',     // view customer loans (read-only)
  WRITEOFF: 'writeoff',   // write off debt — writes to CRM
  USERS: 'users',         // user management and debug route
};

const ROLE_CAPS = {
  admin: [CAPS.PREHLED, CAPS.WRITEOFF, CAPS.USERS],
  cc: [CAPS.WRITEOFF],
  mail: [CAPS.PREHLED],
};

const ROLES = Object.keys(ROLE_CAPS);

// The default role is the least privileged. A user without a role field in
// users.json must not accidentally get admin privileges, so default to mail.
const DEFAULT_ROLE = 'mail';

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return ROLE_CAPS[value] ? value : DEFAULT_ROLE;
}

function capsOf(role) {
  return ROLE_CAPS[normalizeRole(role)].slice();
}

function can(role, cap) {
  return ROLE_CAPS[normalizeRole(role)].includes(cap);
}

module.exports = { CAPS, ROLES, ROLE_CAPS, DEFAULT_ROLE, normalizeRole, capsOf, can };
