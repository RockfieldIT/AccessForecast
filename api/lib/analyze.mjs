// @ts-check
/**
 * Rockfield AccessForecast — Report-Only Conditional Access what-if engine.
 *
 * Pure, hosting-independent. Give it the two things Microsoft Graph returns:
 *   1. Conditional Access policies  (GET /identity/conditionalAccess/policies)
 *   2. Sign-in logs for a window    (GET /auditLogs/signIns, all event types)
 *
 * GOAL: identify every sign-in — interactive OR non-interactive — that would
 * DEFINITELY be blocked, or has a HIGH LIKELIHOOD of being blocked, the moment a
 * report-only Conditional Access policy is switched to "On". Then say it in one
 * line a technician can act on, with the fix.
 *
 * How it knows: while a policy is report-only
 * (`enabledForReportingButNotEnforced`), Entra still evaluates it against every
 * real sign-in and records the outcome in
 * signIn.appliedConditionalAccessPolicies[].result:
 *   - reportOnlySuccess     -> user satisfied the controls; no impact (dropped)
 *   - reportOnlyFailure     -> a control could NOT be satisfied -> WOULD BE DENIED
 *   - reportOnlyInterrupted -> a control would need an interactive gesture (step-up MFA)
 *   - reportOnlyNotApplied  -> policy didn't target this sign-in (dropped)
 *
 * The crucial second axis is signIn.isInteractive, because the SAME result means
 * very different things on an interactive vs a background sign-in:
 *
 *   result=Failure     + interactive  -> DEFINITE. User is denied and sees it.
 *   result=Failure     + NON-interactive -> SILENT. A background service (OneDrive
 *                          sync, Outlook, Teams token refresh) is denied with no
 *                          prompt to anyone. High-confidence, genuinely dangerous.
 *   result=Interrupted + interactive  -> PROMPT. Real friction the user can clear
 *                          in the moment (typically step-up MFA).
 *   result=Interrupted + NON-interactive -> VERIFY (likely FALSE POSITIVE). Report-
 *                          only evaluates the background sign-in as if it were fresh
 *                          and flags "would need MFA", but a background token refresh
 *                          rides the primary refresh token that ALREADY satisfied MFA
 *                          at the last interactive sign-in, so it keeps working once
 *                          enforced. Only a user who has never met the strength is
 *                          genuinely at risk — hence "verify", not "block".
 *
 * An explicit Block grant control is a denial regardless of the recorded result,
 * so it is folded into the Failure row (definite / silent by interactivity).
 */

/** @typedef {'success'|'failure'|'notApplied'|'notEnabled'|'unknown'|'unknownFutureValue'|'reportOnlySuccess'|'reportOnlyFailure'|'reportOnlyNotApplied'|'reportOnlyInterrupted'} CAResult */

export const REPORT_ONLY_STATE = 'enabledForReportingButNotEnforced';

const IMPACT = /** @type {const} */ ({
  BLOCK: 'block',        // reportOnlyFailure (or explicit Block control) — access denied
  CHALLENGE: 'challenge',// reportOnlyInterrupted — would need an interactive gesture
  NONE: 'none',
});

// Severity buckets — confidence that enforcement really hurts this sign-in.
export const SEVERITY = /** @type {const} */ ({
  DEFINITE: 'definite', // interactive denial — user blocked, visible
  SILENT: 'silent',     // non-interactive denial — background service blocked, invisible
  PROMPT: 'prompt',     // interactive interruption — friction the user clears
  VERIFY: 'verify',     // non-interactive interruption — likely report-only false positive
});

// Worst-first ordering for sorting and headline choice.
const SEVERITY_RANK = { definite: 0, silent: 1, prompt: 2, verify: 3 };

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
 * Severity from the two axes that actually determine real-world impact:
 * the outcome (denied vs interrupted) and whether a human was present.
 * @param {'block'|'challenge'} impact
 * @param {boolean} nonInteractive signIn.isInteractive === false
 */
function classifySeverity(impact, nonInteractive) {
  if (impact === IMPACT.BLOCK) return nonInteractive ? SEVERITY.SILENT : SEVERITY.DEFINITE;
  // impact === CHALLENGE (reportOnlyInterrupted)
  return nonInteractive ? SEVERITY.VERIFY : SEVERITY.PROMPT;
}

/**
 * A plain-English fix for one finding — what the technician actually does to let
 * the sign-in through once the policy is enforced. Severity-aware: for the VERIFY
 * bucket it explains why it's probably a false positive rather than prescribing work.
 * @param {{controlSet:Set<string>, severity:string, legacyAuth:boolean, clientApp:string, nonInteractive:boolean, device:string|null, authStrength:string|null, app:string}} f
 */
function suggestRemediation(f) {
  const cs = f.controlSet;
  const mfaLike = (cs.has('mfa') || f.authStrength) &&
    !cs.has('block') && !cs.has('compliantdevice') && !cs.has('domainjoineddevice') &&
    !cs.has('approvedapplication') && !cs.has('compliantapplication');

  // MFA / authentication-strength only.
  if (mfaLike) {
    const method = f.authStrength
      ? `a method that meets the "${f.authStrength}" strength (e.g. Microsoft Authenticator push/passkey or FIDO2)`
      : `an MFA method (Microsoft Authenticator or a FIDO2 key)`;
    if (f.severity === SEVERITY.VERIFY) {
      return `Likely a report-only false positive — no action needed in most cases. This is a background (non-interactive) sign-in, and its refresh token almost always already carries the MFA claim from the user's last interactive sign-in, so enforcing won't stop it. To be sure, confirm the user can satisfy ${method} interactively; only a user who has never met this strength is genuinely at risk.`;
    }
    return `Have the user register ${method} and complete MFA once interactively. After that the prompt clears on its own for the browser and modern-auth clients.`;
  }

  const silentNote = f.nonInteractive
    ? ' This is a background sign-in, so it fails with no prompt — the service just stops until this is fixed.'
    : '';

  if (cs.has('block')) {
    if (f.legacyAuth) {
      return `Move this mailbox/app off legacy authentication (${f.clientApp}). Switch the client to modern OAuth (e.g. new Outlook / Graph) and retire basic-auth protocols (IMAP/POP/SMTP AUTH). If a service account genuinely needs it, exclude it from the policy.${silentNote}`;
    }
    return `This policy is meant to deny this sign-in. If it should be allowed, exclude this user/app or narrow the policy's conditions; otherwise no fix is needed — it's working as intended.${silentNote}`;
  }
  if (cs.has('compliantdevice')) {
    return `Enrol ${f.device ? `"${f.device}"` : 'the device'} in Intune and bring it to compliant (or Hybrid-join it), then re-sign-in. If it can't be managed, exclude the device/user or scope the policy off this app.${silentNote}`;
  }
  if (cs.has('domainjoineddevice')) {
    return `Hybrid Azure AD join ${f.device ? `"${f.device}"` : 'the device'} (or switch the control to "compliant device" via Intune). Unmanaged/personal devices can't satisfy this and will be blocked.${silentNote}`;
  }
  if (cs.has('approvedapplication') || cs.has('compliantapplication')) {
    return `Use an approved app with an app-protection policy (e.g. Outlook / Teams mobile) — the current client (${f.clientApp}) can't satisfy this.${silentNote}`;
  }
  return `Review this policy's grant controls against how ${f.app} signs in; exclude the user/app if the control can't be met.${silentNote}`;
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

      const policy = policyById.get(ap.id);
      const isReportOnly = reportOnlyIds.has(ap.id) || ap.result?.startsWith('reportOnly');
      if (reportOnlyOnly && !isReportOnly) continue;

      const controls = ap.enforcedGrantControls || policy?.grantControls?.builtInControls || [];
      const controlSet = new Set(controls.map((c) => String(c).toLowerCase()));
      const hardBlock = controlSet.has(BLOCK_CONTROL);
      const impact = hardBlock ? IMPACT.BLOCK : impact0; // explicit Block control always = denial
      const authStrength = policy?.grantControls?.authenticationStrength?.displayName || null;

      const legacyAuth = isLegacyAuth(s.clientAppUsed);
      const device = s.deviceDetail?.displayName || s.deviceDetail?.operatingSystem || null;
      const app = s.appDisplayName || s.resourceDisplayName || '(unknown app)';
      const clientApp = s.clientAppUsed || '(unknown)';

      const severity = classifySeverity(impact, nonInteractive);
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
        severity, // definite | silent | prompt | verify
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

/**
 * The technician-facing report: one entry per report-only policy that would bite,
 * each carrying short, plain-English lines with reason + fix. Sorted worst-first.
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
    if (fs.length === 0) continue; // clean policies live in byPolicy's SAFE list, not the action report

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
          line: techLine(u, apps, p.displayName),
        };
      })
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.signInCount - a.signInCount);

    const definite = userRows.filter((u) => u.severity === SEVERITY.DEFINITE).length;
    const silent = userRows.filter((u) => u.severity === SEVERITY.SILENT).length;
    const prompt = userRows.filter((u) => u.severity === SEVERITY.PROMPT).length;
    const verify = userRows.filter((u) => u.severity === SEVERITY.VERIFY).length;

    entries.push({
      policyId: p.id,
      policyName: p.displayName,
      grant: grantLabel(p),
      usersAffected: userRows.length,
      definiteBlockUsers: definite,
      silentBreakUsers: silent,
      promptUsers: prompt,
      verifyUsers: verify,
      worstSeverity: userRows[0]?.severity || null,
      headline: policyHeadline(p.displayName, definite, silent, prompt, verify, userRows.length),
      users: userRows,
    });
  }

  return entries.sort(
    (a, b) =>
      SEVERITY_RANK[a.worstSeverity ?? 'verify'] - SEVERITY_RANK[b.worstSeverity ?? 'verify'] ||
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
    return `${who}: background sign-ins (${appList}) will FAIL SILENTLY — the service stops with no prompt — when "${policyName}" is enabled — ${u.reason}. Fix: ${u.remediation}`;
  }
  if (u.severity === SEVERITY.VERIFY) {
    return `${who}: ${u.backgroundCount} background sign-in(s) (${appList}) are flagged under "${policyName}", but these are most likely report-only false positives (the token already carries the claim) — spot-check, don't act. ${u.remediation}`;
  }
  return `${who} will be prompted (${appList}) when "${policyName}" is enabled — ${u.reason}. Fix: ${u.remediation}`;
}

function policyHeadline(name, definite, silent, prompt, verify, total) {
  const parts = [];
  if (definite) parts.push(`block ${definite} user${definite > 1 ? 's' : ''}`);
  if (silent) parts.push(`silently break ${silent} user${silent > 1 ? 's' : ''}`);
  if (prompt) parts.push(`prompt ${prompt} user${prompt > 1 ? 's' : ''}`);
  if (verify) parts.push(`flag ${verify} user${verify > 1 ? 's' : ''} to verify`);
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
        verify: 0,
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
    else if (f.severity === SEVERITY.VERIFY) g.verify++;
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
      byId.set(f.policyId, { blocked: 0, challenged: 0, definite: 0, silent: 0, prompt: 0, verify: 0, users: new Set(), apps: new Set() });
    }
    const g = byId.get(f.policyId);
    if (f.impact === IMPACT.BLOCK) g.blocked++;
    else g.challenged++;
    if (f.severity === SEVERITY.DEFINITE) g.definite++;
    else if (f.severity === SEVERITY.SILENT) g.silent++;
    else if (f.severity === SEVERITY.VERIFY) g.verify++;
    else g.prompt++;
    g.users.add(f.userPrincipalName);
    g.apps.add(f.app);
  }

  const rows = [];
  for (const p of policies) {
    if (!reportOnlyIds.has(p.id)) continue; // only report-only policies are "about to be enforced"
    const g = byId.get(p.id) || { blocked: 0, challenged: 0, definite: 0, silent: 0, prompt: 0, verify: 0, users: new Set(), apps: new Set() };
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
      verifyFlags: g.verify,
      impactedUsers,
      impactedApps: g.apps.size,
      verdict:
        g.definite === 0 && g.silent === 0 && g.prompt === 0 && g.verify === 0
          ? 'SAFE — no impact in this window; ready to enforce'
          : g.definite > 0
          ? `IMPACT — would block ${g.definite} interactive sign-in(s) across ${impactedUsers} user(s)`
          : g.silent > 0
          ? `SILENT RISK — would silently break ${g.silent} background sign-in(s) across ${impactedUsers} user(s)`
          : g.prompt > 0
          ? `FRICTION — would prompt ${g.prompt} interactive sign-in(s) across ${impactedUsers} user(s)`
          : `VERIFY — ${g.verify} background sign-in(s) flagged; likely report-only false positives, spot-check ${impactedUsers} user(s)`,
    });
  }
  return rows.sort(
    (a, b) =>
      b.definiteBlocks - a.definiteBlocks || b.silentBreaks - a.silentBreaks || b.prompts - a.prompts || b.verifyFlags - a.verifyFlags
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
  const verify = findings.filter((f) => f.severity === SEVERITY.VERIFY);
  const blocked = findings.filter((f) => f.impact === IMPACT.BLOCK);
  const challenged = findings.filter((f) => f.impact === IMPACT.CHALLENGE);
  const blockedUsers = new Set(blocked.map((f) => f.userPrincipalName));
  const challengedUsers = new Set(challenged.map((f) => f.userPrincipalName));
  const definiteUsers = new Set(definite.map((f) => f.userPrincipalName));
  const silentUsers = new Set(silent.map((f) => f.userPrincipalName));
  const promptUsers = new Set(prompt.map((f) => f.userPrincipalName));
  const verifyUsers = new Set(verify.map((f) => f.userPrincipalName));
  const dates = signIns.map((s) => s.createdDateTime).filter(Boolean).sort();

  // HOLD if anything will definitely block or silently break; REVIEW if there are
  // only prompts and/or verify-flags; READY if nothing bites.
  let verdictCode, verdictText;
  if (definite.length > 0 || silent.length > 0) {
    const bits = [];
    if (definite.length) bits.push(`block ${definite.length} interactive sign-in(s)`);
    if (silent.length) bits.push(`silently break ${silent.length} background sign-in(s)`);
    verdictCode = 'HOLD';
    verdictText = `Enforcing now would ${bits.join(' and ')} across ${new Set([...definiteUsers, ...silentUsers]).size} user(s). Review before flipping to On.`;
  } else if (prompt.length > 0 || verify.length > 0) {
    const bits = [];
    if (prompt.length) bits.push(`${prompt.length} interactive prompt(s) across ${promptUsers.size} user(s)`);
    if (verify.length) bits.push(`${verify.length} background sign-in(s) to spot-check across ${verifyUsers.size} user(s) (likely report-only false positives)`);
    verdictCode = 'REVIEW';
    verdictText = `No hard blocks. ${bits.join('; ')}. Safe to enforce once verified.`;
  } else {
    verdictCode = 'READY';
    verdictText = 'No sign-in in this window would be blocked. Safe to enforce.';
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
    verifyFlags: verify.length,
    usersDefinitelyBlocked: definiteUsers.size,
    usersSilentlyBroken: silentUsers.size,
    usersPrompted: promptUsers.size,
    usersToVerify: verifyUsers.size,
    // Back-compat aliases
    wouldBeBlockedSignIns: blocked.length,
    wouldBeChallengedSignIns: challenged.length,
    usersBlocked: blockedUsers.size,
    usersChallenged: challengedUsers.size,
    usersChallengedOnly: [...challengedUsers].filter((u) => !blockedUsers.has(u)).length,
    legacyAuthBlockedSignIns: blocked.filter((f) => f.legacyAuth).length,
    // Full sentence + code (string verdict kept for back-compat: starts with HOLD/REVIEW/READY)
    verdictCode,
    verdictText,
    verdict: `${verdictCode} — ${verdictText}`,
  };
}
