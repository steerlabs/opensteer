<#
.SYNOPSIS
Runs `node <Script> <spec.json>` as a disposable local user who is not an administrator.

.DESCRIPTION
Hosted Windows runners run every step as an administrator with UAC off. This creates a
member of Users only, runs the script as that user through a Task Scheduler task with a
limited token, streams the log the script writes, exits with the code it records, and
deletes the task and the user. The spec names the working directory, the log, the
result file and the listed variables' values from this step.
#>
param(
  [Parameter(Mandatory)][string]$Script,
  [string[]]$Writable = @(),
  [string[]]$Variables = @(),
  [int]$TimeoutMinutes = 20
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$name = 'opensteer-ci-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$work = Join-Path $env:RUNNER_TEMP $name
New-Item -ItemType Directory -Path $work | Out-Null
$password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)) + 'aA1!'
Write-Output "::add-mask::$password"

# A task that logs on with a password starts only for an account holding this right,
# which Users lack by default. The current holders keep it.
function Grant-BatchLogon([string]$Sid) {
  $exported = Join-Path $work 'rights-current.inf'
  secedit /export /areas USER_RIGHTS /cfg $exported /quiet | Out-Null
  if ($LASTEXITCODE) { throw 'secedit could not export user rights' }
  $current = (Get-Content $exported | Where-Object { $_ -match '^SeBatchLogonRight\s*=' }) -replace '^SeBatchLogonRight\s*=\s*', ''
  $holders = @(@($current -split ',') | Where-Object { $_ }) + "*$Sid"
  $template = Join-Path $work 'rights.inf'
  @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1',
    '[Privilege Rights]', "SeBatchLogonRight = $($holders -join ',')") |
    Set-Content -Encoding Unicode $template
  secedit /configure /db (Join-Path $work 'rights.sdb') /cfg $template /areas USER_RIGHTS /quiet | Out-Null
  if ($LASTEXITCODE) { throw 'secedit could not grant the batch logon right' }
}

$created = $false
$exitCode = 1
try {
  $user = New-LocalUser -Name $name -Password (ConvertTo-SecureString $password -AsPlainText -Force) `
    -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword
  $created = $true
  $sid = $user.SID.Value
  try {
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
  } catch [Microsoft.PowerShell.Commands.MemberExistsException] {}
  Grant-BatchLogon $sid
  foreach ($directory in @($work) + $Writable) {
    icacls $directory /grant "*${sid}:(OI)(CI)M" /Q | Out-Null
    if ($LASTEXITCODE) { throw "Could not let $name write $directory" }
  }

  $environment = @{ OPENSTEER_CI_STANDARD_USER = $name }
  foreach ($variable in $Variables) {
    $value = [Environment]::GetEnvironmentVariable($variable)
    if ($null -ne $value) { $environment[$variable] = $value }
  }
  $log = Join-Path $work 'output.log'
  $result = Join-Path $work 'result.json'
  $spec = Join-Path $work 'spec.json'
  $directory = (Get-Location).Path
  @{ cwd = $directory; environment = $environment; log = $log; result = $result } |
    ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8NoBOM $spec
  New-Item -ItemType File -Path $log | Out-Null

  $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  $action = New-ScheduledTaskAction -Execute $node -WorkingDirectory $directory `
    -Argument "`"$((Resolve-Path $Script).Path)`" `"$spec`""
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeoutMinutes) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $action -Settings $settings `
    -User $name -Password $password -RunLevel Limited | Out-Null
  $started = (Get-Date).AddSeconds(-1)
  Start-ScheduledTask -TaskName $name

  $deadline = $started.AddMinutes($TimeoutMinutes + 1)
  $reader = [IO.StreamReader]::new([IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'))
  try {
    while ($true) {
      [Console]::Out.Write($reader.ReadToEnd())
      $info = Get-ScheduledTaskInfo -TaskName $name
      $state = (Get-ScheduledTask -TaskName $name).State
      if ($info.LastRunTime -ge $started -and $state -ne 'Running' -and $state -ne 'Queued') { break }
      if ((Get-Date) -gt $deadline) {
        Stop-ScheduledTask -TaskName $name
        throw "$Script did not finish within $TimeoutMinutes minutes"
      }
      Start-Sleep -Milliseconds 500
    }
    [Console]::Out.Write($reader.ReadToEnd())
  } finally {
    $reader.Dispose()
  }
  if (-not (Test-Path $result)) {
    throw ("{0} never ran as {1} (task result 0x{2:X8})" -f $Script, $name, $info.LastTaskResult)
  }
  $exitCode = [int](Get-Content -Raw $result | ConvertFrom-Json).code
} finally {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  if ($created) { Remove-LocalUser -Name $name }
}
exit $exitCode
