// Async (Durable Functions) version of getReportOnlyImpact, for whole-tenant /
// long-window scans that outlive the Static Web App front-door's own request
// timeout — a SEPARATE, shorter, non-configurable limit from this Function
// App's own `functionTimeout`. Linking a standalone Function App only removed
// the old 45s *managed-functions* cap; it did not remove the SWA edge's own
// proxy timeout for `/api/*` calls. The fix: never hold one HTTP request open
// for the whole scan.
//
//   1. GET /api/startReportOnlyImpact?tenantId=&days=[&user=]
//      Starts the job and immediately returns a small JSON payload
//      containing `statusQueryGetUri` — an absolute URL, on this Function
//      App's own host (bypassing the SWA proxy and its timeout entirely),
//      that the browser polls directly.
//   2. The browser polls that URL every couple of seconds. Its response has
//      `runtimeStatus` (Pending/Running/Completed/Failed) and, once
//      Completed, an `output` field holding the same payload the old
//      synchronous endpoint used to return directly.
//
// Needs CORS enabled on this Function App for the Static Web App's origin,
// since step 2 polls directly against *.azurewebsites.net, not through the
// SWA. See docs/DEPLOYMENT-FUNCTIONAPP.md.
import { app } from '@azure/functions';
import df from 'durable-functions';
import { fetchTenantData } from '../graph.mjs';
import { analyze } from '../lib/analyze.mjs';

df.app.activity('reportOnlyImpactActivity', {
  handler: async (input) => {
    const { tenantId, days, user } = input;
    const { policies, signIns } = await fetchTenantData(tenantId, days, user);
    const forecast = analyze(policies, signIns);
    return {
      tenantId,
      days,
      user,
      signInsAnalyzed: signIns.length,
      summary: forecast.summary,
      report: forecast.report,
      byPolicy: forecast.byPolicy,
      legacyAuth: forecast.legacyAuth,
    };
  },
});

df.app.orchestration('reportOnlyImpactOrchestrator', function* (context) {
  const input = context.df.getInput();
  return yield context.df.callActivity('reportOnlyImpactActivity', input);
});

app.http('startReportOnlyImpact', {
  methods: ['GET'],
  authLevel: 'anonymous', // start call is gated by the SWA staff role in front; the poll URL carries its own short-lived system key
  extraInputs: [df.input.durableClient()],
  handler: async (request, context) => {
    const tenantId = request.query.get('tenantId');
    const days = Number(request.query.get('days') || 7);
    const user = request.query.get('user') || null;
    if (!tenantId) return { status: 400, jsonBody: { error: 'tenantId required' } };
    const client = df.getClient(context);
    const instanceId = await client.startNew('reportOnlyImpactOrchestrator', { input: { tenantId, days, user } });
    context.log(`Started report orchestration ${instanceId} for tenant ${tenantId}`);
    return client.createCheckStatusResponse(request, instanceId);
  },
});
