// App-only (client-credentials) Graph access for AccessForecast.
// Fully unattended: no interactive sign-in, no refresh token. The multitenant
// app is consented in each client tenant (via CIPP App Approval or admin consent),
// and here we mint an app-only token PER TENANT and read Graph read-only.
//
// Secrets come from app settings (inlined value — SWA managed functions do NOT
// resolve Key Vault references, so store the secret VALUE, not a @Microsoft.KeyVault ref):
//   AF_CLIENT_ID        app (client) ID of the multitenant app registration
//   AF_CLIENT_SECRET    client secret VALUE
//   PARTNER_TENANT_ID   your MSP tenant id (used to enumerate customers)
//   AF_TENANTS          OPTIONAL override. Leave unset to auto-discover every client.
//                       Set only to pin/limit the list, e.g.
//                       [{ "id": "<guid>", "name": "Client A" }, ...]

const GRAPH = 'https://graph.microsoft.com/v1.0';
const BETA = 'https://graph.microsoft.com/beta';

/** App-only token for a specific customer tenant. */
export async function getAppToken(tenantId) {
  const body = new URLSearchParams({
    client_id: process.env.AF_CLIENT_ID,
    client_secret: process.env.AF_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token (${res.status}) for ${tenantId}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).access_token;
}

/** Page through a Graph collection, concatenating every `value` array. */
async function getAll(url, token, pageCap = 50, extraHeaders = {}) {
  const out = [];
  let next = url,
    pages = 0;
  while (next && pages < pageCap) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } });
    if (!res.ok) throw new Error(`Graph ${res.status} on ${next}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    out.push(...(json.value || []));
    next = json['@odata.nextLink'] || null;
    pages++;
  }
  return out;
}

export function getPolicies(token) {
  return getAll(`${GRAPH}/identity/conditionalAccess/policies`, token);
}

function escOData(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Build the `userPrincipalName eq '...' or ...` OData clause for scoping sign-ins
 * to one or more users (used for both "specific user(s)" and "pilot group" modes —
 * a group is just resolved to its member UPNs first, then filtered the same way).
 */
function buildUserClause(users) {
  if (!users) return '';
  const list = Array.isArray(users) ? users : [users];
  const clean = list.map((u) => String(u || '').trim()).filter(Boolean);
  if (!clean.length) return '';
  return ' and (' + clean.map((u) => `userPrincipalName eq '${escOData(u)}'`).join(' or ') + ')';
}

/**
 * All sign-in event types (interactive + non-interactive + service principal),
 * fetched IN PARALLEL with per-type page caps to stay under the Static Web App
 * managed-function 45s limit. `signInEventTypes` exists on BETA only — v1.0 400s.
 * Optionally scope to one or more users (keeps big tenants inside the timeout,
 * and is also how "specific user(s)" and "pilot group" targeting are implemented —
 * a group is resolved to member UPNs upstream and passed in here as a list).
 * @param {string} token
 * @param {number} days
 * @param {string|string[]|null} users  userPrincipalName(s) to scope to (optional)
 */
export async function getSignIns(token, days = 7, users = null) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const userClause = buildUserClause(users);
  // Page caps bound worst-case work. On the standalone Function App (10-min timeout)
  // these can be generous; on SWA managed functions (45s) keep them low. Override per
  // deployment with AF_MAXPAGES_INTERACTIVE / _NONINTERACTIVE / _SP (each page = up to 1000).
  const cap = (name, def) => Math.max(1, Number(process.env[name] || def));
  const plan = [
    { t: 'interactiveUser', maxPages: cap('AF_MAXPAGES_INTERACTIVE', 60) },
    { t: 'nonInteractiveUser', maxPages: cap('AF_MAXPAGES_NONINTERACTIVE', 60) },
    { t: 'servicePrincipal', maxPages: cap('AF_MAXPAGES_SP', 15) },
  ];
  const errors = [];
  const pull = async ({ t, maxPages }) => {
    const items = [];
    const filter = `createdDateTime ge ${since} and signInEventTypes/any(x:x eq '${t}')${userClause}`;
    let url = `${BETA}/auditLogs/signIns?$filter=${encodeURIComponent(filter)}&$top=1000`;
    let pages = 0;
    try {
      while (url && pages < maxPages) {
        const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = await res.json();
        items.push(...(json.value || []));
        url = json['@odata.nextLink'] || null;
        pages++;
      }
    } catch (e) {
      errors.push(`${t}: ${e.message}`);
    }
    return items;
  };
  const results = await Promise.all(plan.map(pull));
  const all = results.flat();
  if (all.length === 0 && errors.length) throw new Error('Sign-in read failed -> ' + errors.join(' | '));
  return all;
}

/**
 * One-shot: raw Graph data for a tenant.
 * @param {string} tenantId
 * @param {number} days
 * @param {string|string[]|null} users  optional user scope (single UPN, or a list —
 *   a list is how both "specific user(s)" and "pilot group" targeting are implemented)
 */
export async function fetchTenantData(tenantId, days = 7, users = null) {
  const token = await getAppToken(tenantId);
  const [policies, signIns] = await Promise.all([getPolicies(token), getSignIns(token, days, users)]);
  return { policies, signIns };
}

/** Optional manual override list (AF_TENANTS). Empty unless explicitly set. */
export function getConfiguredTenants() {
  try {
    return JSON.parse(process.env.AF_TENANTS || '[]');
  } catch {
    return [];
  }
}

/**
 * Auto-discover every customer tenant. Rockfield reaches clients via the CSP
 * reseller relationship (no GDAP), so we enumerate /contracts in the PARTNER
 * tenant — each contract is a managed customer.
 *   customerId  -> tenant id
 *   displayName -> tenant name
 * Runs app-only against YOUR partner tenant. Needs Directory.Read.All.
 * @returns {Promise<{id:string,name:string}[]>}
 */
export async function discoverTenants() {
  const token = await getAppToken(process.env.PARTNER_TENANT_ID);
  const contracts = await getAll(`${GRAPH}/contracts?$top=999`, token, 20);
  const byId = new Map();
  for (const c of contracts) {
    const id = c.customerId;
    if (id && !byId.has(id)) byId.set(id, { id, name: c.displayName || id });
  }
  return [...byId.values()];
}

/**
 * The tenant list to act on: the manual override if provided, otherwise the live
 * CSP-discovered estate. This is what makes rollout automatic — onboard a client
 * and it shows up here with no config change.
 */
export async function resolveTenants() {
  const override = getConfiguredTenants();
  if (override.length) return override;
  return discoverTenants();
}

/**
 * Search users in a client tenant, for the "specific user(s)" target picker.
 * Matching startswith(displayName) OR startswith(userPrincipalName) against a
 * client-tenant token needs the ConsistencyLevel:eventual header (Graph "advanced
 * query" requirement whenever an `or` spans two different properties in $filter).
 * @param {string} tenantId
 * @param {string} q  search text (min 2 chars enforced by the caller/UI)
 * @param {number} top
 */
export async function searchUsers(tenantId, q, top = 15) {
  const token = await getAppToken(tenantId);
  const clean = escOData(q);
  const filter = `startswith(displayName,'${clean}') or startswith(userPrincipalName,'${clean}') or startswith(mail,'${clean}')`;
  const url = `${GRAPH}/users?$select=id,displayName,userPrincipalName,mail&$filter=${encodeURIComponent(filter)}&$top=${top}&$count=true`;
  const items = await getAll(url, token, 1, { ConsistencyLevel: 'eventual' });
  return items.map((u) => ({ id: u.id, displayName: u.displayName || u.userPrincipalName, userPrincipalName: u.userPrincipalName }));
}

/**
 * Search security/M365 groups in a client tenant, for the "pilot group" target picker.
 * @param {string} tenantId
 * @param {string} q
 * @param {number} top
 */
export async function searchGroups(tenantId, q, top = 15) {
  const token = await getAppToken(tenantId);
  const clean = escOData(q);
  const filter = `startswith(displayName,'${clean}')`;
  const url = `${GRAPH}/groups?$select=id,displayName,description,securityEnabled,mailEnabled&$filter=${encodeURIComponent(filter)}&$top=${top}&$count=true`;
  const items = await getAll(url, token, 1, { ConsistencyLevel: 'eventual' });
  return items.map((g) => ({ id: g.id, displayName: g.displayName, description: g.description || null }));
}

/**
 * Resolve a group's members down to a flat list of userPrincipalNames. Only
 * entries that actually have a userPrincipalName are kept (i.e. users — nested
 * groups, devices, or service principals that may also be members are skipped),
 * since the sign-in filter is scoped by userPrincipalName.
 * @param {string} tenantId
 * @param {string} groupId
 */
export async function getGroupMemberUpns(tenantId, groupId) {
  const token = await getAppToken(tenantId);
  const url = `${GRAPH}/groups/${groupId}/members?$select=id,displayName,userPrincipalName&$top=999`;
  const members = await getAll(url, token, 30);
  return members.filter((m) => m.userPrincipalName).map((m) => m.userPrincipalName);
}
