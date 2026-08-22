$ErrorActionPreference = 'Stop'

$artifactRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$archivePath = Join-Path $artifactRoot 'demo18-release-20260817-r6.tar.gz'
$remoteScriptPath = Join-Path $artifactRoot 'demo18-remote-deploy.sh'
$expectedSha256 = 'B01E580127B1F4BC260E86A5BA69D7E016B35608C5C7BDD919FDCA8E8098E8A7'
$successPath = Join-Path $artifactRoot '.demo18_deployment.ok'
$failurePath = Join-Path $artifactRoot '.demo18_deployment.failed'
$sshOptions = @(
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'PreferredAuthentications=password',
  '-o', 'PubkeyAuthentication=no'
)

if (-not (Test-Path -LiteralPath $archivePath)) {
  throw "Release archive is missing: $archivePath"
}
$actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actualSha256 -ne $expectedSha256) {
  throw "Release archive checksum mismatch. Expected $expectedSha256, got $actualSha256"
}

Write-Host ''
Write-Host 'Demo18 production deployment' -ForegroundColor Cyan
Write-Host 'Step 1/2 uploads the release. Enter the ubuntu password at the SCP prompt.'
Write-Host 'Step 2/2 deploys it. Enter the ubuntu password again at the SSH prompt.'
Write-Host 'If sudo asks for a password, enter it once more.'
Write-Host 'Typed password characters will not be displayed or stored.'
Write-Host ''

& scp.exe @sshOptions $archivePath $remoteScriptPath 'ubuntu@49.232.124.39:/tmp/'
if ($LASTEXITCODE -ne 0) {
  Set-Content -LiteralPath $failurePath -Value "scp exit code: $LASTEXITCODE" -Encoding ascii
  Write-Host 'Upload failed. Check the password or network connection.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit $LASTEXITCODE
}

& ssh.exe -tt @sshOptions 'ubuntu@49.232.124.39' 'sudo bash /tmp/demo18-remote-deploy.sh'
if ($LASTEXITCODE -ne 0) {
  Set-Content -LiteralPath $failurePath -Value "ssh/deploy exit code: $LASTEXITCODE" -Encoding ascii
  Write-Host 'Deployment failed. The pre-deployment backup is retained on the server.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit $LASTEXITCODE
}

Set-Content -LiteralPath $successPath -Value 'deployed' -Encoding ascii
Write-Host ''
Write-Host 'Deployment completed successfully. This window will close in 5 seconds.' -ForegroundColor Green
Start-Sleep -Seconds 5
exit 0
