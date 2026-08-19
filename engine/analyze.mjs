// @ts-check
/**
 * Rockfield AccessForecast — Report-Only Conditional Access what-if engine.
 *
 * Pure, hosting-independent. Give it the two things Microsoft Graph returns:
 *   1. Conditional Access policies  (GET /identity/conditionalAccess/policies)
 *   2. Sign-in logs for a window    (GET /auditLogs/signIns, all event types)
 *
 * GOAL (per the technician brief): identify every sign-in — interactive OR
 * non-interactive — that would DEFINITELY be blocked, or has a HIGH LIKELIHOOD
 * of being blocked, the moment a report-only Conditional Access policy is
 * switched to "On". Then say it in one line a technician can act on:
 *   "If you enable <policy>, <user> will be blocked from <app> — because <reason> — fix: <remediation>."
 *
 * How it knows: while a policy is in report-only state
 * (`enabledForReportingButNotEnforced`), Entra still evaluates it against every
 * real sign-in and stamps the outcome into
 * signIn.appliedConditionalAccessPolicies[].result:
 *   - reportOnlySuccess     -> user satisfied the controls; no impact (dropped)
 *   - reportOnlyFailure     -> user did NOT satisfy -> WOULD BE BLOCKED (definite)
 *   - reportOnlyInterrupted -> user would have been interrupted (prompt/challenge)
 *   - reportOnlyNotApplied  -> policy did not target this sign-in (dropped)
 *
 * The interactivity of the sign-in (signIn.isInteractive) decides how much an
 * interruption actually hurts:
 *   - A non-interactive sign-in is a background token refresh (OneDrive sync,
 *     Outlook, Teams, Windows Search). Nobody is at the keyboard to answer an
 *     MFA prompt, so an interruption there = the background service SILENTLY
 *     STOPS WORKING. That is the highest-value thing this tool surfaces.
 *   - An interactive sign-in interruption is a prompt the user can usually
 *     satisfy at the time (do MFA) — friction, not breakage — UNLESS the grant
 *     demands something they can't produce at a prompt (a compliant/entra-joined
 *     device, an approved/protected app), in which case it's an effective block.
 *
 * Four confidence buckets, most to least severe:
 *   definite — reportOnlyFailure (or an enforced failure) -> access denied, no way through.
 *   silent   — an interruption that will break with no human able to fix it in the moment:
 *                • a non-interactive sign-in (background service breaks silently), or
 *                • an interactive interruption whose grant needs a device/app the
 *                  user can't conjure at a prompt (compliant device, hybrid join,
 *                  approved/protected app).
 *   prompt   — an interactive interruption the user can satisfy (typically MFA).
 *   (dropped)— reportOnlySuccess / reportOnlyNotApplied.
 */

/** @typedef {'success'|'failure'|'notApplied'|'notEnabled'|'unknown'|'unknownFutureValue'|'reportOnlySuccess'|'reportOnlyFailure'|'reportOnlyNotApplied'|'reportOnlyInterrupted'} CAResult */

export const REPORT_ONLY_STATE = 'enabledForReportingButNotEnforced';

const IMPACT = /** @type {const} */ ({
  BLOCK: 'block',        // reportOnlyFailure — access would be denied
  CHALLENGE: 'challenge',// reportOnlyInterrupted — extra prompt (usually MFA)
  NONE: 'none',
});

// Severity buckets — the confidence that enforcement really hurts this sign-in.
export const SEVERITY = /** @type {const} */ ({
  DEFINITE: 'definite', // will be blocked outright
  SILENT: 'silent',     // high likelihood of silent / unfixable-at-the-moment breakage
  PROMPT: 'prompt',     // interactive friction the user can clear
});

const BLOCK_CONTROL = 'block';

// Grant controls that a user cannot satisfy by responding to a prompt in the
// moment — they need a device state or a specific app. An interruption gated on
// one of these is an effective block, not a "just do MFA" prompt.
const DEVICE_OR_APP_CONTROLS = new Set([
  'compliantdevice',
  'domainjoineddevice',
  'approvedapplication',
  'compliantapplication',
]);

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
    compliantdevice: 'Require compliant device',
    domainjoineddevice: 'Require Hybrid Azure AD joined device',
    approvedapplication: 'Require approved client app',
    compliantapplication: 'Require app protection policy',
    passwordchange: 'Require password change',
  };
  return controls.map((c) => map[String(c).toLowerCase()] || c).join(' AND ');
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
 * Decide the severity bucket for one finding.
 * @param {'block'|'challenge'} impact
 * @param {Set<string>} controlSet lower-cased grant controls
 * @param {boolean} nonInteractive signIn.isInteractive === false
 */
function classifySeverity(impact, controlSet, nonInteractive) {
  if (impact === IMPACT.BLOCK) return SEVERITY.DEFINITE;
  // impact === CHALLENGE (reportOnlyInterrupted)
  if (nonInteractive) return SEVERITY.SILENT; // background service — no human to answer
  for (const c of controlSet) if (DEVICE_OR_APP_CONTROLS.has(c)) return SEVERITY.SILENT; // can't fix at a prompt
  return SEVERITY.PROMPT;
}

/**
 * A plain-English fix for one finding. This is what the technician actually does
 * to let the sign-in through once the policy is enforced.
 * @param {{controlSet:Set<string>, severity:string, legacyAuth:boolean, clientApp:string, nonInteractive:boolean, device:string|null, authStrength:string|null, app:string}} f
 */
function suggestRemediation(f) {
  const { controlSet, legacyAuth, clientApp, nonInteractive, device, authStrength } = f;

  if (controlSet.has('block')) {
    if (legacyAuth) {
      return `Move this mailbox/app off legacy authentication (${clientApp}). Switch the client to modern OAuth (e.g. new Outlook / Graph) and retire basic-auth protocols (IMAP/POP/SMTP AUTH). If a service account genuinely needs it, exclude it from the policy.`;
    }
    return `This policy is meant to deny this sign-in. If it should be allowed, exclude this user/app or narrow the policy's conditions; otherwise no fix is needed — it's working as intended.`;
  }

  if (controlSet.has('compliantdevice')) {
    return `Enrol ${device ? `"${device}"` : 'the device'} in Intune and bring it to compliant (or Hybrid-join it), then re-sign-in. If it can't be managed, exclude the device/user or scope the policy off this app.`;
  }
  if (controlSet.has('domainjoineddevice')) {
    return `Hybrid Azure AD join ${device ? `"${device}"` : 'the device'} (or switch the control to "compliant device" via Intune). Unmanaged/personal devices can't satisfy this and will be blocked.`;
  }
  if (controlSet.has('approvedapplication') || controlSet.has('compliantapplication')) {
    return `Use an approved app with an app-protection policy (e.g. Outlook / Teams mobile) — the current client (${clientApp}) can't satisfy this. ${nonInteractive ? 'This is a background sign-in, so it will fail silently until the client is switched.' : ''}`.trim();
  }
  if (controlSet.has('mfa') || authStrength) {
    const method = authStrength
      ? `a method that meets the "${authStrength}" strength (e.g. Microsoft Authenticator push/passkey or FIDO2)`
      : `an MFA method (Microsoft Authenticator or a FIDO2 key)`;
    if (nonInteractive) {
      return `Register ${method} for this user and have them complete MFA once interactively. This is a BACKGROUND sign-in — it can't prompt, so the service (${f.app}) will silently stop until a fresh, MFA-satisfied token is issued. Also confirm the client supports modern auth so it can carry the claim.`;
    }
    return `Have the user register ${method} and complete MFA once. After that this prompt clears on its own.`;
  }
  return `Review this policy's grant controls against how ${f.app} signs in; exclude the user/app if the control can't be met.`;
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
    // Graph marks background token refreshes with isInteractive === false. Only an
    // explicit false counts as non-interactive; undefined stays "assume interactive".
    const nonInteractive = s.isInteractive === false;
    for (const ap of applied) {
      const impact0 = classifyResult(ap.result);
      if (impact0 === IMPACT.NONE) continue;

      // If we only care about policies still in report-only, filter here.
      const policy = policyById.get(ap.id);
      const isReportOnly = reportOnlyIds.has(ap.id) || ap.result?.startsWith('reportOnly');
      if (reportOnlyOnly && !isReportOnly) continue;

      const controls = ap.enforcedGrantControls || policy?.grantControls?.builtInControls || [];
      const controlSet = new Set(controls.map((c) => String(c).toLowerCase()));
      const hardBlock = controlSet.has(BLOCK_CONTROL);
      const impact = hardBlock ? IMPACT.BLOCK : impact0; // explicit Block control always = block
      const authStrength = policy?.grantControls?.authenticationStrength?.displayName || null;

      const legacyAuth = isLegacyAuth(s.clientAppUsed);
      const device = s.deviceDetail?.displayName || s.deviceDetail?.operatingSystem || null;
      const app = s.appDisplayName || s.resourceDisplayName || '(unknown app)';
      const clientApp = s.clientAppUsed || '(unknown)';

      const severity = classifySeverity(impact, controlSet, nonInteractive);
      const remediation = suggestRemediation({
        controlSet, severity, legacyAuth, clientApp, nonInteractive, device, authStrength, app,
      });

      findings.push({
        signInId: s.id,
        when: s.createdDateTime,
        userPrincipalName: s.userPrincipalName || s.userDisplayName || '(unknown user)',
        userId: s.userId || null,
        userDisplayName: s.userDisplayName || null,
        app,
        appId: s.appId || null,
        resource: s.resourceDisplayName || null,
        clientApp,
        legacyAuth,
        interactive: s.isInteractive === undefined ? null : s.isInteractive,
        nonInteractive,
        ip: s.ipAddress || null,
        location: [s.location?.city, s.location?.countryOrRegion].filter(Boolean).join(', ') || null,
        device,
        deviceId: s.deviceDetail?.deviceId || null,
        deviceCompliant: s.deviceDetail?.isCompliant ?? null,
        deviceManaged: s.deviceDetail?.isManaged ?? null,
        os: s.deviceDetail?.operatingSystem || null,
        browser: s.deviceDetail?.browser || null,
        policyId: ap.id,
        policyName: ap.displayName || policy?.displayName || ap.id,
        result: ap.result,
        impact, // block | challenge  (kept for existing aggregations)
        severity, // definite | silent | prompt
        controls,
        authStrength,
        reason: controls.length
          ? describeControls(controls)
          : authStrength
          ? `Require authentication strength: ${authStrength}`
          : 'Grant controls not recorded',
        remediation,
        signInErrorCode: s.status?.errorCode ?? null,
      });
    }
  }

  return {
    summary: buildSummary(policies || [], reportOnlyIds, findings, signIns || []),
    report: buildTechReport(policies || [], reportOnlyIds, findings),
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

const SEVERITY_RANK = { definite: 0, silent: 1, prompt: 2 };

/**
 * The technician-facing report: one entry per report-only policy that would bite,
 * each carrying short, plain-English lines ("If you enable X, Joan will be blocked
 * from Exchange — reason — fix"). Sorted worst-first.
 * @param {any[]} policies
 * @param {Set<string>} reportOnlyIds
 * @param {any[]} findings
 */
function buildTechReport(policies, reportOnlyIds, findings) {
  const byPolicy = new Map();
  for (const f of findings) {
    if (!byPolicy.has(f.policyId)) byPolicy.set(f.policyId, []);
    byPolicy.get(f.policyId).push(f);
  }

  const entries = [];
  for (const p of policies) {
    if (!reportOnlyIds.has(p.id)) continue;
    const fs = byPolicy.get(p.id) || [];
    if (fs.length === 0) continue; // clean policies belong in byPolicy's SAFE list, not the action report

    // Roll findings up to one row per user for THIS policy.
    const users = new Map();
    for (const f of fs) {
      if (!users.has(f.userPrincipalName)) {
        users.set(f.userPrincipalName, {
          user: f.userPrincipalName,
          userDisplayName: f.userDisplayName,
          severity: f.severity,
          apps: new Set(),
          clientApps: new Set(),
          devices: new Set(),
          interactiveCount: 0,
          backgroundCount: 0,
          count: 0,
          reason: f.reason,
          remediation: f.remediation,
        });
      }
      const u = users.get(f.userPrincipalName);
      u.count++;
      u.apps.add(f.app);
      u.clientApps.add(f.clientApp);
      if (f.device) u.devices.add(f.device);
      if (f.nonInteractive) u.backgroundCount++; else u.interactiveCount++;
      // keep the worst severity + its reason/fix as the headline for the user
      if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[u.severity]) {
        u.severity = f.severity;
        u.reason = f.reason;
        u.remediation = f.remediation;
      }
    }

    const userRows = [...users.values()]
      .map((u) => {
        const apps = [...u.apps];
        const line = techLine(u, apps, p.displayName);
        return {
          user: u.user,
          userDisplayName: u.userDisplayName,
          severity: u.severity,
          apps,
          clientApps: [...u.clientApps],
          devices: [...u.devices],
          signInCount: u.count,
          backgroundSignIns: u.backgroundCount,
          interactiveSignIns: u.interactiveCount,
          reason: u.reason,
          remediation: u.remediation,
          line,
        };
      })
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.signInCount - a.signInCount);

    const definite = userRows.filter((u) => u.severity === SEVERITY.DEFINITE).length;
    const silent = userRows.filter((u) => u.severity === SEVERITY.SILENT).length;
    const prompt = userRows.filter((u) => u.severity === SEVERITY.PROMPT).length;

    entries.push({
      policyId: p.id,
      policyName: p.displayName,
      grant: grantLabel(p),
      usersAffected: userRows.length,
      definiteBlockUsers: definite,
      silentBreakUsers: silent,
      promptUsers: prompt,
      worstSeverity: userRows[0]?.severity || null,
      headline: policyHeadline(p.displayName, definite, silent, prompt, userRows.length),
      users: userRows,
    });
  }

  return entries.sort(
    (a, b) =>
      SEVERITY_RANK[a.worstSeverity ?? 'prompt'] - SEVERITY_RANK[b.worstSeverity ?? 'prompt'] ||
      b.usersAffected - a.usersAffected
  );
}

/** One-line, technician-readable impact statement for a user under a policy. */
function techLine(u, apps, policyName) {
  const appList = apps.slice(0, 3).join(', ') + (apps.length > 3 ? ` +${apps.length - 3} more` : '');
  const who = u.userDisplayName || u.user;
  if (u.severity === SEVERITY.DEFINITE) {
    return `${who} will be BLOCKED from ${appList} when "${policyName}" is enabled — ${u.reason}. Fix: ${u.remediation}`;
  }
  if (u.severity === SEVERITY.SILENT) {
    const bg = u.backgroundCount > 0
      ? `background sign-ins (${appList}) will fail silently — the service stops with no prompt`
      : `${appList} will be interrupted with something the user can't satisfy in the moment`;
    return `${who}: ${bg} when "${policyName}" is enabled — ${u.reason}. Fix: ${u.remediation}`;
  }
  return `${who} will be prompted (${appList}) when "${policyName}" is enabled — ${u.reason}. Fix: ${u.remediation}`;
}

function policyHeadline(name, definite, silent, prompt, total) {
  const parts = [];
  if (definite) parts.push(`block ${definite} user${definite > 1 ? 's' : ''}`);
  if (silent) parts.push(`silently break ${silent} user${silent > 1 ? 's' : ''}`);
  if (prompt) parts.push(`prompt ${prompt} user${prompt > 1 ? 's' : ''}`);
  const effect = parts.length ? parts.join(', ') : 'have no measured impact';
  return `Enabling "${name}" would ${effect} (${total} user${total > 1 ? 's' : ''} affected in this window).`;
}

/** Short grant-control label for a policy. */
function grantLabel(p) {
  if ((p.grantControls?.builtInControls || []).length) return describeControls(p.grantControls.builtInControls);
  if (p.grantControls?.authenticationStrength?.displayName) return `Require authentication strength: ${p.grantControls.authenticationStrength.displayName}`;
  if (p.sessionControls) return 'Session controls';
  return 'Grant controls not recorded';
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
        definite: 0,
        silent: 0,
        prompt: 0,
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
    if (f.severity === SEVERITY.DEFINITE) g.definite++;
    else if (f.severity === SEVERITY.SILENT) g.silent++;
    else g.prompt++;
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
    .sort((a, b) => b.definite - a.definite || b.silent - a.silent || b.total - a.total);
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
      byId.set(f.policyId, { blocked: 0, challenged: 0, definite: 0, silent: 0, prompt: 0, users: new Set(), apps: new Set() });
    }
    const g = byId.get(f.policyId);
    if (f.impact === IMPACT.BLOCK) g.blocked++;
    else g.challenged++;
    if (f.severity === SEVERITY.DEFINITE) g.definite++;
    else if (f.severity === SEVERITY.SILENT) g.silent++;
    else g.prompt++;
    g.users.add(f.userPrincipalName);
    g.apps.add(f.app);
  }

  const rows = [];
  for (const p of policies) {
    if (!reportOnlyIds.has(p.id)) continue; // only report-only policies are "about to be enforced"
    const g = byId.get(p.id) || { blocked: 0, challenged: 0, definite: 0, silent: 0, prompt: 0, users: new Set(), apps: new Set() };
    const impactedUsers = g.users.size;
    rows.push({
      policyId: p.id,
      policyName: p.displayName,
      state: p.state,
      grant: grantLabel(p),
      blockedSignIns: g.blocked,
      challengedSignIns: g.challenged,
      definiteBlocks: g.definite,
      silentBreaks: g.silent,
      prompts: g.prompt,
      impactedUsers,
      impactedApps: g.apps.size,
      verdict:
        g.definite === 0 && g.silent === 0 && g.prompt === 0
          ? 'SAFE — no impact in this window; ready to enforce'
          : g.definite > 0
          ? `IMPACT — would block ${g.definite} sign-in(s) across ${impactedUsers} user(s)`
          : g.silent > 0
          ? `SILENT RISK — would silently break ${g.silent} background/unfixable sign-in(s) across ${impactedUsers} user(s)`
          : `FRICTION — would prompt ${g.prompt} interactive sign-in(s) across ${impactedUsers} user(s)`,
    });
  }
  return rows.sort(
    (a, b) => b.definiteBlocks - a.definiteBlocks || b.silentBreaks - a.silentBreaks || b.prompts - a.prompts
  );
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
  const definite = findings.filter((f) => f.severity === SEVERITY.DEFINITE);
  const silent = findings.filter((f) => f.severity === SEVERITY.SILENT);
  const prompt = findings.filter((f) => f.severity === SEVERITY.PROMPT);
  const blocked = findings.filter((f) => f.impact === IMPACT.BLOCK);
  const challenged = findings.filter((f) => f.impact === IMPACT.CHALLENGE);
  const blockedUsers = new Set(blocked.map((f) => f.userPrincipalName));
  const challengedUsers = new Set(challenged.map((f) => f.userPrincipalName));
  const silentUsers = new Set(silent.map((f) => f.userPrincipalName));
  const dates = signIns.map((s) => s.createdDateTime).filter(Boolean).sort();

  // HOLD if anything will definitely block or silently break; REVIEW if it's
  // only interactive prompts; READY if nothing bites.
  let verdict;
  if (definite.length > 0 || silent.length > 0) {
    const bits = [];
    if (definite.length) bits.push(`block ${definite.length} sign-in(s)`);
    if (silent.length) bits.push(`silently break ${silent.length} background/unfixable sign-in(s)`);
    verdict = `HOLD — enforcing now would ${bits.join(' and ')} across ${new Set([...blockedUsers, ...silentUsers]).size} user(s). Review the report before flipping to On.`;
  } else if (prompt.length > 0) {
    verdict = `REVIEW — no hard blocks, but ${prompt.length} interactive sign-in(s) across ${challengedUsers.size} user(s) would get an extra prompt (usually MFA). Safe to enforce once those users can complete it.`;
  } else {
    verdict = 'READY — no sign-in in this window would be blocked. Safe to enforce.';
  }

  return {
    windowStart: dates[0] || null,
    windowEnd: dates[dates.length - 1] || null,
    signInsAnalyzed: signIns.length,
    reportOnlyPolicies: reportOnlyIds.size,
    policiesTotal: policies.length,
    // Headline confidence buckets
    definiteBlocks: definite.length,
    silentBreaks: silent.length,
    prompts: prompt.length,
    usersDefinitelyBlocked: new Set(definite.map((f) => f.userPrincipalName)).size,
    usersSilentlyBroken: silentUsers.size,
    usersPrompted: new Set(prompt.map((f) => f.userPrincipalName)).size,
    // Back-compat aliases (block == definite here)
    wouldBeBlockedSignIns: blocked.length,
    wouldBeChallengedSignIns: challenged.length,
    usersBlocked: blockedUsers.size,
    usersChallenged: challengedUsers.size,
    usersChallengedOnly: [...challengedUsers].filter((u) => !blockedUsers.has(u)).length,
    legacyAuthBlockedSignIns: blocked.filter((f) => f.legacyAuth).length,
    verdict,
  };
}
