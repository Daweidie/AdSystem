$ErrorActionPreference = 'Stop'

$artifactRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$successPath = Join-Path $artifactRoot '.demo18_deployment.ok'
$failurePath = Join-Path $artifactRoot '.demo18_deployment.failed'
$logPath = Join-Path $artifactRoot 'deployment-last-run.log'
$sshOptions = @(
  '-tt',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'PreferredAuthentications=password',
  '-o', 'PubkeyAuthentication=no'
)

Write-Host ''
Write-Host 'Demo18 deployment retry with diagnostic output' -ForegroundColor Cyan
Write-Host 'Enter the ubuntu SSH password. Enter it again if sudo asks.'
Write-Host 'Typed password characters will not be displayed or logged.'
Write-Host ''

& ssh.exe @sshOptions 'ubuntu@49.232.124.39' 'sudo bash /tmp/demo18-remote-deploy.sh' 2>&1 |
  Tee-Object -FilePath $logPath
$deployExitCode = $LASTEXITCODE

if ($deployExitCode -ne 0) {
  Set-Content -LiteralPath $failurePath -Value "ssh/deploy exit code: $deployExitCode" -Encoding ascii
  Write-Host 'Deployment failed. Diagnostic output was saved without the password.' -ForegroundColor Red
  Start-Sleep -Seconds 5
  exit $deployExitCode
}

Remove-Item -LiteralPath $failurePath -ErrorAction SilentlyContinue
Set-Content -LiteralPath $successPath -Value 'deployed' -Encoding ascii
Write-Host 'Deployment completed successfully. This window will close in 5 seconds.' -ForegroundColor Green
Start-Sleep -Seconds 5
exit 0
