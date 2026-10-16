# VoiceCode Claude Desktop helper: drives the Code tab of the Claude Desktop app through
# Windows UI Automation (the accessibility interface screen readers use), so a phone can
# take control of a Desktop session the way voicecode-console.exe does for a terminal.
#
# Protocol: one JSON request per line on stdin, one JSON reply per line on stdout.
#   {"id":1,"op":"state","title":"Fix the login bug"}
#   {"id":1,"ok":true,...}            or            {"id":1,"ok":false,"error":"..."}
# The first line written is {"ready":true}. Ops: state, open, prompt, stop, mode,
# model, models (see the functions below). Permission requests are not answered here:
# the agent answers them through Claude Code's PermissionRequest hook, which works
# whatever the window is doing; this helper only reports that one is showing. The
# helper never reads files and only touches the window of the Store-installed or
# per-user Claude Desktop process. Before acting it brings the window up without
# activating it (Chromium stops rendering a minimized or covered window); typing into
# the prompt box then focuses Desktop, which Chromium does itself.
#
# Everything here reads names that the Desktop app exposes for screen readers, which
# can change between Desktop versions; lookups are lenient and fail with a message
# instead of guessing.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class VcWindow {
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    const uint NOSIZE = 0x1, NOMOVE = 0x2, NOACTIVATE = 0x10, SHOWWINDOW = 0x40;

    public static bool Minimized(IntPtr h) { return IsIconic(h); }

    // Brings the window up without activating it. A minimized or fully covered Chromium
    // window stops rendering, and then its controls can't be pressed. (Typing into the
    // prompt box then focuses Desktop: Chromium does that itself.) Returns whether the
    // window was minimized.
    public static bool Show(IntPtr h) {
        if (h == GetForegroundWindow()) return false;
        bool changed = false;
        if (IsIconic(h)) { ShowWindow(h, 4); changed = true; } // SW_SHOWNOACTIVATE
        // Topmost and straight back: the window ends on top of the others, inactive.
        SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE | SHOWWINDOW);
        SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE | SHOWWINDOW);
        return changed;
    }
}
'@

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$Modes = @('Manual', 'Accept edits', 'Plan', 'Bypass permissions', 'Auto', "Don't ask")

function Send-Line($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

# --- Finding things ------------------------------------------------------------------

function Get-Window {
  $ids = @(Get-Process -Name claude -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and ($_.Path -like '*\WindowsApps\Claude_*' -or $_.Path -like '*\AnthropicClaude\*') } |
      ForEach-Object { $_.Id })
  if (-not $ids.Count) { return $null }
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Window)
  foreach ($w in $AE::RootElement.FindAll($TS::Children, $cond)) {
    if ($ids -contains $w.Current.ProcessId) { return $w }
  }
  return $null
}

# All elements of the given control types under `root`, with name and type fetched in
# one cross-process call (a cache request) rather than one call per property.
function Get-Elements($root, $types) {
  $req = New-Object System.Windows.Automation.CacheRequest
  $req.Add($AE::NameProperty)
  $req.Add($AE::ControlTypeProperty)
  $req.Add($AE::AutomationIdProperty)
  $conds = @($types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $_) })
  $cond = if ($conds.Count -eq 1) { $conds[0] } else { New-Object System.Windows.Automation.OrCondition($conds) }
  $req.Push()
  try { return @($root.FindAll($TS::Descendants, $cond)) } finally { $req.Pop() }
}

function Get-Name($el) { return $el.Cached.Name }
function Get-Type($el) { return $el.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', '' }

function Get-Pane($w) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Primary pane')
  return $w.FindFirst($TS::Descendants, $cond)
}

function Invoke-Element($el) {
  $p = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return }
  throw "That control can't be pressed."
}

function Set-Expanded($el, [bool]$open) {
  $p = $null
  if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
    throw "That menu can't be opened."
  }
  $state = $p.Current.ExpandCollapseState
  if ($open -and $state -ne 'Expanded') { $p.Expand() }
  if (-not $open -and $state -eq 'Expanded') { $p.Collapse() }
}

function Get-Value($el) {
  $p = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { return [string]$p.Current.Value }
  return ''
}

# --- Reading the screen ----------------------------------------------------------------

# What the Code tab shows for the open session: its title, whether Claude is working,
# a permission request, the prompt box, and the mode and model buttons.
function Read-Pane($w) {
  $pane = Get-Pane $w
  if (-not $pane) { return @{ code = $false } }
  $els = Get-Elements $pane @($CT::Button, $CT::Group, $CT::Edit)
  $r = @{ code = $true; busy = $false; promptEmpty = $true }
  # The page is titled "<session title> - Claude Code" while a session is open.
  $docCond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'RootWebArea')
  foreach ($doc in $w.FindAll($TS::Descendants, $docCond)) {
    $name = $doc.Current.Name
    if ($name -like '* - Claude Code') { $r.title = $name.Substring(0, $name.Length - ' - Claude Code'.Length) }
  }
  $permIndex = -1
  for ($i = 0; $i -lt $els.Count; $i++) {
    $el = $els[$i]; $name = Get-Name $el; $type = Get-Type $el
    if ($type -eq 'Button') {
      if ($name -eq 'Stop') { $r.busy = $true }
      elseif ($name -like 'Model: *') { $r.model = $name.Substring(7) }
      elseif ($Modes -contains $name) { $r.mode = $name }
    } elseif ($type -eq 'Group' -and $name -like 'Permission request*') {
      $permIndex = $i
    } elseif ($type -eq 'Edit' -and $name -eq 'Prompt') {
      $r.promptEmpty = -not (Get-Value $el).Trim()
    }
  }
  if ($permIndex -ge 0) { $r.permission = Read-Permission $els[$permIndex] }
  return $r
}

# The request's words (what Desktop shows the user) and its answer buttons.
function Read-Permission($group) {
  $texts = New-Object System.Collections.Generic.List[string]
  $req = New-Object System.Windows.Automation.CacheRequest
  $req.Add($AE::NameProperty)
  $req.Add($AE::ControlTypeProperty)
  $req.Push()
  try { $all = $group.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } finally { $req.Pop() }
  $buttons = New-Object System.Collections.Generic.List[string]
  foreach ($el in $all) {
    $name = Get-Name $el
    if (-not $name) { continue }
    if ((Get-Type $el) -eq 'Button') { $buttons.Add($name) } elseif ((Get-Type $el) -eq 'Text') { $texts.Add($name) }
  }
  return @{ name = $group.Cached.Name; text = ($texts -join ' '); buttons = @($buttons) }
}

# Sidebar rows read "<state> <title>", e.g. "Idle Fix the login bug".
function Find-Row($w, [string]$title) {
  $side = $null
  foreach ($el in (Get-Elements $w @($CT::Button))) {
    $name = Get-Name $el
    if ($name.Length -gt $title.Length -and $name.EndsWith(' ' + $title) -and $name -notlike 'More options for *' -and $name -notlike 'New session in *') {
      return @{ el = $el; status = $name.Substring(0, $name.Length - $title.Length - 1) }
    }
  }
  return $null
}

# --- Operations -------------------------------------------------------------------------

# The window, brought up for an action from the phone (Chromium needs a few hundred ms
# to notice it is visible again and render).
function Need-Window {
  $w = Get-Window
  if (-not $w) { throw 'Claude Desktop is not open.' }
  $h = [IntPtr]$w.Current.NativeWindowHandle
  $wasMinimized = [VcWindow]::Show($h)
  Start-Sleep -Milliseconds $(if ($wasMinimized) { 1200 } else { 400 })
  return $w
}

# Shows the session `title` in the Code tab (Desktop shows one session at a time).
function Open-Session($w, [string]$title) {
  if (-not $title) { throw 'No session title.' }
  $pane = Read-Pane $w
  if ($pane.title -eq $title) { return $pane }
  $row = Find-Row $w $title
  if (-not $row) { throw "Claude Desktop's sidebar has no session named `"$title`"." }
  Invoke-Element $row.el
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 100
    $pane = Read-Pane $w
    if ($pane.title -eq $title) { return $pane }
  }
  throw "Claude Desktop did not open `"$title`"."
}

# While minimized, Chromium keeps the last accessibility tree it built: what it shows
# may be stale (the agent then goes by the transcript).
function Op-State($req) {
  $w = Get-Window
  if (-not $w) { return @{ window = $false } }
  $pane = Read-Pane $w
  $r = @{
    window = $true
    minimized = [VcWindow]::Minimized([IntPtr]$w.Current.NativeWindowHandle)
    pane = $pane
    shown = ($req.title -and $pane.title -eq $req.title)
  }
  if ($req.title -and -not $r.shown) {
    $row = Find-Row $w $req.title
    if ($row) { $r.rowStatus = $row.status }
  }
  return $r
}

function Find-Control($w, [string]$type, [scriptblock]$match) {
  $pane = Get-Pane $w
  if (-not $pane) { return $null }
  foreach ($el in (Get-Elements $pane @($CT::$type))) { if (& $match (Get-Name $el)) { return $el } }
  return $null
}

function Op-Prompt($req) {
  $w = Need-Window
  $pane = Open-Session $w $req.title
  # A window just brought back may still show what it showed before; give it a moment.
  for ($i = 0; $i -lt 15 -and $pane.busy; $i++) {
    Start-Sleep -Milliseconds 200
    $pane = Read-Pane $w
  }
  if ($pane.busy) { throw 'Claude is working in Claude Desktop; wait until it has finished.' }
  if (-not $pane.promptEmpty) { throw "Claude Desktop's prompt box already has text; clear it first." }
  $box = Find-Control $w 'Edit' { param($n) $n -eq 'Prompt' }
  if (-not $box) { throw "Claude Desktop's prompt box was not found." }
  $p = $null
  if (-not $box.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { throw "Claude Desktop's prompt box can't be filled." }
  $p.SetValue([string]$req.text)
  Start-Sleep -Milliseconds 250
  $send = Find-Control $w 'Button' { param($n) $n -eq 'Send' }
  if (-not $send) { throw "Claude Desktop's Send button was not found." }
  Invoke-Element $send
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 100
    if ((Read-Pane $w).promptEmpty) { return @{} }
  }
  throw 'Claude Desktop did not take the prompt.'
}

function Op-Stop($req) {
  $w = Need-Window
  Open-Session $w $req.title | Out-Null
  $stop = Find-Control $w 'Button' { param($n) $n -eq 'Stop' }
  if ($stop) { Invoke-Element $stop }
  return @{}
}

# Opens a menu button, runs `$then` with the menu's items, and makes sure it closes.
function With-Menu($w, $button, [scriptblock]$then) {
  Set-Expanded $button $true
  Start-Sleep -Milliseconds 300
  try {
    $items = Get-Elements $w @($CT::RadioButton, $CT::MenuItem)
    return & $then $items
  } finally {
    try { Set-Expanded $button $false } catch { }
  }
}

function Op-Mode($req) {
  $w = Need-Window
  $pane = Open-Session $w $req.title
  if ($pane.mode -eq $req.label) { return @{ mode = $pane.mode } }
  $button = Find-Control $w 'Button' { param($n) $Modes -contains $n }
  if (-not $button) { throw "Claude Desktop's mode button was not found." }
  With-Menu $w $button {
    param($items)
    $item = $items | Where-Object { (Get-Name $_) -eq $req.label -or (Get-Name $_) -like "$($req.label) *" } | Select-Object -First 1
    if (-not $item) { throw "Claude Desktop does not offer `"$($req.label)`" here." }
    Invoke-Element $item
  } | Out-Null
  Start-Sleep -Milliseconds 300
  $now = (Read-Pane $w).mode
  if ($now -ne $req.label) { throw "Claude Desktop stayed in `"$now`"." }
  return @{ mode = $now }
}

function Model-Items($items) {
  return @($items | Where-Object { (Get-Type $_) -eq 'RadioButton' } | ForEach-Object { Get-Name $_ } | Where-Object { $_ -and $Modes -notcontains $_ -and $_ -notin @('Claude', 'Code') })
}

function Op-Models($req) {
  $w = Need-Window
  Open-Session $w $req.title | Out-Null
  $button = Find-Control $w 'Button' { param($n) $n -like 'Model: *' }
  if (-not $button) { throw "Claude Desktop's model button was not found." }
  $names = With-Menu $w $button { param($items) Model-Items $items }
  return @{ models = @($names) }
}

# The model button reads "Model: <model> <effort>", e.g. "Opus 5.5 High".
function Is-Model([string]$shown, [string]$label) {
  return $shown -eq $label -or $shown -like "$label *"
}

function Op-Model($req) {
  $w = Need-Window
  $pane = Open-Session $w $req.title
  if (Is-Model $pane.model $req.label) { return @{ model = $pane.model } }
  $button = Find-Control $w 'Button' { param($n) $n -like 'Model: *' }
  if (-not $button) { throw "Claude Desktop's model button was not found." }
  With-Menu $w $button {
    param($items)
    $item = $items | Where-Object { (Get-Type $_) -eq 'RadioButton' -and (Get-Name $_) -eq $req.label } | Select-Object -First 1
    if (-not $item) { throw "Claude Desktop's model menu has no `"$($req.label)`"." }
    Invoke-Element $item
    # Desktop asks first when the session would be re-read by another model.
    for ($i = 0; $i -lt 10; $i++) {
      Start-Sleep -Milliseconds 150
      $confirm = Get-Elements $w @($CT::Button) | Where-Object { (Get-Name $_) -eq 'Switch model' } | Select-Object -First 1
      if ($confirm) { Invoke-Element $confirm; break }
    }
  } | Out-Null
  Start-Sleep -Milliseconds 300
  $now = (Read-Pane $w).model
  if (-not (Is-Model $now $req.label)) { throw "Claude Desktop kept $now." }
  return @{ model = $now }
}

# --- Main loop ----------------------------------------------------------------------------

Send-Line @{ ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = switch ($req.op) {
      'state' { Op-State $req }
      'open' { Open-Session (Need-Window) $req.title | Out-Null; @{} }
      'prompt' { Op-Prompt $req }
      'stop' { Op-Stop $req }
      'mode' { Op-Mode $req }
      'model' { Op-Model $req }
      'models' { Op-Models $req }
      default { throw "Unknown op $($req.op)" }
    }
    $reply = @{ id = $id; ok = $true }
    foreach ($k in $result.Keys) { $reply[$k] = $result[$k] }
    Send-Line $reply
  } catch {
    Send-Line @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}
