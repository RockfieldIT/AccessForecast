// GET /api/getTenants — the configured client tenant list for the picker.
import { app } from '@azure/functions';
import { getConfiguredTenants } from '../graph.mjs';

app.http('getTenants', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async () => ({ jsonBody: { tenants: getConfiguredTenants() } }),
});
