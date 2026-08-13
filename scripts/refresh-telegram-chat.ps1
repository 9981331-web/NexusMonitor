$ErrorActionPreference = 'Stop'

$taskRoot = Join-Path $env:LOCALAPPDATA 'Nexus\RussianPostMonitor'
$secretRoot = Join-Path $taskRoot 'secrets'
$tokenPath = Join-Path $secretRoot 'telegram-token.dpapi'
$chatPath = Join-Path $secretRoot 'telegram-chat-id.dpapi'

if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
  throw 'DPAPI-protected Telegram bot token is missing.'
}

$tokenSecure = Get-Content -Raw -LiteralPath $tokenPath | ConvertTo-SecureString
$tokenText = [System.Net.NetworkCredential]::new('', $tokenSecure).Password
try {
  $updates = Invoke-RestMethod -Method Get -Uri ("https://api.telegram.org/bot{0}/getUpdates?limit=100&timeout=0" -f $tokenText) -TimeoutSec 20
  $privateUpdates = @($updates.result | Where-Object { $_.message.chat.type -eq 'private' -and $_.message.from.is_bot -eq $false } | Sort-Object update_id)
  if ($privateUpdates.Count -eq 0) {
    throw 'No private message from a non-bot Telegram user was found.'
  }
  $chatSecure = ConvertTo-SecureString ([string]$privateUpdates[-1].message.chat.id) -AsPlainText -Force
  $chatSecure | ConvertFrom-SecureString | Set-Content -Encoding ASCII -NoNewline -LiteralPath $chatPath
  Write-Output 'Telegram chat ID refreshed from a private non-bot update.'
} finally {
  $tokenText = $null
}
