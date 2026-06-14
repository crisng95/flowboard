<#
.SYNOPSIS
  Deploy Flowboard cloud production targets using local, gitignored credentials.

.DESCRIPTION
  Loads variables from `.env.deploy.local` at the repo root, then optionally:
    - deploys the Cloudflare Worker control plane
    - builds the frontend
    - deploys the frontend bundle to Cloudflare Pages

  This keeps deploy credentials separate from `agent/.env.staging`.
#>

[CmdletBinding()]
param(
    [switch]$Worker,
    [switch]$Frontend,
    [switch]$SkipBuild,
    [string]$Branch = 'feat/concepta-v1'   # production branch serving app.flowboard.bond
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Value {
    param(
        [string]$Name,
        [string]$Value
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Missing required value: $Name"
    }
}

function Load-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing deploy env file: $Path"
    }
    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) {
            continue
        }
        $key, $value = $line.Split('=', 2)
        $key = $key.Trim()
        $value = $value.Trim().Trim('"').Trim("'")
        if (-not $key) {
            continue
        }
        Set-Item -Path "Env:$key" -Value $value
    }
}

$repoRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) {
    throw 'Not inside a git repository.'
}
Set-Location $repoRoot

$envFile = Join-Path $repoRoot '.env.deploy.local'
Load-DotEnv -Path $envFile

Require-Value 'CLOUDFLARE_API_TOKEN' $env:CLOUDFLARE_API_TOKEN
Require-Value 'CLOUDFLARE_ACCOUNT_ID' $env:CLOUDFLARE_ACCOUNT_ID

if (-not $Worker -and -not $Frontend) {
    $Worker = $true
    $Frontend = $true
}

if ($Worker) {
    Write-Step 'Deploying Cloudflare Worker control plane'
    Push-Location (Join-Path $repoRoot 'cloudflare\control-plane-worker')
    try {
        & npx wrangler deploy
        if ($LASTEXITCODE -ne 0) {
            throw "wrangler deploy failed (exit $LASTEXITCODE)"
        }
    }
    finally {
        Pop-Location
    }
}

if ($Frontend) {
    Require-Value 'CLOUDFLARE_PAGES_PROJECT_NAME' $env:CLOUDFLARE_PAGES_PROJECT_NAME
    Require-Value 'VITE_CONTROL_PLANE_URL' $env:VITE_CONTROL_PLANE_URL
    Require-Value 'VITE_SUPABASE_URL' $env:VITE_SUPABASE_URL
    Require-Value 'VITE_SUPABASE_ANON_KEY' $env:VITE_SUPABASE_ANON_KEY

    Push-Location (Join-Path $repoRoot 'frontend')
    try {
        if (-not $SkipBuild) {
            Write-Step 'Building frontend'
            & npm run build
            if ($LASTEXITCODE -ne 0) {
                throw "npm run build failed (exit $LASTEXITCODE)"
            }
        }

        Write-Step 'Deploying frontend to Cloudflare Pages'
        & npx wrangler pages deploy dist --project-name $env:CLOUDFLARE_PAGES_PROJECT_NAME --branch $Branch
        if ($LASTEXITCODE -ne 0) {
            throw "wrangler pages deploy failed (exit $LASTEXITCODE)"
        }
    }
    finally {
        Pop-Location
    }
}