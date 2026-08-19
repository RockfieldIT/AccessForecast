# AccessForecast — Steps 4–9 in the web interface (no command line)

Everything from "provision Azure" onwards, done by clicking. The only non-Azure part is
putting the code on GitHub, which the Azure Static Web App reads to build and deploy — that's
also done in a browser. Steps 1–3 (app registration, CIPP consent, tenant list) stay as in
DEPLOYMENT.md; this covers 4 onward.

You'll need: an Azure subscription (Owner/Contributor on a resource group) and a GitHub account.

---

## Step 4a — Put the code on GitHub (browser)

The Static Web App builds from a GitHub repo, so the project needs to live there.

1. Go to **github.com → New repository**. Name it `accessforecast`, keep it **Private**, click
   **Create repository**.
2. On the empty repo page, click **uploading an existing file**.
3. Unzip `AccessForecast-project.zip` on your PC, then drag the **contents of the
   `accessforecast` folder** (the `web`, `api`, `engine`, `infra`, `docs` folders and the files)
   into the upload area. GitHub preserves the folder structure.
4. Click **Commit changes**.

> Keep the folder layout intact — the Static Web App expects `web/` (the app) and `api/` (the
> backend) at the repo root.

## Step 4b — Create the Static Web App (Azure Portal)

1. Portal → **Create a resource** → search **Static Web App** → **Create**.
2. Basics:
   - **Subscription** and **Resource Group** → create a new group, e.g. `rf-accessforecast-rg`.
   - **Name**: `rf-accessforecast-swa`.
   - **Plan type**: **Standard** (required — it brings the managed Functions API, Key Vault
     references and staff auth; Free won't do these).
   - **Region**: pick your nearest (e.g. West Europe / North Europe).
   - **Deployment source**: **GitHub** → **Sign in with GitHub** and authorise.
   - **Organisation / Repository / Branch**: your account / `accessforecast` / `main`.
3. **Build Details** → **Build Presets: Custom**, then set:
   - **App location**: `/web`
   - **Api location**: `/api`
   - **Output location**: *(leave empty)*
4. **Review + create** → **Create**.

Azure commits a GitHub Actions workflow to your repo and runs it. Watch it under the repo's
**Actions** tab — first build takes a few minutes. When green, your site is live at the URL on
the SWA **Overview** page (`https://<something>.azurestaticapps.net`). Note that URL.

## Step 5 — Key Vault + the secret (Portal)

1. Portal → **Create a resource** → **Key Vault** → **Create**. Same resource group; name e.g.
   `rf-accessforecast-kv`; **Permission model: Azure role-based access control**. Create.
2. Open the vault → **Objects → Secrets → Generate/Import**.
   - **Name**: `AF-CLIENT-SECRET`
   - **Value**: paste the client secret from Step 1 (the app registration). Create.

## Step 5b — Let the app read the secret (Portal)

1. Open the **Static Web App** → **Settings → Identity** → **System assigned** → **Status: On**
   → **Save**. (This gives the app an identity Azure can grant rights to.)
2. Open the **Key Vault** → **Access control (IAM)** → **Add → Add role assignment**.
   - Role: **Key Vault Secrets User** → Next.
   - **Assign access to: Managed identity** → **Select members** → pick your
     `rf-accessforecast-swa`. → **Review + assign**.

## Step 6 — Application settings (Portal)

Static Web App → **Settings → Environment variables** (a.k.a. Configuration) → **+ Add** each of
these, then **Save**:

| Name | Value |
|------|-------|
| `AF_CLIENT_ID` | the Application (client) ID from Step 1 |
| `PARTNER_TENANT_ID` | your Rockfield (MSP) tenant ID — used to auto-discover your clients |
| `AF_CLIENT_SECRET` | `@Microsoft.KeyVault(SecretUri=https://rf-accessforecast-kv.vault.azure.net/secrets/AF-CLIENT-SECRET/)` |

That's it — **no client list to enter**. The app finds every client automatically from your
active GDAP relationships. (`AF_TENANTS` exists only as an optional override if you ever want to
limit the tool to a subset of tenants — leave it unset for "all my clients".)

After saving, the `AF_CLIENT_SECRET` row should show a green **Key Vault Reference** resolved
status within a minute (if it shows an error, re-check Step 5b).

## Step 7 — Deploy the code

Already done — Step 4b wired GitHub to the SWA, so every commit auto-builds and deploys. To
redeploy after a change, edit a file in the GitHub web UI and commit; the Action runs again.

## Step 8 — Lock it to Rockfield staff (Portal)

Two small parts: an identity provider, then who's allowed.

**8a — Register an auth app (Portal → App registrations):**
1. **New registration** → name `AccessForecast Sign-in` → **Single tenant** → Redirect URI:
   **Web** = `https://<your-swa-host>/.auth/login/aad/callback`. Register.
2. **Certificates & secrets → New client secret** → copy the value.
3. Back in the **Static Web App → Environment variables**, add:
   - `AAD_CLIENT_ID` = this auth app's Application (client) ID
   - `AAD_CLIENT_SECRET` = the secret you just copied
   Save. (The included `web/staticwebapp.config.json` already references these and your
   `PARTNER_TENANT_ID` as the issuer, and restricts `/*` and `/api/*` to the `staff` role.)

**8b — Invite your team (Portal → Static Web App → Role management):**
1. **Invite** → Authentication provider **Azure Active Directory**, enter a staff email, set
   **Roles**: `staff`, generate the link and send it. They open it once and accept.

Until a user has the `staff` role, the site and the `/api` endpoints return sign-in / 401 — so
client data is never exposed anonymously.

## Step 9 — Verify (browser)

1. Browse to `https://<your-swa-host>` — you should be prompted to sign in, then land on the app.
2. Test the API in the address bar (you're authenticated in the browser session):
   - `https://<your-swa-host>/api/getTenants` → your configured client list.
   - `https://<your-swa-host>/api/getReportOnlyImpact?tenantId=<clientTenantId>&days=7` → the
     analysed result for one tenant.
   - `https://<your-swa-host>/api/getEstate?days=7` → one readiness row per client.

If `getEstate` returns `ERROR` for a tenant, it's almost always that the app isn't consented
there yet (Step 2) or that tenant lacks Entra ID P1/P2 for sign-in logs.

---

## Adding a client later — nothing to do
Once you onboard a client through your normal CIPP/GDAP process and the app is consented there
(CIPP App Approval Standard does this automatically), it **appears in AccessForecast on its own** —
no environment variable to edit, no redeploy. That's the whole point of the auto-discovery.

## If you'd rather skip GitHub entirely
The only step that needs GitHub (or one CLI command) is deploying the `api/` + `web/` code. If you
don't want a repo, the alternative is a single `swa deploy` command with a deployment token — say
the word and I'll give you that one-liner instead. Everything else above stays portal-only.
