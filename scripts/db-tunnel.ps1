param(
  [Parameter(Mandatory = $true)]
  [string]$ServerHost,
  [string]$ServerUser = "root",
  [string]$LocalPort = "5433",
  [string]$RemoteHost = "127.0.0.1",
  [string]$RemotePort = "5432"
)

$ErrorActionPreference = "Stop"

$tunnelArgs = @(
  "-N",
  "-L", "${LocalPort}:${RemoteHost}:${RemotePort}",
  "${ServerUser}@${ServerHost}"
)

Write-Host "Starting SSH tunnel from localhost:$LocalPort to ${RemoteHost}:${RemotePort} via ${ServerUser}@${ServerHost}"
Write-Host "Keep this window open while Jongo OS runs locally."

ssh @tunnelArgs