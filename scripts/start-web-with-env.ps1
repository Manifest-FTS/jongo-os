param(
  [string]$Port = "3000",
  [string]$EnvFile = ".env",
  [switch]$Dev
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
  if (-not (Test-Path $EnvFile) -and (Test-Path ".env.local")) {
    $EnvFile = ".env.local"
  }

  if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
      $line = $_.Trim()
      if (-not $line -or $line.StartsWith("#")) {
        return
      }

      $separatorIndex = $line.IndexOf("=")
      if ($separatorIndex -lt 1) {
        return
      }

      $key = $line.Substring(0, $separatorIndex).Trim()
      $value = $line.Substring($separatorIndex + 1).Trim()

      if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
        $value = $value.Substring(1, $value.Length - 2)
      }

      Set-Item -Path ("Env:" + $key) -Value $value
    }
  }

  $env:PORT = $Port

  if ($Dev) {
    npm run dev --workspace @jongo-os/web
  } else {
    npm run start --workspace @jongo-os/web
  }
} finally {
  Pop-Location
}
