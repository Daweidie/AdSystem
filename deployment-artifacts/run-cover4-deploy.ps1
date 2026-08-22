$ErrorActionPreference = 'Stop'

$artifactRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$archivePath = Join-Path $artifactRoot 'demo18-release-20260818-cover4.tar.gz'
$remoteScriptPath = Join-Path $artifactRoot 'demo18-remote-deploy.sh'
$sshOptions = @(
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'PreferredAuthentications=password',
  '-o', 'PubkeyAuthentication=no'
)

if (-not (Test-Path -LiteralPath $archivePath)) { throw "Release archive is missing: $archivePath" }
if (-not (Test-Path -LiteralPath $remoteScriptPath)) { throw "Remote script is missing: $remoteScriptPath" }

Write-Host 'Upload the release archive and deployment script, then run the deployment.' -ForegroundColor Cyan
Write-Host 'The remote script creates an application/database backup and preserves backend/.env.'
Write-Host 'Enter the ubuntu password at each SSH/SCP prompt; passwords are not stored.'

& scp.exe @sshOptions $archivePath $remoteScriptPath 'ubuntu@49.232.124.39:/tmp/'
if ($LASTEXITCODE -ne 0) { throw "SCP failed with exit code $LASTEXITCODE" }

& ssh.exe -tt @sshOptions 'ubuntu@49.232.124.39' 'sudo bash /tmp/demo18-remote-deploy.sh'
if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed with exit code $LASTEXITCODE" }

Write-Host 'Deployment completed.' -ForegroundColor Green
