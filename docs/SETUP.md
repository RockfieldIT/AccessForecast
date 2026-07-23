# AccessForecast — Setup

Two ways to feed the tool. **Upload mode** works today with zero infrastructure.
**Live mode** is the hosted build (Phase 1).

---

## A. Upload mode (available now)

You need two JSON files from the target tenant. Any of these three routes produces them.

### Route 1 — Microsoft Graph PowerShell (quickest for one tenant)

```powershell
Connect-MgGraph -Scopes 'Policy.Read.All','AuditLog.Read.All' -TenantId <client-tenant-id>

# 1. Conditional Access policies
Get-MgIdentityConditionalAccessPolicy -All |
  ConvertTo-Json -Depth 10 | Out-File .\policies.json

# 2. Sign-in logs for the report-only window (last 7 days shown)
$since = (Get-Date).AddDays(-7).ToString('yyyy-MM-ddTHH:mm:ssZ')
Get-MgAuditLogSignIn -All -Filter "createdDateTime ge $since" |
  ConvertTo-Json -Depth 10 | Out-File .\signins.json
```

Drop `policies.json` and `signins.json` into the two boxes on the **Upload Graph
export** tab. (Entra keeps sign-in logs for 7 days on Entra ID P1 / 30 days on P2 —
pull as wide a window as your licensing allows; more history = more confidence.)

### Route 2 — Graph Explorer / raw REST

```
GET https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies
GET https://graph.microsoft.com/v1.0/auditLogs/signIns?$filter=createdDateTime ge 2026-07-16T00:00:00Z&$top=1000
```
Save each response. The tool accepts either a bare array **or** a full Graph response
with a `value` array — no reshaping needed. Page via `@odata.nextLink` for busy tenants
and concatenate the `value` arrays.

### Route 3 — CIPP

CIPP can surface both CA policies and sign-in data per tenant; export to JSON and use
the same two boxes. (Field names match Graph, which is what the engine expects.)

### Try it with no tenant
Click **Load demo data** on the Upload tab to see a fully-worked example
(legacy-auth block, an MFA gap, a non-compliant device, and one clean policy).

---

## B. Live mode — direct connect (built into the page)

The dashboard now signs in to Microsoft (MSAL) and reads Graph itself — no export,
no backend. It pulls **all three sign-in types** (interactive, non-interactive,
service-principal), so the legacy-auth and service-account paths are covered.

### 1. Register the app (once)
- Entra admin center → **App registrations** → **New registration**, name it
  **Rockfield AccessForecast**.
- Supported account types: **Accounts in any organizational directory** (multi-tenant,
  so it reaches your GDAP clients).
- **Add a platform → Single-page application (SPA)**, and set the redirect URI to the
  exact URL where you host `index.html` (e.g. `https://tools.rockfieldit.com/accessforecast/`
  or `http://localhost:8080/` for local testing). The page shows its own URI in the
  setup panel to copy.
- API permissions → Microsoft Graph → **Delegated**: `Policy.Read.All`,
  `AuditLog.Read.All`, `Directory.Read.All` → **Grant admin consent**.
- Copy the **Application (client) ID**.

### 2. Host the page
Browser OAuth cannot run from a `file://` path. Serve `index.html` over https (any
static host — your site, Azure Static Web Apps, Cloudflare Pages) or `http://localhost`
for testing. It's a single file with no build step.

### 3. GDAP / consent
Each client tenant either admin-consents the app once, or you reach it through your
**GDAP** roles (**Security Reader** + **Reports Reader**, or **Global Reader**). Sign-in
logs need **Entra ID P1/P2** in that tenant. All access is read-only.

### 4. Use
Open the page → **Connect to tenant** tab → paste the Client ID, enter the client
tenant (domain or GUID), pick a window → **Connect & analyse**. Sign in with your
partner account; the dashboard renders from live data. Nothing leaves your browser.

> Prefer fully unattended, all-clients-at-once analysis (no per-tenant sign-in)? That's
> the hosted SAM backend in `api/` + `infra/` — the direct-connect page and that backend
> share the exact same analysis engine, so it's a lift-and-shift, not a rewrite.

---

## Reading the output

- **Verdict banner** — READY (nothing blocked in the window) or HOLD (with counts).
- **Policies about to be enforced** — per report-only policy: how many sign-ins/users
  it would block, and a **Safe to enforce** flag for the clean ones. Enforce those first.
- **Legacy authentication exposure** — the silent killer. Legacy-auth blocks give the
  user a password failure, not a prompt; check each account for old Outlook profiles,
  scanners, scripts, IMAP/POP before enforcing.
- **Users / Apps / Devices** — the blast radius, so you can warn people or fix devices
  (enrol/comply) ahead of the switch.
- **Every impacted sign-in** — the evidence, filterable, with **Export CSV** for a
  client change record.

A policy showing **Safe to enforce** only means _no impact in the analysed window_.
Widen the window (longer log retention) for monthly/rare workflows before trusting it.
