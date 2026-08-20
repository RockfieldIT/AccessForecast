// GET /api/getGroups?tenantId=&q= — search-as-you-type group picker for the
// "pilot group" targeting mode. Requires >=2 characters, same reasoning as getUsers.
import { app } from '@azure/functions';
import { searchGroups } from '../graph.mjs';

app.http('getGroups', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const tenantId = request.query.get('tenantId');
    const q = (request.query.get('q') || '').trim();
    if (!tenantId) return { status: 400, jsonBody: { error: 'tenantId required' } };
    if (q.length < 2) return { jsonBody: { groups: [] } };
    try {
      const groups = await searchGroups(tenantId, q);
      return { jsonBody: { groups } };
    } catch (err) {
      context.error(err);
      return { status: 502, jsonBody: { error: String(err.message || err) } };
    }
  },
});
