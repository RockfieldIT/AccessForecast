// GET /api/getReportOnlyImpact?tenantId=<guid>&days=7[&user=<upn>]
// App-only read of ONE tenant, analysed server-side. Returns a COMPACT,
// technician-facing report — never the raw sign-in dump (that overran the
// Static Web App managed-function response limit and 500'd).
//
// Response shape:
//   {
//     tenantId, days, user,
//     signInsAnalyzed,
//     summary,   // headline verdict + definite/silent/prompt counts
//     report,    // per-policy, per-user action lines with reason + fix
//     byPolicy,  // "safe to enforce?" verdict for every report-only policy
//     legacyAuth // legacy-protocol blocks rolled up (the usual first offender)
//   }
import { app } from '@azure/functions';
import { fetchTenantData } from '../graph.mjs';
import { analyze } from '../lib/analyze.mjs'; // vendored copy so the API folder is self-contained for SWA/GitHub build

app.http('getReportOnlyImpact', {
  methods: ['GET'],
  authLevel: 'anonymous', // gated by the Static Web App staff role in front
  handler: async (request, context) => {
    const tenantId = request.query.get('tenantId');
    const days = Number(request.query.get('days') || 7);
    const user = request.query.get('user') || null; // optional single-user scope (keeps big tenants under the 45s limit)
    if (!tenantId) return { status: 400, jsonBody: { error: 'tenantId required' } };
    try {
      const { policies, signIns } = await fetchTenantData(tenantId, days, user);
      const forecast = analyze(policies, signIns);
      return {
        jsonBody: {
          tenantId,
          days,
          user,
          signInsAnalyzed: signIns.length,
          summary: forecast.summary,
          report: forecast.report,
          byPolicy: forecast.byPolicy,
          legacyAuth: forecast.legacyAuth,
        },
      };
    } catch (err) {
      context.error(err);
      return { status: 502, jsonBody: { error: String(err.message || err) } };
    }
  },
});
