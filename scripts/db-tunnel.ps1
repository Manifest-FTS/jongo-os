param(
  [Parameter(Mandatory = $true)]
  [string]$ServerHost,
  [string]$ServerUser = "root",
  [string]$LocalPort = "5433",
  [string]$RemoteHost = "127.0.0.1",
  [string]$RemotePort = "5432",
  [int]$ServerAliveInterval = 30,
  [int]$ServerAliveCountMax = 3,
  [switch]$Reconnect,
  [int]$ReconnectDelaySeconds = 5
)

$ErrorActionPreference = "Stop"

$tunnelArgs = @(
  "-N",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "TCPKeepAlive=yes",
  "-o", "ServerAliveInterval=${ServerAliveInterval}",
  "-o", "ServerAliveCountMax=${ServerAliveCountMax}",
  "-L", "${LocalPort}:${RemoteHost}:${RemotePort}",
  "${ServerUser}@${ServerHost}"
)

Write-Host "Starting SSH tunnel from localhost:$LocalPort to ${RemoteHost}:${RemotePort} via ${ServerUser}@${ServerHost}"
Write-Host "Keep this window open while Jongo OS runs locally."

if (-not $Reconnect) {
  ssh @tunnelArgs
  exit $LASTEXITCODE
}

Write-Host "Reconnect mode enabled. Tunnel will restart after disconnects."

while ($true) {
  ssh @tunnelArgs
  $exitCode = $LASTEXITCODE
  Write-Warning "Tunnel exited with code $exitCode. Reconnecting in ${ReconnectDelaySeconds}s..."
  Start-Sleep -Seconds $ReconnectDelaySeconds
}