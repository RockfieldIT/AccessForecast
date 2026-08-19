// GET /api/getTenants — the client tenant list for the picker.
// Auto-discovered from your active GDAP relationships (or the AF_TENANTS override).
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
