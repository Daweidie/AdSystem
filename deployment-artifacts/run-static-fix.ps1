$ErrorActionPreference = 'Stop'

$artifactRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$fixScriptPath = Join-Path $artifactRoot 'fix-static-permissions.sh'
$logPath = Join-Path $artifactRoot 'static-fix-last-run.log'
$successPath = Join-Path $artifactRoot '.demo18_static_fix.ok'
$sshOptions = @(
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'PreferredAuthentications=password',
  '-o', 'PubkeyAuthentication=no'
)

Write-Host 'Enter the ubuntu password to upload the static permission fix.'
& scp.exe @sshOptions $fixScriptPath 'ubuntu@49.232.124.39:/tmp/'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Enter the ubuntu password to apply the fix, and again only if sudo asks.'
& ssh.exe -tt @sshOptions 'ubuntu@49.232.124.39' 'sudo bash /tmp/fix-static-permissions.sh' 2>&1 |
  Tee-Object -FilePath $logPath

if (-not (Select-String -LiteralPath $logPath -SimpleMatch 'STATIC_FIX_SUCCESS=true' -Quiet)) {
  Write-Host 'Static permission fix failed.' -ForegroundColor Red
  Start-Sleep -Seconds 5
  exit 1
}

Set-Content -LiteralPath $successPath -Value 'fixed' -Encoding ascii
Write-Host 'Static permissions fixed and verified.' -ForegroundColor Green
Start-Sleep -Seconds 5
exit 0
