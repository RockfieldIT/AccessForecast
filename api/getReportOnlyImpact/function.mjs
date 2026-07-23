// GET /api/getReportOnlyImpact?tenantId=<guid>&days=7
// App-only read of one tenant, analysed server-side. Returns { data, forecast }.
import { app } from '@azure/functions';
import { fetchTenantData } from '../graph.mjs';
import { analyze } from '../lib/analyze.mjs'; // vendored copy so the API folder is self-contained for SWA/GitHub build

app.http('getReportOnlyImpact', {
  methods: ['GET'],
  authLevel: 'anonymous', // gated by the Static Web App staff role in front
  handler: async (request, context) => {
    const tenantId = request.query.get('tenantId');
    const days = Number(request.query.get('days') || 7);
    if (!tenantId) return { status: 400, jsonBody: { error: 'tenantId required' } };
    try {
      const data = await fetchTenantData(tenantId, days);
      return { jsonBody: { data, forecast: analyze(data.policies, data.signIns) } };
    } catch (err) {
      context.error(err);
      return { status: 502, jsonBody: { error: String(err.message || err) } };
    }
  },
});
