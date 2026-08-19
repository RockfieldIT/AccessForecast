# Moving the API off SWA managed functions → a standalone Function App

**Why.** Static Web Apps' built-in ("managed") functions have a hard **45-second**
request limit and **don't resolve Key Vault references**. Reading a week of sign-ins
for a 20-user tenant blows straight through 45s. The fix is to run the same API code
as a normal **Azure Function App** (10-minute timeout, Key Vault references work) and
**link** it to the Static Web App as its backend. The SWA keeps doing the UI and the
Rockfield staff sign-in; it just forwards `/api/*` to the Function App instead of to
its own managed runtime.

Nothing about the API code changes — it's already the Azure Functions v4 model. This
is infra + one workflow.

```
  Rockfield staff ─► Static Web App (UI + staff auth)
                        │  /api/*  (linked backend, behind the same auth)
                        ▼
                    Function App  ─► app-only Graph reads (no 45s cap)
                        │ reads AF_CLIENT_ID / AF_CLIENT_SECRET / PARTNER_TENANT_ID
```

You keep the **same** Static Web App, the **same** app registrations, and the **same**
staff sign-in. You add a Function App beside them and flip the API over to it.

---

## Step 1 — Create the Function App (Portal)

1. Portal → **Create a resource** → **Function App** → **Consumption** (cheapest; fine
   for SMB tenants) → **Create**.
2. Basics:
   - **Resource Group**: the same one as the SWA (`rf-accessforecast-rg`).
   - **Function App name**: `rf-accessforecast-func` (must match `FUNCTIONAPP_NAME` in
     the workflow — change one to match the other).
   - **Runtime stack**: **Node.js**. **Version**: **20 LTS**.
   - **Operating System**: **Linux**.
   - **Region**: same as the SWA.
3. **Review + create** → **Create**. Wait for it to finish.

> Consumption's max timeout is 10 minutes, which `host.json` now requests
> (`functionTimeout: 00:10:00`). That's ample for a 20-user tenant. If you later need
> longer or want no cold-starts, switch the plan to **Flex Consumption** or **Premium** —
> no code change.

## Step 2 — App settings on the Function App (Portal)

Function App → **Settings → Environment variables** → add (same values you already use
on the SWA):

| Name | Value |
|------|-------|
| `AF_CLIENT_ID` | the Graph app registration's Application (client) ID |
| `AF_CLIENT_SECRET` | the client secret **value** (or a Key Vault reference — these now work here) |
| `PARTNER_TENANT_ID` | your Rockfield tenant ID |

Optional tuning (only if you hit the 10-min ceiling on a very busy tenant):
`AF_MAXPAGES_NONINTERACTIVE`, `AF_MAXPAGES_INTERACTIVE`, `AF_MAXPAGES_SP` (each page =
up to 1000 sign-ins; defaults 60/60/15).

Save.

## Step 3 — Wire up deployment (GitHub, once)

The repo already contains `.github/workflows/functionapp.yml`, which deploys the `api/`
folder to the Function App on every push.

1. Function App → **Overview** → **Get publish profile** (downloads an XML file).
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - **Name**: `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`
   - **Value**: paste the **entire** contents of that XML file. Save.
3. If your Function App name isn't `rf-accessforecast-func`, edit `FUNCTIONAPP_NAME` at
   the top of `.github/workflows/functionapp.yml`.
4. GitHub → **Actions** → run **Deploy API to Function App** (or just push a change to
   `api/`). When it's green, the Function App is live.

Quick check: `https://rf-accessforecast-func.azurewebsites.net/api/getTenants` — it will
say unauthorized/forbidden directly (that's fine; it's meant to be reached through the
SWA), but a JSON error rather than a 404 confirms the functions deployed.

## Step 4 — Link the Function App to the Static Web App (Portal)

1. Static Web App → left menu **APIs** → **Link**.
2. **Backend resource type**: Function App → pick `rf-accessforecast-func` →
   **Link**.

Now `https://<your-swa-host>/api/*` is served by the Function App, behind the SWA's
existing staff auth. The 45-second limit is gone.

## Step 5 — Stop the SWA building its own managed API

So the two don't fight, tell the SWA build to stop packaging the managed API:

1. In the repo, open `.github/workflows/azure-static-web-apps-*.yml`.
2. Find `api_location: "api"` and change it to `api_location: ""`.
3. Commit. The next SWA build deploys only the UI; the API now comes solely from the
   linked Function App.

(The `web/staticwebapp.config.json` routes and auth stay exactly as they are — they
gate `/api/*` regardless of which backend serves it.)

## Step 6 — Verify

Browse to `https://<your-swa-host>`, open the **Client report** tab, pick a client, and
run a **whole-tenant, 7-day** report. It should complete instead of timing out.

---

## Rollback

If anything misbehaves, unlink the backend (SWA → APIs → Unlink) and set
`api_location: "api"` back in the SWA workflow — you're returned to the managed-functions
setup within one build. The Function App can sit idle at ~no cost.

## Cost

Consumption Function App: pennies for read-only bursts (first 1M executions free).
No change to the SWA (~€9/mo Standard) or Key Vault.
