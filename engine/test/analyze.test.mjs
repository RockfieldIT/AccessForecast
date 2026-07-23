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
