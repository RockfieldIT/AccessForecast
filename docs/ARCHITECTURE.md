# Rockfield AccessForecast — Architecture & Build Plan

_Conditional Access enforcement preview. Reads live tenant data across your client
estate (CIPP-style: Secure Application Model + GDAP) and flags every user, device,
app and action that would be **blocked** the moment report-only policies are enforced._

---

## 1. The core idea

Entra ID already does the hard part. When a Conditional Access policy is in
**report-only** state (`enabledForReportingButNotEnforced`), Entra evaluates it
against every real sign-in and records what *would* have happened, per policy, in:

```
signIn.appliedConditionalAccessPolicies[]  →  { id, displayName, enforcedGrantControls[], result }
```

The `result` enum is the whole game:

| `result` | Meaning | AccessForecast treats it as |
|----------|---------|------------------------------|
| `reportOnlySuccess` | User satisfied the controls | No impact |
| `reportOnlyFailure` | User did **not** satisfy → would be denied | **BLOCK** |
| `reportOnlyInterrupted` | User would have been interrupted (e.g. MFA prompt) | **CHALLENGE** (friction) |
| `reportOnlyNotApplied` | Policy didn't target this sign-in | No impact |
| `failure` (enforced policy) | Already denied in production | BLOCK (only in opt-in mode) |

So the tool does **not** re-implement Entra's policy engine or guess. It reads the
verdicts Entra has already written, and aggregates them into the questions that
matter before you flip the switch: _who breaks, on what device, in which app, over
which protocol, and which policy is responsible._

This is deliberately different from Entra's built-in **What-If** tool, which is a
single hypothetical sign-in you construct by hand. AccessForecast is
evidence-based: it uses the real sign-in history of the report-only window.

## 2. Components

```
                        ┌──────────────────────────────────────────┐
   MSP admin (you) ───► │  Static Web App  (Rockfield-branded SPA)  │   web/index.html
   Entra ID sign-in     │  - lists client tenants                   │   + engine (analyze)
   (Entra External ID   │  - renders the forecast dashboard         │
    / your partner IdP) │  - upload mode for offline analysis       │
                        └───────────────┬──────────────────────────┘
                                        │ authenticated call (staff only)
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │  Functions API  (Node)                    │   api/
                        │  - getTenants        (GDAP customers)     │
                        │  - getReportOnlyImpact?tenantId=&days=    │
                        │      → SAM refresh token                  │
                        │      → per-tenant delegated Graph token   │
                        │      → GET policies + signIns (paged)     │
                        │      → returns { policies, signIns }      │
                        └───────────────┬──────────────────────────┘
                                        │ reads secret
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │  Key Vault: SAM app refresh token +       │
                        │  app secret (never in code or the SPA)    │
                        └──────────────────────────────────────────┘
```

The **engine** (`engine/analyze.mjs`) is intentionally hosting-independent and pure.
It runs in the browser today (upload mode) and can run inside the Function later,
so the analysis logic is written and tested **once**.

## 3. Identity & permissions (SAM + GDAP)

One multi-tenant **app registration** ("Rockfield-AccessForecast-SAM"), consented in
your partner tenant, holds a stored refresh token for a low-privilege service
identity that has **GDAP** roles into each customer tenant. Per request the Function
exchanges that refresh token for a **delegated** access token scoped to the selected
customer tenant, then calls Graph. This is the classic CIPP model — no per-tenant
interactive sign-in, works unattended across the estate.

Minimum delegated Graph scopes (read-only):

| Scope | Why |
|-------|-----|
| `Policy.Read.All` | Read Conditional Access policies + their state/grant controls |
| `AuditLog.Read.All` | Read sign-in logs incl. `appliedConditionalAccessPolicies` |
| `Directory.Read.All` | Resolve users, groups, apps referenced by policies |
| `CrossTenantInformation.ReadBasic.All` _(optional)_ | Tidy tenant display names |

GDAP directory roles that grant the above via delegation: **Security Reader** (read
CA policies) and **Reports Reader** (read sign-in logs). Both are read-only — the tool
never writes, and by design *cannot* change a policy's state.

> The full write-once boundary matters commercially: AccessForecast is read-only, so
> it can be pointed at any client without change-risk. Enforcing a policy stays a
> deliberate human action in the Entra portal / CIPP.

## 4. Graph calls the Function makes

Policies:
```
GET https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies
```

Report-only sign-ins for the window (server-side filtered, paged via `@odata.nextLink`):
```
GET https://graph.microsoft.com/v1.0/auditLogs/signIns
    ?$filter=createdDateTime ge {isoStart}
    &$top=1000
```
`conditionalAccessStatus` and per-policy `result` come back inline; no extra call
needed. For large tenants, prefer the filter
`appliedConditionalAccessPolicies/any(p:p/result eq 'reportOnlyFailure')` where the
tenant's sign-in volume makes a full pull heavy (note: this beta-friendly filter
should be validated per tenant; fall back to client-side filtering, which the engine
already does).

## 5. Build plan (phased)

**Phase 0 — Engine + dashboard (DONE, in this repo).**
Pure analysis engine with unit tests; Rockfield-branded single-file dashboard that
runs the engine on uploaded Graph JSON. Immediately usable: export the two JSON files
(see SETUP.md) and drop them in. This de-risks the whole product before any Azure spend.

**Phase 1 — Read-only live backend.**
Stand up the SAM app + GDAP, Key Vault, and the two Functions (`getTenants`,
`getReportOnlyImpact`). Wire the SPA "Live tenant" tab to them. Auth-gate the SPA to
Rockfield staff (Entra sign-in on the Static Web App).

**Phase 2 — Estate view & scheduling.**
"All clients" roll-up: one row per tenant with its readiness verdict, so you can see
which tenants are safe to enforce at a glance. Optional weekly snapshot to spot new
breakage as the report-only window rolls.

**Phase 3 — Reporting & handoff.**
Branded PDF/HTML export per tenant (mirrors the CIPP report generator already in the
stack), and a "what to fix first" remediation list (legacy-auth accounts, unmanaged
devices, service accounts) ranked by blast radius.

## 6. Hosting & cost

Azure Static Web App (Standard, or Free for pilot) + Azure Functions (Consumption) +
Key Vault. Realistically a few euro/month at MSP scale — the workload is bursty and
read-only. No database: the tool is stateless; each analysis is computed on demand
from live Graph data (Phase 2 snapshots would add a small table/blob store).

## 7. Security model

Nothing about client sign-ins is persisted by default. Secrets live only in Key Vault,
never in the SPA or source. The SPA is staff-gated. Upload mode is fully client-side —
useful for ad-hoc analysis of an export a client sends you, with nothing leaving the
browser. All access is read-only and delegated through GDAP, so it inherits your
existing customer authorisation and audit trail.

## 8. Why not pure browser-only (the itopia model)

itopia's tools never touch live data, which is why they can be single files. The
moment we wanted **live, no-manual-export** data across client tenants, a credential
boundary became unavoidable — hence the thin hosted backend. We keep the itopia
virtue where it's free: the dashboard and the entire analysis engine are still just
static assets, and upload mode preserves the "nothing leaves the browser" guarantee
for one-off use.
