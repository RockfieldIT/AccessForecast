// App-only (client-credentials) Graph access for AccessForecast.
// Fully unattended: no interactive sign-in, no refresh token. The multitenant
// app is consented in each client tenant (via CIPP App Approval or admin consent),
// and here we mint an app-only token PER TENANT and read Graph read-only.
//
// Secrets come from app settings backed by Key Vault — never hard-code:
//   AF_CLIENT_ID       app (client) ID of the multitenant app registration
//   AF_CLIENT_SECRET   client secret (or swap for a certificate — see DEPLOYMENT.md)
//   AF_TENANTS         JSON: [{ "id": "<guid>", "name": "Client A" }, ...]

const GRAPH = 'https://graph.microsoft.com/v1.0';

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

/** All sign-in event types (interactive + non-interactive + service principal). */
export async function getSignIns(token, days = 7) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const types = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal'];
  const all = [];
  for (const t of types) {
    const filter = `createdDateTime ge ${since} and signInEventTypes/any(x:x eq '${t}')`;
    const url = `${GRAPH}/auditLogs/signIns?$filter=${encodeURIComponent(filter)}&$top=1000`;
    try {
      all.push(...(await getAll(url, token)));
    } catch (e) {
      // Some event types may be unavailable on lower SKUs — keep going.
      console.warn(`signIns ${t}: ${e.message}`);
    }
  }
  return all;
}

/** One-shot: raw Graph data for a tenant. */
export async function fetchTenantData(tenantId, days = 7) {
  const token = await getAppToken(tenantId);
  const [policies, signIns] = await Promise.all([getPolicies(token), getSignIns(token, days)]);
  return { policies, signIns };
}

/** Configured customer tenant list (from Key Vault-backed app setting). */
export function getConfiguredTenants() {
  try {
    return JSON.parse(process.env.AF_TENANTS || '[]');
  } catch {
    return [];
  }
}
