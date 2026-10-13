/*
 * voicecode-input — Win32 mouse injection helper for the VoiceCode agent.
 *
 * Reads one command per line on stdin and injects input with SendInput:
 *   m <dx> <dy>   relative move in physical pixels
 *   d <l|r|m>     button down        u <l|r|m>   button up
 *   s <dx> <dy>   scroll in wheel units (120 = one notch); +dy scrolls down, +dx right
 *   p             report pointer position as "pos <x> <y>"
 *   q             release held buttons and exit (EOF does the same)
 *
 * On startup it prints "ready platform=win32 session=<id> integrity=<level>".
 *
 * Build (MinGW):  gcc -O2 -municode -o voicecode-input.exe voicecode-input.c -luser32 -ladvapi32
 * Build (MSVC):   cl /O2 voicecode-input.c user32.lib advapi32.lib
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
#define DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 ((HANDLE)-4)
#endif

enum { BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_COUNT };
static int pressed[BTN_COUNT];
static int reported_failure;

static void reply(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stdout, fmt, args);
    va_end(args);
    fputc('\n', stdout);
    fflush(stdout);
}

static void send_mouse(DWORD flags, LONG dx, LONG dy, DWORD data) {
    INPUT input;
    ZeroMemory(&input, sizeof(input));
    input.type = INPUT_MOUSE;
    input.mi.dx = dx;
    input.mi.dy = dy;
    input.mi.mouseData = data;
    input.mi.dwFlags = flags;
    if (SendInput(1, &input, sizeof(INPUT)) == 1) {
        reported_failure = 0;
    } else if (!reported_failure) {
        /* Typically the secure desktop (UAC prompt, lock screen) is active. Report once
         * per run of failures, not for every injected event. */
        reported_failure = 1;
        reply("err SendInput failed (error %lu); is the desktop locked or a UAC prompt open?",
              GetLastError());
    }
}

static LONG clamp(LONG v, LONG lo, LONG hi) { return v < lo ? lo : (v > hi ? hi : v); }

/*
 * Moves to an absolute point on the virtual desktop rather than injecting a relative
 * move, so Windows' pointer acceleration is not applied on top of the trackpad's own
 * acceleration curve. Works across multiple monitors.
 */
static void move_relative(LONG dx, LONG dy) {
    POINT p;
    if (!GetCursorPos(&p)) return;
    LONG vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    LONG vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (vw < 2 || vh < 2) return;
    LONG x = clamp(p.x + dx, vx, vx + vw - 1);
    LONG y = clamp(p.y + dy, vy, vy + vh - 1);
    LONG ax = (LONG)(((LONGLONG)(x - vx) * 65535 + (vw - 1) / 2) / (vw - 1));
    LONG ay = (LONG)(((LONGLONG)(y - vy) * 65535 + (vh - 1) / 2) / (vh - 1));
    send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0);
}

/* Honour the "switch primary and secondary buttons" accessibility setting. */
static int physical_button(int logical) {
    if (GetSystemMetrics(SM_SWAPBUTTON)) {
        if (logical == BTN_LEFT) return BTN_RIGHT;
        if (logical == BTN_RIGHT) return BTN_LEFT;
    }
    return logical;
}

static void button(int logical, int down) {
    static const DWORD down_flags[BTN_COUNT] = {MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_MIDDLEDOWN};
    static const DWORD up_flags[BTN_COUNT] = {MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_MIDDLEUP};
    int b = physical_button(logical);
    if (down == pressed[logical]) return;
    pressed[logical] = down;
    send_mouse(down ? down_flags[b] : up_flags[b], 0, 0, 0);
}

static void release_all(void) {
    for (int i = 0; i < BTN_COUNT; i++) {
        if (pressed[i]) button(i, 0);
    }
}

static int parse_button(char c) {
    switch (c) {
        case 'l': return BTN_LEFT;
        case 'r': return BTN_RIGHT;
        case 'm': return BTN_MIDDLE;
        default: return -1;
    }
}

static const char *integrity_level(void) {
    HANDLE token;
    static char buffer[64];
    const char *level = "unknown";
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return level;
    DWORD size = 0;
    GetTokenInformation(token, TokenIntegrityLevel, NULL, 0, &size);
    TOKEN_MANDATORY_LABEL *label = (TOKEN_MANDATORY_LABEL *)malloc(size);
    if (label && GetTokenInformation(token, TokenIntegrityLevel, label, size, &size)) {
        DWORD rid = *GetSidSubAuthority(label->Label.Sid, *GetSidSubAuthorityCount(label->Label.Sid) - 1);
        if (rid >= SECURITY_MANDATORY_SYSTEM_RID) level = "system";
        else if (rid >= SECURITY_MANDATORY_HIGH_RID) level = "high";
        else if (rid >= SECURITY_MANDATORY_MEDIUM_RID) level = "medium";
        else level = "low";
    }
    free(label);
    CloseHandle(token);
    strncpy(buffer, level, sizeof(buffer) - 1);
    return buffer;
}

static void enable_dpi_awareness(void) {
    typedef BOOL(WINAPI * SetCtx)(HANDLE);
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    SetCtx set_ctx = user32 ? (SetCtx)(void *)GetProcAddress(user32, "SetProcessDpiAwarenessContext") : NULL;
    if (!set_ctx || !set_ctx(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) SetProcessDPIAware();
}

int wmain(void) {
    char line[128];
    DWORD session = 0;

    enable_dpi_awareness();
    ProcessIdToSessionId(GetCurrentProcessId(), &session);
    reply("ready platform=win32 session=%lu integrity=%s protocol=1", session, integrity_level());

    while (fgets(line, sizeof(line), stdin)) {
        long a = 0, b = 0;
        char c = 0;
        switch (line[0]) {
            case 'm':
                if (sscanf(line + 1, "%ld %ld", &a, &b) == 2) move_relative(a, b);
                break;
            case 'd':
            case 'u':
                if (sscanf(line + 1, " %c", &c) == 1 && parse_button(c) >= 0) button(parse_button(c), line[0] == 'd');
                break;
            case 's':
                if (sscanf(line + 1, "%ld %ld", &a, &b) == 2) {
                    if (b) send_mouse(MOUSEEVENTF_WHEEL, 0, 0, (DWORD)(-b));
                    if (a) send_mouse(MOUSEEVENTF_HWHEEL, 0, 0, (DWORD)a);
                }
                break;
            case 'p': {
                POINT p;
                if (GetCursorPos(&p)) reply("pos %ld %ld", p.x, p.y);
                else reply("err GetCursorPos failed");
                break;
            }
            case 'q':
                release_all();
                return 0;
            default:
                break;
        }
    }
    release_all();
    return 0;
}
