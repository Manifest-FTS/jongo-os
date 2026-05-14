param(
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$SkipSeed
)

$ErrorActionPreference = "Stop"

Write-Host "[jongo-os] bootstrap started"

if (-not (Test-Path ".env")) {
  if (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Write-Host "[jongo-os] created .env from .env.example"
  } else {
    Write-Warning "[jongo-os] .env.example not found; skipping env bootstrap"
  }
}

if (-not $SkipInstall) {
  Write-Host "[jongo-os] installing dependencies"
  npm install
}

Write-Host "[jongo-os] applying database migrations"
npm run db:migrate:deploy

if (-not $SkipSeed) {
  Write-Host "[jongo-os] seeding database"
  npm run db:seed
}

if (-not $SkipBuild) {
  Write-Host "[jongo-os] building workspace"
  npm run build
}

Write-Host "[jongo-os] bootstrap complete"
