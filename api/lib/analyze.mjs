// @ts-check
/**
 * Rockfield AccessForecast — Report-Only Conditional Access what-if engine.
 *
 * Pure, hosting-independent. Give it the two things Microsoft Graph returns:
 *   1. Conditional Access policies  (GET /identity/conditionalAccess/policies)
 *   2. Sign-in logs for a window    (GET /auditLogs/signIns)
 *
 * It returns every user / device / app / action that WOULD be blocked (or
 * challenged) the moment the report-only policies are switched to "On", based
 * on what Entra already recorded against each real sign-in.
 *
 * The key Graph fact this relies on: while a policy is in report-only state
 * (`enabledForReportingButNotEnforced`), Entra still evaluates it against every
 * real sign-in and stamps the outcome into
 * signIn.appliedConditionalAccessPolicies[].result:
 *   - reportOnlySuccess     -> user satisfied the controls; no impact
 *   - reportOnlyFailure     -> user did NOT satisfy -> WOULD BE BLOCKED
 *   - reportOnlyInterrupted -> user would have been interrupted (e.g. MFA prompt)
 *   - reportOnlyNotApplied  -> policy did not target this sign-in
 * We treat reportOnlyFailure as a hard block and reportOnlyInterrupted as
 * friction (a challenge the user would have to pass).
 */

/** @typedef {'success'|'failure'|'notApplied'|'notEnabled'|'unknown'|'unknownFutureValue'|'reportOnlySuccess'|'reportOnlyFailure'|'reportOnlyNotApplied'|'reportOnlyInterrupted'} CAResult */

export const REPORT_ONLY_STATE = 'enabledForReportingButNotEnforced';

const IMPACT = /** @type {const} */ ({
  BLOCK: 'block',        // reportOnlyFailure — access would be denied
  CHALLENGE: 'challenge',// reportOnlyInterrupted — extra prompt (usually MFA)
  NONE: 'none',
});

// Grant-control strings Graph returns in enforcedGrantControls / policy.grantControls.builtInControls
const BLOCK_CONTROL = 'block';

/**
 * Classify a single applied-policy result into an impact category.
 * @param {string} result
 * @returns {'block'|'challenge'|'none'}
 */
function classifyResult(result) {
  switch (result) {
    case 'reportOnlyFailure':
      return IMPACT.BLOCK;
    case 'failure': // an already-enforced policy that actually denied access
      return IMPACT.BLOCK;
    case 'reportOnlyInterrupted':
      return IMPACT.CHALLENGE;
    default:
      return IMPACT.NONE;
  }
}

/**
 * Human-readable "why" for a finding, from the enforced grant controls.
 * @param {string[]} controls
 * @returns {string}
 */
function describeControls(controls) {
  if (!controls || controls.length === 0) return 'Grant controls not recorded';
  const map = {
    block: 'Block access',
    mfa: 'Require multifactor authentication',
    compliantDevice: 'Require compliant device',
    domainJoinedDevice: 'Require Hybrid Azure AD joined device',
    approvedApplication: 'Require approved client app',
    compliantApplication: 'Require app protection policy',
    passwordChange: 'Require password change',
  };
  return controls.map((c) => map[c] || c).join(' AND ');
}

/**
 * Is this sign-in legacy authentication (a top reason report-only blocks bite)?
 * @param {string|undefined} clientAppUsed
 */
function isLegacyAuth(clientAppUsed) {
  if (!clientAppUsed) return false;
  const modern = ['Browser', 'Mobile Apps and Desktop clients'];
  return !modern.includes(clientAppUsed);
}

/**
 * @typedef {Object} AnalyzeOptions
 * @property {boolean} [reportOnlyPoliciesOnly] Only count impact from policies currently in report-only state (default true). If false, also counts already-enforced failures.
 */

/**
 * @param {any[]} policies  Graph conditionalAccessPolicy objects
 * @param {any[]} signIns   Graph signIn objects
 * @param {AnalyzeOptions} [options]
 */
export function analyze(policies, signIns, options = {}) {
  const reportOnlyOnly = options.reportOnlyPoliciesOnly !== false;

  const policyById = new Map();
  for (const p of policies || []) policyById.set(p.id, p);

  const reportOnlyIds = new Set(
    (policies || []).filter((p) => p.state === REPORT_ONLY_STATE).map((p) => p.id)
  );

  /** @type {any[]} findings — one row per (sign-in × impacting policy) */
  const findings = [];

  for (const s of signIns || []) {
    const applied = s.appliedConditionalAccessPolicies || [];
    for (const ap of applied) {
      const impact = classifyResult(ap.result);
      if (impact === IMPACT.NONE) continue;

      // If we only care about policies still in report-only, filter here.
      const policy = policyById.get(ap.id);
      const isReportOnly = reportOnlyIds.has(ap.id) || ap.result?.startsWith('reportOnly');
      if (reportOnlyOnly && !isReportOnly) continue;

      const controls = ap.enforcedGrantControls || policy?.grantControls?.builtInControls || [];
      const hardBlock = controls.map((c) => String(c).toLowerCase()).includes(BLOCK_CONTROL);
      const authStrength = policy?.grantControls?.authenticationStrength?.displayName || null;

      findings.push({
        signInId: s.id,
        when: s.createdDateTime,
        userPrincipalName: s.userPrincipalName || s.userDisplayName || '(unknown user)',
        userId: s.userId || null,
        userDisplayName: s.userDisplayName || null,
        app: s.appDisplayName || s.resourceDisplayName || '(unknown app)',
        appId: s.appId || null,
        resource: s.resourceDisplayName || null,
        clientApp: s.clientAppUsed || '(unknown)',
        legacyAuth: isLegacyAuth(s.clientAppUsed),
        ip: s.ipAddress || null,
        location: [s.location?.city, s.location?.countryOrRegion].filter(Boolean).join(', ') || null,
        device: s.deviceDetail?.displayName || s.deviceDetail?.operatingSystem || null,
        deviceId: s.deviceDetail?.deviceId || null,
        deviceCompliant: s.deviceDetail?.isCompliant ?? null,
        deviceManaged: s.deviceDetail?.isManaged ?? null,
        os: s.deviceDetail?.operatingSystem || null,
        browser: s.deviceDetail?.browser || null,
        policyId: ap.id,
        policyName: ap.displayName || policy?.displayName || ap.id,
        result: ap.result,
        impact: hardBlock ? IMPACT.BLOCK : impact, // explicit Block control always = block
        controls,
        reason: controls.length
          ? describeControls(controls)
          : authStrength
          ? `Require authentication strength: ${authStrength}`
          : 'Grant controls not recorded',
        signInErrorCode: s.status?.errorCode ?? null,
      });
    }
  }

  return {
    summary: buildSummary(policies || [], reportOnlyIds, findings, signIns || []),
    byUser: groupBy(findings, (f) => f.userPrincipalName, 'user'),
    byApp: groupBy(findings, (f) => f.app, 'app'),
    byPolicy: buildPolicyImpact(policies || [], reportOnlyIds, findings),
    byClientApp: groupBy(findings, (f) => f.clientApp, 'clientApp'),
    byDevice: groupBy(findings.filter((f) => f.device), (f) => `${f.device}`, 'device'),
    byLocation: groupBy(findings.filter((f) => f.location), (f) => f.location, 'location'),
    legacyAuth: buildLegacyAuthView(findings),
    findings,
  };
}

/**
 * @param {any[]} findings
 * @param {(f:any)=>string} keyFn
 * @param {string} keyName
 */
function groupBy(findings, keyFn, keyName) {
  const map = new Map();
  for (const f of findings) {
    const k = keyFn(f);
    if (!map.has(k)) {
      map.set(k, {
        [keyName]: k,
        total: 0,
        blocked: 0,
        challenged: 0,
        users: new Set(),
        apps: new Set(),
        policies: new Set(),
        clientApps: new Set(),
        firstSeen: f.when,
        lastSeen: f.when,
      });
    }
    const g = map.get(k);
    g.total++;
    if (f.impact === IMPACT.BLOCK) g.blocked++;
    else g.challenged++;
    g.users.add(f.userPrincipalName);
    g.apps.add(f.app);
    g.policies.add(f.policyName);
    g.clientApps.add(f.clientApp);
    if (f.when && f.when < g.firstSeen) g.firstSeen = f.when;
    if (f.when && f.when > g.lastSeen) g.lastSeen = f.when;
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      users: [...g.users],
      apps: [...g.apps],
      policies: [...g.policies],
      clientApps: [...g.clientApps],
      userCount: g.users.size,
      appCount: g.apps.size,
    }))
    .sort((a, b) => b.blocked - a.blocked || b.total - a.total);
}

/**
 * Per-policy blast radius, including a "safe to enforce?" verdict for every
 * report-only policy (even the ones with zero impact — those are the wins).
 * @param {any[]} policies
 * @param {Set<string>} reportOnlyIds
 * @param {any[]} findings
 */
function buildPolicyImpact(policies, reportOnlyIds, findings) {
  const byId = new Map();
  for (const f of findings) {
    if (!byId.has(f.policyId)) {
      byId.set(f.policyId, { blocked: 0, challenged: 0, users: new Set(), apps: new Set() });
    }
    const g = byId.get(f.policyId);
    if (f.impact === IMPACT.BLOCK) g.blocked++;
    else g.challenged++;
    g.users.add(f.userPrincipalName);
    g.apps.add(f.app);
  }

  const rows = [];
  for (const p of policies) {
    if (!reportOnlyIds.has(p.id)) continue; // only report-only policies are "about to be enforced"
    const g = byId.get(p.id) || { blocked: 0, challenged: 0, users: new Set(), apps: new Set() };
    const impactedUsers = g.users.size;
    rows.push({
      policyId: p.id,
      policyName: p.displayName,
      state: p.state,
      grant:
        (p.grantControls?.builtInControls || []).length
          ? describeControls(p.grantControls.builtInControls)
          : p.grantControls?.authenticationStrength?.displayName
          ? `Require authentication strength: ${p.grantControls.authenticationStrength.displayName}`
          : p.sessionControls
          ? 'Session controls'
          : 'Grant controls not recorded',
      blockedSignIns: g.blocked,
      challengedSignIns: g.challenged,
      impactedUsers,
      impactedApps: g.apps.size,
      verdict:
        g.blocked === 0 && g.challenged === 0
          ? 'SAFE — no impact in this window; ready to enforce'
          : g.blocked > 0
          ? `IMPACT — would block ${g.blocked} sign-in(s) across ${impactedUsers} user(s)`
          : `FRICTION — would challenge ${g.challenged} sign-in(s) across ${impactedUsers} user(s)`,
    });
  }
  return rows.sort((a, b) => b.blockedSignIns - a.blockedSignIns || b.challengedSignIns - a.challengedSignIns);
}

/**
 * @param {any[]} findings
 */
function buildLegacyAuthView(findings) {
  const legacy = findings.filter((f) => f.legacyAuth && f.impact === IMPACT.BLOCK);
  const byUser = groupBy(legacy, (f) => f.userPrincipalName, 'user');
  return {
    totalBlockedSignIns: legacy.length,
    affectedUsers: byUser.length,
    protocols: [...new Set(legacy.map((f) => f.clientApp))],
    users: byUser,
  };
}

/**
 * @param {any[]} policies
 * @param {Set<string>} reportOnlyIds
 * @param {any[]} findings
 * @param {any[]} signIns
 */
function buildSummary(policies, reportOnlyIds, findings, signIns) {
  const blocked = findings.filter((f) => f.impact === IMPACT.BLOCK);
  const challenged = findings.filter((f) => f.impact === IMPACT.CHALLENGE);
  const blockedUsers = new Set(blocked.map((f) => f.userPrincipalName));
  const challengedUsers = new Set(challenged.map((f) => f.userPrincipalName));
  const dates = signIns.map((s) => s.createdDateTime).filter(Boolean).sort();

  return {
    windowStart: dates[0] || null,
    windowEnd: dates[dates.length - 1] || null,
    signInsAnalyzed: signIns.length,
    reportOnlyPolicies: reportOnlyIds.size,
    policiesTotal: policies.length,
    wouldBeBlockedSignIns: blocked.length,
    wouldBeChallengedSignIns: challenged.length,
    usersBlocked: blockedUsers.size,
    usersChallenged: challengedUsers.size,
    // Users challenged-only (not also hard-blocked) — softer bucket.
    usersChallengedOnly: [...challengedUsers].filter((u) => !blockedUsers.has(u)).length,
    legacyAuthBlockedSignIns: blocked.filter((f) => f.legacyAuth).length,
    verdict:
      blocked.length === 0
        ? 'READY — no sign-in in this window would be blocked. Safe to enforce.'
        : `HOLD — enforcing now would block ${blocked.length} sign-in(s) across ${blockedUsers.size} user(s). Review below before flipping to On.`,
  };
}
