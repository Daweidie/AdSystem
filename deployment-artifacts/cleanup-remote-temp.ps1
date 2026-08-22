$ErrorActionPreference = 'Stop'

$artifactRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$successPath = Join-Path $artifactRoot '.demo18_remote_cleanup.ok'
$sshOptions = @(
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'PreferredAuthentications=password',
  '-o', 'PubkeyAuthentication=no'
)

Write-Host 'Enter the ubuntu password once to remove temporary deployment files.'
& ssh.exe @sshOptions 'ubuntu@49.232.124.39' 'rm -f -- /tmp/demo18-release-20260814.tar.gz /tmp/demo18-remote-deploy.sh; printf REMOTE_CLEANUP_OK'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Content -LiteralPath $successPath -Value 'cleaned' -Encoding ascii
Write-Host 'Remote temporary files removed.' -ForegroundColor Green
Start-Sleep -Seconds 3
exit 0
