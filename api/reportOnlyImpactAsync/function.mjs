// Async (Durable Functions) version of getReportOnlyImpact, for whole-tenant /
// long-window scans that outlive the Static Web App front-door's own request
// timeout — a SEPARATE, shorter, non-configurable limit from this Function
// App's own `functionTimeout`. Linking a standalone Function App only removed
// the old 45s *managed-functions* cap; it did not remove the SWA edge's own
// proxy timeout for `/api/*` calls. The fix: never hold one HTTP request open
// for the whole scan.
//
//   1. GET /api/startReportOnlyImpact?tenantId=&days=[&mode=tenant|users|group]
//        [&users=upn1,upn2,...][&groupId=&groupName=]
//      Starts the job and immediately returns { id, statusQueryGetUri, ... } —
//      `id` is the instance id, used to poll /api/getReportStatus?instanceId=
//      (a same-origin wrapper — see getReportStatus/function.mjs for why we
//      don't poll statusQueryGetUri directly: the Durable Task extension's own
//      built-in status webhook doesn't honour this Function App's CORS setting).
//   2. The browser polls that URL every couple of seconds. Its response has
//      `runtimeStatus` (Pending/Running/Completed/Failed) and, once
//      Completed, an `output` field holding the same payload the old
//      synchronous endpoint used to return directly, plus a `scope` block
//      describing what was targeted (whole tenant / specific user(s) / a
//      pilot group) so the UI can make that unambiguous in the results.
//
// Targeting modes:
//   tenant  (default) — every user in the tenant, unfiltered.
//   users   — one or more userPrincipalName values, comma-separated in `users`.
//   group   — resolved server-side to that group's member UPNs (getGroupMemberUpns),
//             then filtered exactly like `users` mode. `groupName` is passed through
//             only for the scope label — membership is always re-resolved live.
import { app } from '@azure/functions';
import df from 'durable-functions';
import { fetchTenantData, getGroupMemberUpns } from '../graph.mjs';
import { analyze } from '../lib/analyze.mjs';

function scopeLabel(mode, users, groupName) {
  if (mode === 'group') return `the "${groupName || 'selected'}" group (${users.length} member(s))`;
  if (mode === 'users') return users.length === 1 ? users[0] : `${users.length} selected users`;
  return 'the whole tenant';
}

df.app.activity('reportOnlyImpactActivity', {
  handler: async (input) => {
    const { tenantId, days, mode, users, groupId, groupName } = input;
    let targetUsers = null; // null == whole tenant, unfiltered
    let resolvedGroupSize = null;

    if (mode === 'group' && groupId) {
      targetUsers = await getGroupMemberUpns(tenantId, groupId);
      resolvedGroupSize = targetUsers.length;
    } else if (mode === 'users' && Array.isArray(users) && users.length) {
      targetUsers = users;
    }

    const { policies, signIns } = await fetchTenantData(tenantId, days, targetUsers);
    const forecast = analyze(policies, signIns);
    return {
      tenantId,
      days,
      signInsAnalyzed: signIns.length,
      summary: forecast.summary,
      report: forecast.report,
      byPolicy: forecast.byPolicy,
      legacyAuth: forecast.legacyAuth,
      scope: {
        mode: mode === 'group' || mode === 'users' ? mode : 'tenant',
        label: scopeLabel(mode, targetUsers || [], groupName),
        targetUserCount: targetUsers ? targetUsers.length : null,
        groupName: mode === 'group' ? groupName || null : null,
        resolvedGroupSize,
      },
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
    const mode = request.query.get('mode') || 'tenant'; // tenant | users | group
    const usersParam = request.query.get('users') || '';
    const users = usersParam
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    const groupId = request.query.get('groupId') || null;
    const groupName = request.query.get('groupName') || null;
    if (!tenantId) return { status: 400, jsonBody: { error: 'tenantId required' } };
    if (mode === 'users' && !users.length) return { status: 400, jsonBody: { error: 'mode=users requires at least one entry in users=' } };
    if (mode === 'group' && !groupId) return { status: 400, jsonBody: { error: 'mode=group requires groupId' } };
    const client = df.getClient(context);
    const instanceId = await client.startNew('reportOnlyImpactOrchestrator', {
      input: { tenantId, days, mode, users, groupId, groupName },
    });
    context.log(`Started report orchestration ${instanceId} for tenant ${tenantId} (mode=${mode})`);
    return client.createCheckStatusResponse(request, instanceId);
  },
});
