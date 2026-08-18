import { app } from '@azure/functions';
import { resolveTenants, getConfiguredTenants } from '../graph.mjs';

app.http('getTenants', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const tenants = await resolveTenants();
      return { jsonBody: { tenants, source: getConfiguredTenants().length ? 'override' : 'gdap-discovery' } };
    } catch (err) {
      context.error(err);
      return { status: 502, jsonBody: { error: String(err.message || err) } };
    }
  },
});
