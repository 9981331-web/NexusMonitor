$ErrorActionPreference = 'Stop'

$taskName = 'Nexus Russian Post Monitor'
$scriptPath = 'C:\NEXUS\nexus-court-monitor\scripts\run-russian-post.ps1'
$powerShellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  throw "Runner script not found: $scriptPath"
}

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$daily = New-ScheduledTaskTrigger -Daily -At '14:00'
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($daily, $atLogon) -Settings $settings -Principal $principal -Description 'Read-only Russian Post account monitor; daily 14:00 Europe/Moscow with bounded recovery.' -Force | Out-Null

$task = Get-ScheduledTask -TaskName $taskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
  TaskName = $task.TaskName
  State = $task.State
  NextRunTime = $taskInfo.NextRunTime
  TriggerCount = @($task.Triggers).Count
}
