import { app } from '@azure/functions';
import { fetchTenantData } from '../graph.mjs';
import { analyze } from '../lib/analyze.mjs';

app.http('getReportOnlyImpact', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const tenantId = request.query.get('tenantId');
    const days = Number(request.query.get('days') || 7);
    if (!tenantId) return { status: 400, jsonBody: { error: 'tenantId required' } };
    try {
      const { policies, signIns } = await fetchTenantData(tenantId, days);
      const forecast = analyze(policies, signIns);
      return { jsonBody: { tenantId, days, signInsAnalyzed: signIns.length, forecast } };
    } catch (err) {
      context.error(err);
      return { status: 502, jsonBody: { error: String(err.message || err) } };
    }
  },
});
