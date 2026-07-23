// Synthetic Graph data modelling four report-only CA policies and a week of
// sign-ins, shaped exactly like Microsoft Graph v1.0 output.

export const policies = [
  {
    id: 'pol-block-legacy',
    displayName: 'Block legacy authentication',
    state: 'enabledForReportingButNotEnforced',
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  },
  {
    id: 'pol-require-mfa',
    displayName: 'Require MFA for all users',
    state: 'enabledForReportingButNotEnforced',
    grantControls: { operator: 'OR', builtInControls: ['mfa'] },
  },
  {
    id: 'pol-compliant-device',
    displayName: 'Require compliant device for Exchange',
    state: 'enabledForReportingButNotEnforced',
    grantControls: { operator: 'OR', builtInControls: ['compliantDevice'] },
  },
  {
    id: 'pol-clean',
    displayName: 'Require MFA for admins',
    state: 'enabledForReportingButNotEnforced',
    grantControls: { operator: 'OR', builtInControls: ['mfa'] },
  },
  {
    id: 'pol-already-on',
    displayName: 'Block from outside Ireland (enforced)',
    state: 'enabled',
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  },
];

export const signIns = [
  // 1. Legacy auth (IMAP) hitting the block-legacy policy -> BLOCK
  {
    id: 'si-1',
    createdDateTime: '2026-07-20T08:00:00Z',
    userPrincipalName: 'joan@client.ie',
    userId: 'u-joan',
    userDisplayName: 'Joan Murphy',
    appDisplayName: 'Office 365 Exchange Online',
    appId: 'app-exo',
    clientAppUsed: 'IMAP4',
    ipAddress: '89.1.1.1',
    location: { city: 'Dublin', countryOrRegion: 'IE' },
    deviceDetail: { operatingSystem: 'Windows', browser: '', isCompliant: false, isManaged: false },
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-block-legacy', displayName: 'Block legacy authentication', enforcedGrantControls: ['Block'], result: 'reportOnlyFailure' },
      { id: 'pol-require-mfa', displayName: 'Require MFA for all users', enforcedGrantControls: ['Mfa'], result: 'reportOnlyNotApplied' },
    ],
  },
  // 2. Modern auth, user did NOT do MFA -> require-mfa BLOCK (failure)
  {
    id: 'si-2',
    createdDateTime: '2026-07-20T09:30:00Z',
    userPrincipalName: 'liam@client.ie',
    userId: 'u-liam',
    userDisplayName: 'Liam Byrne',
    appDisplayName: 'Microsoft Teams',
    appId: 'app-teams',
    clientAppUsed: 'Browser',
    ipAddress: '89.1.1.2',
    location: { city: 'Cork', countryOrRegion: 'IE' },
    deviceDetail: { operatingSystem: 'Windows', browser: 'Edge', isCompliant: false, isManaged: false },
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-require-mfa', displayName: 'Require MFA for all users', enforcedGrantControls: ['Mfa'], result: 'reportOnlyFailure' },
    ],
  },
  // 3. Same user did MFA later -> reportOnlySuccess -> NO impact
  {
    id: 'si-3',
    createdDateTime: '2026-07-21T09:00:00Z',
    userPrincipalName: 'liam@client.ie',
    userId: 'u-liam',
    userDisplayName: 'Liam Byrne',
    appDisplayName: 'Microsoft Teams',
    appId: 'app-teams',
    clientAppUsed: 'Browser',
    ipAddress: '89.1.1.2',
    location: { city: 'Cork', countryOrRegion: 'IE' },
    deviceDetail: { operatingSystem: 'Windows', browser: 'Edge', isCompliant: true, isManaged: true },
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-require-mfa', displayName: 'Require MFA for all users', enforcedGrantControls: ['Mfa'], result: 'reportOnlySuccess' },
    ],
  },
  // 4. Unmanaged device hitting compliant-device policy on Exchange -> BLOCK
  {
    id: 'si-4',
    createdDateTime: '2026-07-22T14:15:00Z',
    userPrincipalName: 'joan@client.ie',
    userId: 'u-joan',
    userDisplayName: 'Joan Murphy',
    appDisplayName: 'Office 365 Exchange Online',
    appId: 'app-exo',
    clientAppUsed: 'Mobile Apps and Desktop clients',
    ipAddress: '89.1.1.1',
    location: { city: 'Dublin', countryOrRegion: 'IE' },
    deviceDetail: { operatingSystem: 'iOS', browser: '', isCompliant: false, isManaged: false, displayName: 'Joan-iPhone' },
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-compliant-device', displayName: 'Require compliant device for Exchange', enforcedGrantControls: ['CompliantDevice'], result: 'reportOnlyFailure' },
    ],
  },
  // 5. Interrupted (MFA challenge) -> CHALLENGE, not a hard block
  {
    id: 'si-5',
    createdDateTime: '2026-07-22T16:00:00Z',
    userPrincipalName: 'aoife@client.ie',
    userId: 'u-aoife',
    userDisplayName: 'Aoife Kelly',
    appDisplayName: 'Salesforce',
    appId: 'app-sf',
    clientAppUsed: 'Browser',
    ipAddress: '89.1.1.3',
    location: { city: 'Galway', countryOrRegion: 'IE' },
    deviceDetail: { operatingSystem: 'MacOS', browser: 'Safari', isCompliant: false, isManaged: false },
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-require-mfa', displayName: 'Require MFA for all users', enforcedGrantControls: ['Mfa'], result: 'reportOnlyInterrupted' },
    ],
  },
  // 6. An enforced (already-On) policy failure — should be IGNORED by default (report-only-only mode)
  {
    id: 'si-6',
    createdDateTime: '2026-07-23T07:00:00Z',
    userPrincipalName: 'external@client.ie',
    userId: 'u-ext',
    userDisplayName: 'Contractor',
    appDisplayName: 'SharePoint',
    appId: 'app-spo',
    clientAppUsed: 'Browser',
    ipAddress: '5.5.5.5',
    location: { city: 'Paris', countryOrRegion: 'FR' },
    deviceDetail: { operatingSystem: 'Windows', browser: 'Chrome', isCompliant: false, isManaged: false },
    status: { errorCode: 53003 },
    appliedConditionalAccessPolicies: [
      { id: 'pol-already-on', displayName: 'Block from outside Ireland (enforced)', enforcedGrantControls: ['Block'], result: 'failure' },
    ],
  },
];
