# VoiceCode mouse helper - PowerShell fallback for when the native voicecode-input.exe
# is not available. Speaks the same stdin/stdout line protocol (see voicecode-input.c)
# and calls SendInput through a small C# shim compiled at startup.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class VcInput {
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
    static readonly uint[] Down = { 0x0002, 0x0008, 0x0020 }; // left, right, middle
    static readonly uint[] Up = { 0x0004, 0x0010, 0x0040 };
    static readonly bool[] Pressed = new bool[3];

    public static void Init() {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    }

    static void Send(uint flags, int dx, int dy, uint data) {
        var input = new INPUT { type = 0 };
        input.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MoveRelative(int dx, int dy) {
        POINT p;
        if (!GetCursorPos(out p)) return;
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        if (vw < 2 || vh < 2) return;
        int x = Math.Min(Math.Max(p.X + dx, vx), vx + vw - 1);
        int y = Math.Min(Math.Max(p.Y + dy, vy), vy + vh - 1);
        int ax = (int)(((long)(x - vx) * 65535 + (vw - 1) / 2) / (vw - 1));
        int ay = (int)(((long)(y - vy) * 65535 + (vh - 1) / 2) / (vh - 1));
        Send(MOVE | ABSOLUTE | VIRTUALDESK, ax, ay, 0);
    }

    public static void Button(int logical, bool down) {
        if (Pressed[logical] == down) return;
        Pressed[logical] = down;
        int b = logical;
        if (GetSystemMetrics(23) != 0 && logical < 2) b = 1 - logical; // SM_SWAPBUTTON
        Send(down ? Down[b] : Up[b], 0, 0, 0);
    }

    public static void Scroll(int dx, int dy) {
        if (dy != 0) Send(WHEEL, 0, 0, unchecked((uint)(-dy)));
        if (dx != 0) Send(HWHEEL, 0, 0, unchecked((uint)dx));
    }

    public static void ReleaseAll() { for (int i = 0; i < 3; i++) if (Pressed[i]) Button(i, false); }
}
'@

[VcInput]::Init()
$buttons = @{ 'l' = 0; 'r' = 1; 'm' = 2 }
$integrity = 'medium'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $integrity = 'high' }
$session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

[Console]::Out.WriteLine("ready platform=win32 session=$session integrity=$integrity protocol=1")
[Console]::Out.Flush()

try {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        $parts = $line.Trim().Split(' ')
        switch ($parts[0]) {
            'm' { [VcInput]::MoveRelative([int]$parts[1], [int]$parts[2]) }
            'd' { if ($buttons.ContainsKey($parts[1])) { [VcInput]::Button($buttons[$parts[1]], $true) } }
            'u' { if ($buttons.ContainsKey($parts[1])) { [VcInput]::Button($buttons[$parts[1]], $false) } }
            's' { [VcInput]::Scroll([int]$parts[1], [int]$parts[2]) }
            'p' {
                $p = New-Object VcInput+POINT
                [void][VcInput]::GetCursorPos([ref]$p)
                [Console]::Out.WriteLine("pos $($p.X) $($p.Y)")
                [Console]::Out.Flush()
            }
            'q' { break }
        }
        if ($parts[0] -eq 'q') { break }
    }
}
finally {
    [VcInput]::ReleaseAll()
}
