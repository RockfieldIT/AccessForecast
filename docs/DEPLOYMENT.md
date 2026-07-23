# AccessForecast — Unattended Hosted Deployment (app-only, all clients)

This is the "no sign-in, all clients at once" build. A single multitenant app
registration is consented into every client tenant (via CIPP). A small Azure-hosted
backend then mints an **app-only** token per tenant and reads Conditional Access
policies + report-only sign-ins on a schedule or on demand — no interactive login,
ever. Read-only throughout; it can never change a policy.

```
  Rockfield staff ──► Static Web App (Rockfield UI, staff-gated)
                          │  calls /api (same origin)
                          ▼
                      Functions API  ──►  for each client tenant:
                        getEstate            client_credentials token
                        getReportOnlyImpact  → GET policies + signIns (all types)
                        getTenants           → analyze() → readiness verdict
                          │ reads secret
                          ▼
                      Key Vault (AF-CLIENT-SECRET)

  App registration (your tenant, multitenant, Application perms)
        └── consented into every client tenant via CIPP App Approval
```

Everything below is ordered. Do them in sequence.

---

## Prerequisites

- An Azure subscription in your partner tenant (for Static Web App + Key Vault).
- CIPP running (for one-click consent across clients) — or you'll use the admin-consent
  URL fallback in Step 2.
- Azure CLI (`az`) and the Static Web Apps CLI (`npm i -g @azure/static-web-apps-cli`).
- Node 18+ locally to deploy.
- Each client tenant on **Entra ID P1 or P2** (needed to read sign-in logs).

---

## Step 1 — Register the app (partner tenant, once)

1. Entra admin center → **App registrations** → **New registration**.
   - Name: `Rockfield AccessForecast`.
   - Supported account types: **Accounts in any organizational directory** (multitenant).
   - No redirect URI needed (this is app-only, not a browser sign-in).
2. **API permissions** → Add → Microsoft Graph → **Application permissions**:
   - `Policy.Read.All`
   - `AuditLog.Read.All`
   - `Directory.Read.All`
   Then **Grant admin consent** (this consents in *your* tenant; client tenants come in Step 2).
3. **Certificates & secrets** → **New client secret**. Copy the value now — you'll put it
   in Key Vault in Step 5. (Prefer a certificate for production — see Hardening.)
4. From **Overview**, copy the **Application (client) ID** and your **Directory (tenant) ID**.

> Why Application (not Delegated) permissions: app-only tokens carry the app's own
> permissions, so no user or GDAP sign-in is involved at read time. That's what makes it
> unattended.

## Step 2 — Consent the app into every client tenant

**Option A — CIPP (recommended).** Tenant Administration → Applications / Templates →
**App Approval**. Create a template referencing the **Application (client) ID** from Step 1
and the three application permissions above, then deploy it to **All Tenants** (and add it
as a Standard so new clients auto-consent). CIPP creates the service principal and grants
admin consent in each tenant. Deploy one app per template (a CIPP bug can drop permissions
when bundling multiple apps).

**Option B — admin-consent URL (per tenant, no CIPP).** For each client, open:
```
https://login.microsoftonline.com/<clientTenantId>/adminconsent?client_id=<appClientId>
```
Sign in as an admin for that client and accept. This creates the SP and grants the app perms.

Either way, the result is: the app can now get an app-only token in that tenant.

## Step 3 — Build the tenant list

The backend reads the clients to scan from an `AF_TENANTS` setting — a JSON array:
```json
[
  { "id": "11111111-1111-1111-1111-111111111111", "name": "Walls Mechanical" },
  { "id": "22222222-2222-2222-2222-222222222222", "name": "Terra Nutri Tech" }
]
```
Keep it minified on one line for the app setting (Step 6). You can export this straight from
CIPP's tenant list or Partner Center. (Future option: auto-discover via
`/tenantRelationships/delegatedAdminRelationships` — left out here to keep permissions minimal.)

## Step 4 — Provision Azure

From `infra/`:
```bash
az login
az group create -n rf-accessforecast-rg -l northeurope
az deployment group create -g rf-accessforecast-rg -f main.bicep \
    -p partnerTenantId=<your-tenant-id>
```
This creates the Key Vault and the Static Web App (Standard SKU — its managed Functions
API and staff auth come with it). Note the outputs: `staticWebAppHostname`, `keyVaultName`.

## Step 5 — Store the secret + grant access

```bash
# put the client secret from Step 1 into Key Vault
az keyvault secret set --vault-name <keyVaultName> --name AF-CLIENT-SECRET --value '<the-secret>'

# let the Static Web App's managed identity read secrets
SWA_ID=$(az staticwebapp identity assign -n rf-accessforecast-swa -g rf-accessforecast-rg --query principalId -o tsv)
az role assignment create --assignee $SWA_ID \
    --role "Key Vault Secrets User" \
    --scope $(az keyvault show -n <keyVaultName> --query id -o tsv)
```

## Step 6 — Configure app settings

```bash
az staticwebapp appsettings set -n rf-accessforecast-swa -g rf-accessforecast-rg --setting-names \
  AF_CLIENT_ID='<app-client-id>' \
  AF_TENANTS='[{"id":"...","name":"Client A"}]' \
  AF_CLIENT_SECRET='@Microsoft.KeyVault(SecretUri=https://<keyVaultName>.vault.azure.net/secrets/AF-CLIENT-SECRET/)'
```
(The bicep already wires `AF_CLIENT_SECRET` as a Key Vault reference; setting it here is the
CLI equivalent if you skipped the template value.)

## Step 7 — Deploy the code

The repo is already SWA-shaped: `web/` is the app, `api/` is the Functions backend.

```bash
# from the project root
swa deploy ./web --api-location ./api \
    --deployment-token $(az staticwebapp secrets list -n rf-accessforecast-swa -g rf-accessforecast-rg --query "properties.apiKey" -o tsv) \
    --env production
```
Or wire it to GitHub: `az staticwebapp` created a build workflow you can point at this repo
(`app_location: "web"`, `api_location: "api"`, `output_location: ""`). Every push deploys.

> The API is self-contained: it carries its own copy of the engine at `api/lib/analyze.mjs`
> (identical to `engine/analyze.mjs`, which remains the tested source of truth). So the `api/`
> folder deploys cleanly on its own — no cross-folder path to worry about.

**Prefer clicking to typing?** See **DEPLOYMENT-PORTAL.md** for steps 4–9 done entirely in the
Azure Portal + GitHub web UI, no command line.

## Step 8 — Lock it down (staff only)

`web/staticwebapp.config.json` already restricts `/*` and `/api/*` to the `staff` role and
sends anonymous users to Entra sign-in. Finish it:
1. In the SWA → **Role management**, invite your Rockfield staff accounts and assign them the
   `staff` role.
2. Confirm the Entra identity provider block in `staticwebapp.config.json` points at your
   `PARTNER_TENANT_ID` and app (a separate, simple auth app is fine here — it only gates the UI,
   it's not the Graph app).

## Step 9 — Verify

```bash
BASE=https://<staticWebAppHostname>

# list configured tenants
curl -s $BASE/api/getTenants | jq

# one tenant, 7-day window
curl -s "$BASE/api/getReportOnlyImpact?tenantId=<clientTenantId>&days=7" | jq '.forecast.summary'

# the whole estate at once
curl -s "$BASE/api/getEstate?days=7" | jq '.rows[] | {tenant, verdict, usersBlocked}'
```
`getEstate` returns one readiness row per client — READY / HOLD / ERROR — which is the
single-glance view of which tenants are safe to enforce.

---

## Operations

- **Add a client:** consent the app in the new tenant (Step 2 — automatic if you made the
  CIPP template a Standard), then add it to `AF_TENANTS` (Step 6). No redeploy of code needed.
- **Secret rotation:** create a new client secret, `az keyvault secret set` the new value; the
  Key Vault reference picks it up. Set a calendar reminder before expiry (or use a certificate).
- **Scheduling:** add a timer-triggered Function (or an Azure/GitHub scheduled job hitting
  `/api/getEstate`) to snapshot readiness weekly and alert when a previously-READY tenant flips
  to HOLD — that's new breakage entering the report-only window.
- **Cost:** Static Web App Standard (~€9/mo) + Key Vault (pennies) + Functions consumption
  (negligible for read-only bursts). No database.

## Hardening

- **Certificate instead of client secret:** register a cert on the app, upload the private key
  to Key Vault, and swap `getAppToken` to a `client_assertion` (JWT) grant. Removes the
  shared-secret rotation risk. (Small change isolated to `api/graph.mjs`.)
- **Least privilege:** you can drop `Directory.Read.All` if you accept GUIDs instead of resolved
  names in some edge cases; `Policy.Read.All` + `AuditLog.Read.All` are the mandatory two.
- **Network:** restrict the Functions API to the SWA, and optionally put the SWA behind an IP
  allow-list for your office/VPN.
- **Auditing:** every read is app-only under your app's identity and shows in each client's
  Entra audit log as your app — clean, attributable, and read-only.

## Where the delegated/GDAP option fits

If a client won't grant application consent, you can still reach it the delegated way: a
service account that's a member of your GDAP groups, using the classic refresh-token SAM flow.
That's a per-app change in `getAppToken` and a stored refresh token in Key Vault; the rest of
the pipeline (engine, endpoints, UI) is identical. App-only is preferred because there's no
token to keep alive and no service account to protect.
