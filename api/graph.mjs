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
async function getAll(url, token, pageCap = 50) {
  const out = [];
  let next = url,
    pages = 0;
  while (next && pages < pageCap) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
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

/**
 * All sign-in event types (interactive + non-interactive + service principal),
 * fetched IN PARALLEL with per-type page caps to stay under the Static Web App
 * managed-function 45s limit. `signInEventTypes` exists on BETA only — v1.0 400s.
 * Optionally scope to a single user (keeps big tenants inside the timeout).
 * @param {string} token
 * @param {number} days
 * @param {string|null} user  userPrincipalName to scope to (optional)
 */
export async function getSignIns(token, days = 7, user = null) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const userClause = user ? ` and userPrincipalName eq '${user.replace(/'/g, "''")}'` : '';
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
 * @param {string|null} user  optional single-user scope
 */
export async function fetchTenantData(tenantId, days = 7, user = null) {
  const token = await getAppToken(tenantId);
  const [policies, signIns] = await Promise.all([getPolicies(token), getSignIns(token, days, user)]);
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
