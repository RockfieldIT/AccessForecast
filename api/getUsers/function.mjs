// GET /api/getUsers?tenantId=&q= — search-as-you-type user picker for the
// "specific user(s)" targeting mode. Requires >=2 characters to avoid returning
// (or paging through) a whole tenant's directory on an empty/near-empty query.
import { app } from '@azure/functions';
import { searchUsers } from '../graph.mjs';

app.http('getUsers', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const tenantId = request.query.get('tenantId');
    const q = (request.query.get('q') || '').trim();
    if (!tenantId) return { status: 400, jsonBody: { error: 'tenantId required' } };
    if (q.length < 2) return { jsonBody: { users: [] } };
    try {
      const users = await searchUsers(tenantId, q);
      return { jsonBody: { users } };
    } catch (err) {
      context.error(err);
      return { status: 502, jsonBody: { error: String(err.message || err) } };
    }
  },
});
