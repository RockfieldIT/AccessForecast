// GET /api/getEstate?days=7
// The unattended, all-clients-at-once roll-up. Loops every configured tenant,
// reads app-only, and returns one readiness row per tenant. This is the endpoint
// that makes "which of my 40 clients is safe to enforce?" a single glance.
import { app } from '@azure/functions';
import { fetchTenantData, resolveTenants } from '../graph.mjs';
import { analyze } from '../lib/analyze.mjs'; // vendored copy so the API folder is self-contained for SWA/GitHub build

const CONCURRENCY = 5;

async function mapPool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

app.http('getEstate', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const days = Number(request.query.get('days') || 7);
    let tenants;
    try {
      tenants = await resolveTenants(); // GDAP auto-discovery unless AF_TENANTS overrides
    } catch (err) {
      context.error(err);
      return { status: 502, jsonBody: { error: `Tenant discovery failed: ${err.message}` } };
    }
    if (!tenants.length) return { status: 200, jsonBody: { days, rows: [], note: 'No active GDAP customers found and no AF_TENANTS override set.' } };

    const rows = await mapPool(tenants, CONCURRENCY, async (t) => {
      try {
        const { policies, signIns } = await fetchTenantData(t.id, days);
        const s = analyze(policies, signIns).summary;
        return {
          tenant: t.name || t.id,
          tenantId: t.id,
          verdict: s.verdict, // READY | HOLD
          reportOnlyPolicies: s.reportOnlyPolicies,
          usersBlocked: s.usersBlocked,
          wouldBeBlockedSignIns: s.wouldBeBlockedSignIns,
          legacyAuthBlockedSignIns: s.legacyAuthBlockedSignIns,
          signInsAnalyzed: s.signInsAnalyzed,
          error: null,
        };
      } catch (err) {
        context.error(`${t.name || t.id}: ${err.message}`);
        return { tenant: t.name || t.id, tenantId: t.id, verdict: 'ERROR', error: String(err.message || err) };
      }
    });

    return { jsonBody: { days, generatedFromTenants: tenants.length, rows } };
  },
});
