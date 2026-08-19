// App-only (client-credentials) Graph access for AccessForecast.
const GRAPH = 'https://graph.microsoft.com/v1.0';

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

async function getAll(url, token, pageCap = 50) {
  const out = [];
  let next = url, pages = 0;
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

export async function getSignIns(token, days = 7) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const types = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal'];
  const all = [];
  const errors = [];
  for (const t of types) {
    const filter = `createdDateTime ge ${since} and signInEventTypes/any(x:x eq '${t}')`;
    const url = `${GRAPH}/auditLogs/signIns?$filter=${encodeURIComponent(filter)}&$top=1000`;
    try { all.push(...(await getAll(url, token))); }
    catch (e) { errors.push(`${t}: ${e.message}`); }
  }
  if (all.length === 0 && errors.length) throw new Error('Sign-in read failed -> ' + errors.join(' | '));
  return all;
}

export async function fetchTenantData(tenantId, days = 7) {
  const token = await getAppToken(tenantId);
  const [policies, signIns] = await Promise.all([getPolicies(token), getSignIns(token, days)]);
  return { policies, signIns };
}

export function getConfiguredTenants() {
  try { return JSON.parse(process.env.AF_TENANTS || '[]'); } catch { return []; }
}

export async function discoverTenants() {
  const token = await getAppToken(process.env.PARTNER_TENANT_ID);
  const contracts = await getAll(`${GRAPH}/contracts?$top=999`, token);
  const byId = new Map();
  for (const c of contracts) {
    if (c.customerId && !byId.has(c.customerId)) {
      byId.set(c.customerId, { id: c.customerId, name: (c.displayName || '').trim() || c.defaultDomainName || c.customerId });
    }
  }
  return [...byId.values()];
}

export async function resolveTenants() {
  const override = getConfiguredTenants();
  if (override.length) return override;
  return discoverTenants();
}
