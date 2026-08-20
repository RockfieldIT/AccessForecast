// Lightweight status-check wrapper around the Durable Functions client, exposed as a
// normal HTTP-triggered function so the browser can poll it through the same origin
// (via the Static Web App's /api/ proxy) as the start call. This exists because the
// Durable Task extension's own built-in status webhook
// (/runtime/webhooks/durabletask/instances/{id}) does NOT honour the Function App's
// CORS settings (a known platform limitation), so polling it directly from the browser
// fails with a CORS error even when Allowed Origins is configured correctly. Routing
// through a normal app.http function sidesteps that entirely — and since each poll is
// a fast, cheap request, going back through the SWA proxy for it is fine (the SWA's
// own request timeout is only a problem for one long-held request, not frequent short
// ones).
import { app } from '@azure/functions';
import df from 'durable-functions';

app.http('getReportStatus', {
  methods: ['GET'],
  authLevel: 'anonymous', // fronted by the SWA's own auth; instanceId is an opaque GUID
  extraInputs: [df.input.durableClient()],
  handler: async (request, context) => {
    const instanceId = request.query.get('instanceId');
    if (!instanceId) return { status: 400, jsonBody: { error: 'instanceId required' } };
    const client = df.getClient(context);
    const status = await client.getStatus(instanceId);
    if (!status) return { status: 404, jsonBody: { error: 'job not found' } };
    return {
      jsonBody: {
        instanceId: status.instanceId,
        runtimeStatus: status.runtimeStatus,
        output: status.output,
        customStatus: status.customStatus,
        createdTime: status.createdTime,
        lastUpdatedTime: status.lastUpdatedTime,
      },
    };
  },
});
