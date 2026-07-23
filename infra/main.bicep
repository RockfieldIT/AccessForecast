// AccessForecast infrastructure — unattended app-only model.
// Static Web App (frontend + linked Functions API) + Key Vault for the secret.
//   az deployment group create -g <rg> -f main.bicep -p partnerTenantId=<guid>

@description('Your partner (MSP) tenant id — used for Key Vault + staff auth issuer')
param partnerTenantId string
@description('Azure region')
param location string = resourceGroup().location
param namePrefix string = 'rf-accessforecast'

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${namePrefix}-kv'
  location: location
  properties: {
    tenantId: partnerTenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    // Add secret out-of-band after deploy:
    //   az keyvault secret set --vault-name <kv> --name AF-CLIENT-SECRET --value <app secret>
  }
}

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${namePrefix}-swa'
  location: location
  sku: { name: 'Standard', tier: 'Standard' } // Standard = managed Functions API + auth
  properties: {}
}

// App settings for the linked Functions API. Secret is a Key Vault reference so it
// never appears in config or source. The SWA's managed identity needs Key Vault
// 'Key Vault Secrets User' RBAC on the vault (assign after deploy).
resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    AF_CLIENT_ID: '<app-registration-client-id>'
    AF_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=https://${namePrefix}-kv${environment().suffixes.keyvaultDns}/secrets/AF-CLIENT-SECRET/)'
    // JSON array of your client tenants, e.g. [{"id":"<guid>","name":"Client A"}]
    AF_TENANTS: '[]'
    PARTNER_TENANT_ID: partnerTenantId
  }
}

output staticWebAppName string = swa.name
output staticWebAppHostname string = swa.properties.defaultHostname
output keyVaultName string = kv.name
