import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../analyze.mjs';
import { policies, signIns } from './fixtures.mjs';

test('summary counts hard blocks correctly (report-only only)', () => {
  const r = analyze(policies, signIns);
  // Hard blocks: si-1 (legacy), si-2 (no MFA), si-4 (non-compliant device) = 3
  assert.equal(r.summary.wouldBeBlockedSignIns, 3);
  // Challenge: si-5 interrupted = 1
  assert.equal(r.summary.wouldBeChallengedSignIns, 1);
  // Unique blocked users: joan, liam = 2
  assert.equal(r.summary.usersBlocked, 2);
});

test('already-enforced policy failures are ignored by default', () => {
  const r = analyze(policies, signIns);
  const touchesEnforced = r.findings.some((f) => f.policyId === 'pol-already-on');
  assert.equal(touchesEnforced, false);
});

test('opting in to enforced policies surfaces the enforced failure', () => {
  const r = analyze(policies, signIns, { reportOnlyPoliciesOnly: false });
  const touchesEnforced = r.findings.some((f) => f.policyId === 'pol-already-on');
  assert.equal(touchesEnforced, true);
});

test('reportOnlySuccess produces no finding', () => {
  const r = analyze(policies, signIns);
  const si3 = r.findings.filter((f) => f.signInId === 'si-3');
  assert.equal(si3.length, 0);
});

test('legacy auth block is flagged and attributed to the protocol', () => {
  const r = analyze(policies, signIns);
  assert.equal(r.legacyAuth.totalBlockedSignIns, 1);
  assert.ok(r.legacyAuth.protocols.includes('IMAP4'));
  assert.equal(r.legacyAuth.affectedUsers, 1);
});

test('per-policy verdicts: clean policy is SAFE, others show impact', () => {
  const r = analyze(policies, signIns);
  const clean = r.byPolicy.find((p) => p.policyId === 'pol-clean');
  assert.match(clean.verdict, /^SAFE/);
  const mfa = r.byPolicy.find((p) => p.policyId === 'pol-require-mfa');
  assert.ok(mfa.blockedSignIns >= 1);
  assert.match(mfa.verdict, /IMPACT/);
});

test('enforced policy is not listed in byPolicy (only report-only ones)', () => {
  const r = analyze(policies, signIns);
  assert.equal(r.byPolicy.some((p) => p.policyId === 'pol-already-on'), false);
});

test('byUser aggregates joan across two policies with 2 blocks', () => {
  const r = analyze(policies, signIns);
  const joan = r.byUser.find((u) => u.user === 'joan@client.ie');
  assert.equal(joan.blocked, 2); // legacy + compliant device
  assert.ok(joan.policies.length >= 2);
});

test('device view surfaces the non-compliant iPhone', () => {
  const r = analyze(policies, signIns);
  const iphone = r.byDevice.find((d) => d.device === 'Joan-iPhone');
  assert.ok(iphone && iphone.blocked === 1);
});

test('overall verdict is HOLD when blocks exist', () => {
  const r = analyze(policies, signIns);
  assert.match(r.summary.verdict, /^HOLD/);
});

test('empty input is safe and READY', () => {
  const r = analyze([], []);
  assert.equal(r.summary.wouldBeBlockedSignIns, 0);
  assert.match(r.summary.verdict, /^READY/);
});

// ---- Severity buckets + technician report (the rework) ----

// The shared fixtures: 3 definite blocks (si-1,2,4), 1 interactive MFA prompt (si-5).
test('shared fixtures classify into definite/silent/prompt', () => {
  const r = analyze(policies, signIns);
  assert.equal(r.summary.definiteBlocks, 3);
  assert.equal(r.summary.silentBreaks, 0);
  assert.equal(r.summary.prompts, 1); // si-5 interactive MFA interruption
});

const mfaPolicy = {
  id: 'pol-mfa',
  displayName: 'Require MFA for all users',
  state: 'enabledForReportingButNotEnforced',
  grantControls: { operator: 'OR', builtInControls: ['mfa'] },
};

// A non-interactive (background) sign-in that gets INTERRUPTED (MFA step-up) is a
// likely report-only FALSE POSITIVE — the refresh token already carries the claim.
test('non-interactive MFA interruption is VERIFY (likely false positive), not a block', () => {
  const si = [{
    id: 'bg-1',
    createdDateTime: '2026-07-22T02:00:00Z',
    userPrincipalName: 'adrian@dcae.ie',
    userDisplayName: 'Adrian',
    appDisplayName: 'OneDrive SyncEngine',
    clientAppUsed: 'Mobile Apps and Desktop clients',
    isInteractive: false, // background token refresh — rides an already-MFA'd token
    deviceDetail: { operatingSystem: 'Windows', displayName: 'ADRIAN-LT' },
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-mfa', displayName: 'Require MFA for all users', enforcedGrantControls: ['Mfa'], result: 'reportOnlyInterrupted' },
    ],
  }];
  const r = analyze([mfaPolicy], si);
  assert.equal(r.summary.verifyFlags, 1);
  assert.equal(r.summary.silentBreaks, 0);
  assert.equal(r.summary.definiteBlocks, 0);
  assert.equal(r.summary.prompts, 0);
  const f = r.findings[0];
  assert.equal(f.severity, 'verify');
  // NOT a HOLD — verify + prompt only means REVIEW
  assert.match(r.summary.verdict, /^REVIEW/);
  // remediation must explain it's likely a false positive
  assert.match(f.remediation, /false positive/i);
});

// A non-interactive sign-in that would FAIL (denied, e.g. blocked legacy auth) is a
// genuine SILENT break — the background service stops with no prompt to anyone.
test('non-interactive FAILURE is a SILENT break and forces HOLD', () => {
  const pol = [{
    id: 'pol-legacy',
    displayName: 'Block legacy authentication',
    state: 'enabledForReportingButNotEnforced',
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  }];
  const si = [{
    id: 'bg-2',
    createdDateTime: '2026-07-22T03:00:00Z',
    userPrincipalName: 'scanner@client.ie',
    userDisplayName: 'Warehouse Scanner',
    appDisplayName: 'Office 365 Exchange Online',
    clientAppUsed: 'SMTP',
    isInteractive: false,
    deviceDetail: { operatingSystem: 'Windows' },
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-legacy', displayName: 'Block legacy authentication', enforcedGrantControls: ['Block'], result: 'reportOnlyFailure' },
    ],
  }];
  const r = analyze(pol, si);
  assert.equal(r.summary.silentBreaks, 1);
  assert.equal(r.summary.verifyFlags, 0);
  assert.equal(r.findings[0].severity, 'silent');
  assert.match(r.summary.verdict, /^HOLD/);
  assert.match(r.findings[0].remediation, /legacy|silent|background/i);
});

test('technician report emits per-policy, per-user action lines', () => {
  const r = analyze(policies, signIns);
  assert.ok(Array.isArray(r.report) && r.report.length > 0);
  const mfa = r.report.find((e) => e.policyId === 'pol-require-mfa');
  assert.ok(mfa, 'expected the MFA policy in the report');
  // Liam is a definite block under require-mfa (si-2 reportOnlyFailure, interactive)
  const liam = mfa.users.find((u) => u.user === 'liam@client.ie');
  assert.equal(liam.severity, 'definite');
  assert.match(liam.line, /BLOCKED/);
  assert.match(liam.line, /Fix:/);
  assert.match(mfa.headline, /Enabling "Require MFA for all users"/);
});

test('an interactive MFA interruption yields a PROMPT and REVIEW', () => {
  const r = analyze([mfaPolicy], [{
    id: 'ix-1',
    createdDateTime: '2026-07-22T09:00:00Z',
    userPrincipalName: 'sara@client.ie',
    appDisplayName: 'SharePoint',
    clientAppUsed: 'Browser',
    isInteractive: true,
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-mfa', displayName: 'Require MFA for all users', enforcedGrantControls: ['Mfa'], result: 'reportOnlyInterrupted' },
    ],
  }]);
  assert.equal(r.summary.prompts, 1);
  assert.equal(r.summary.verifyFlags, 0);
  assert.equal(r.summary.silentBreaks, 0);
  assert.match(r.summary.verdict, /^REVIEW/);
});
