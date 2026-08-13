$ErrorActionPreference = 'Stop'

$taskRoot = Join-Path $env:LOCALAPPDATA 'Nexus\RussianPostMonitor'
$secretRoot = Join-Path $taskRoot 'secrets'
$stateRoot = Join-Path $taskRoot 'state'
$profileRoot = Join-Path $taskRoot 'profile'

New-Item -ItemType Directory -Force -Path $secretRoot, $stateRoot, $profileRoot | Out-Null

$tokenPath = Join-Path $secretRoot 'telegram-token.dpapi'
if (Test-Path -LiteralPath $tokenPath) {
  $telegramToken = Get-Content -Raw -LiteralPath $tokenPath | ConvertTo-SecureString
  Write-Output 'Existing DPAPI-protected Telegram bot token loaded.'
} else {
  $telegramToken = Read-Host 'Enter the existing Telegram bot token' -AsSecureString
}
$tokenText = [System.Net.NetworkCredential]::new('', $telegramToken).Password

try {
  $botInfo = Invoke-RestMethod -Method Get -Uri ("https://api.telegram.org/bot{0}/getMe" -f $tokenText) -TimeoutSec 20
  if (-not $botInfo.ok) { throw 'Bot validation failed' }
  Write-Output 'Send any new message to the existing Telegram bot, then press Enter here.'
  Read-Host | Out-Null
  $updates = Invoke-RestMethod -Method Get -Uri ("https://api.telegram.org/bot{0}/getUpdates?limit=100&timeout=0" -f $tokenText) -TimeoutSec 20
  $privateUpdates = @($updates.result | Where-Object { $_.message.chat.type -eq 'private' -and $_.message.from.is_bot -eq $false } | Sort-Object update_id)
  if ($privateUpdates.Count -eq 0) { throw 'No recent private chat message was found' }
  $chatIdText = [string]$privateUpdates[-1].message.chat.id
  $telegramChatId = ConvertTo-SecureString $chatIdText -AsPlainText -Force
} catch {
  throw 'Telegram bot validation or automatic chat discovery failed. No credentials were saved.'
} finally {
  $tokenText = $null
}

$telegramToken | ConvertFrom-SecureString | Set-Content -Encoding ASCII -NoNewline -LiteralPath $tokenPath
$telegramChatId | ConvertFrom-SecureString | Set-Content -Encoding ASCII -NoNewline -LiteralPath (Join-Path $secretRoot 'telegram-chat-id.dpapi')

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $taskRoot -AclObject $acl

Write-Output 'Local directories and DPAPI-protected Telegram credentials are configured.'
