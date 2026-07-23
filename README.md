# Rockfield AccessForecast

**Conditional Access enforcement preview.** Point it at a tenant whose CA policies are
in *report-only* mode and it flags every user, device, app and action that would be
**blocked** the moment you switch those policies to *On* — using the verdicts Entra has
already recorded against real sign-ins, not guesswork.

Built for Rockfield IT Services. Inspired by itopia's AccessTrace, but evidence-based
(real sign-in history) and live-data (CIPP-style SAM + GDAP) rather than file-upload only.

## What's here

```
accessforecast/
├── engine/                 # Pure, tested analysis engine (the crown jewel)
│   ├── analyze.mjs         #   analyze(policies, signIns) → forecast
│   └── test/               #   11 unit tests, synthetic Graph fixtures
├── web/
│   └── index.html          # Rockfield-branded single-file dashboard (works today, upload mode)
├── api/                    # Hosted backend (Azure Functions, Node) — app-only, unattended
│   ├── graph.mjs           #   per-tenant client_credentials token → Graph pull (all sign-in types)
│   ├── getReportOnlyImpact/#   GET ?tenantId=&days=  → analysed one tenant
│   ├── getEstate/          #   GET ?days=            → all clients, one readiness row each
│   └── getTenants/         #   GET                   → configured client list
├── infra/
│   └── main.bicep          # Static Web App + Functions + Key Vault
└── docs/
    ├── ARCHITECTURE.md     # Design + phased build plan + security model
    ├── SETUP.md            # Feed it: upload, or direct MSAL connect
    └── DEPLOYMENT.md       # Full unattended hosted rollout (app-only + CIPP consent + Azure)
```

## Use it now (no infrastructure)

Open `web/index.html`, go to **Upload Graph export**, and either **Load demo data** or
drop in two JSON files (`policies.json`, `signins.json`). SETUP.md has the two-line
Graph PowerShell to produce them. Nothing leaves the browser in this mode.

## Run the tests

```bash
node --test engine/test/analyze.test.mjs
```

## Status

- **Phase 0 (done):** engine + tests + branded dashboard + upload mode.
- **Phase 1 (next):** hosted SAM+GDAP backend for live, no-export analysis across clients.
- **Phase 2+:** all-clients estate roll-up, weekly snapshots, branded PDF export.

Read-only by design: AccessForecast never changes a policy. Enforcing stays a
deliberate human action in Entra / CIPP.
