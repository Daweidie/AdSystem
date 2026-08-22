$ErrorActionPreference = 'Stop'

$artifactRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$publicKeyPath = Join-Path $artifactRoot '.demo18_deploy_rsa.pub'
$successPath = Join-Path $artifactRoot '.demo18_authorized.ok'
$failurePath = Join-Path $artifactRoot '.demo18_authorized.failed'

Write-Host ''
Write-Host 'Demo18 temporary deployment authorization' -ForegroundColor Cyan
Write-Host 'Enter the ubuntu server password at the SSH password prompt below.'
Write-Host 'Typed password characters will not be displayed or stored.'
Write-Host ''

$publicKey = (Get-Content -LiteralPath $publicKeyPath -Raw).Trim()
$remoteCommand = 'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; key=''{0}''; grep -v ''demo18-temporary-deploy-20260814'' "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.tmp" || true; printf "%s\n" "$key" >> "$HOME/.ssh/authorized_keys.tmp"; mv "$HOME/.ssh/authorized_keys.tmp" "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"' -f $publicKey
& ssh.exe -o StrictHostKeyChecking=yes -o PreferredAuthentications=password -o PubkeyAuthentication=no ubuntu@49.232.124.39 $remoteCommand

if ($LASTEXITCODE -eq 0) {
  Set-Content -LiteralPath $successPath -Value 'authorized' -Encoding ascii
  Write-Host ''
  Write-Host 'Temporary key authorized. This window will close in 3 seconds.' -ForegroundColor Green
  Start-Sleep -Seconds 3
  exit 0
}

Set-Content -LiteralPath $failurePath -Value "ssh exit code: $LASTEXITCODE" -Encoding ascii
Write-Host ''
Write-Host 'Temporary key authorization failed. Check the password and close this window.' -ForegroundColor Red
Read-Host 'Press Enter to close'
exit $LASTEXITCODE
