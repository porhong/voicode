/*
 * voicecode-console — attaches to the console of a running process (a Claude Code
 * started in the user's own terminal) so the VoiceCode agent can type into it and read
 * its screen without the window having focus.
 *
 *   voicecode-console <pid>
 *
 * Reads one command per line on stdin:
 *   k <key>       press a key: space enter esc tab shift-tab up down left right c-c, or one character
 *   t <base64>    type UTF-8 text (newlines press Enter)
 *   s             print the visible screen: "screen <rows> <cols> <cursorRow> <cursorCol> <base64 utf8>"
 *   q             detach and exit (EOF does the same)
 * and answers "ready pid=<pid> protocol=1", "ok", "err <message>" or "screen …".
 *
 * Keys are injected into the console's input buffer (WriteConsoleInput), which is what
 * the process reads from whichever terminal hosts it (Windows Terminal uses ConPTY and
 * conhost keeps that buffer). The screen comes from the same console's output buffer.
 *
 * Build (MinGW): gcc -O2 -municode -o voicecode-console.exe voicecode-console.c
 * Build (MSVC):  cl /O2 voicecode-console.c
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static HANDLE out_pipe;
static HANDLE conin = INVALID_HANDLE_VALUE;
static HANDLE conout = INVALID_HANDLE_VALUE;

static void reply(const char *text, size_t length) {
    DWORD written;
    WriteFile(out_pipe, text, (DWORD)length, &written, NULL);
    WriteFile(out_pipe, "\n", 1, &written, NULL);
}

static void replyf(const char *fmt, ...) {
    char buffer[512];
    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(buffer, sizeof(buffer), fmt, args);
    va_end(args);
    if (n < 0) n = 0;
    if ((size_t)n >= sizeof(buffer)) n = sizeof(buffer) - 1;
    reply(buffer, (size_t)n);
}

/* --- base64 ---------------------------------------------------------------------------- */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *b64_encode(const unsigned char *data, size_t len) {
    char *out = (char *)malloc(((len + 2) / 3) * 4 + 1);
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        unsigned v = data[i] << 16;
        if (i + 1 < len) v |= data[i + 1] << 8;
        if (i + 2 < len) v |= data[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = i + 1 < len ? B64[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < len ? B64[v & 63] : '=';
    }
    out[o] = 0;
    return out;
}

static int b64_value(char c) {
    const char *p = strchr(B64, c);
    return p && c ? (int)(p - B64) : -1;
}

static unsigned char *b64_decode(const char *text, size_t *len) {
    size_t n = strlen(text);
    unsigned char *out = (unsigned char *)malloc(n / 4 * 3 + 3);
    size_t o = 0;
    unsigned acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
        int v = b64_value(text[i]);
        if (v < 0) continue;
        acc = (acc << 6) | (unsigned)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (unsigned char)((acc >> bits) & 0xff);
        }
    }
    *len = o;
    return out;
}

/* --- key injection ---------------------------------------------------------------------- */

static int send_key(WORD vk, wchar_t ch, DWORD control) {
    INPUT_RECORD records[2];
    ZeroMemory(records, sizeof(records));
    for (int i = 0; i < 2; i++) {
        records[i].EventType = KEY_EVENT;
        records[i].Event.KeyEvent.bKeyDown = i == 0;
        records[i].Event.KeyEvent.wRepeatCount = 1;
        records[i].Event.KeyEvent.wVirtualKeyCode = vk;
        records[i].Event.KeyEvent.wVirtualScanCode = (WORD)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
        records[i].Event.KeyEvent.uChar.UnicodeChar = ch;
        records[i].Event.KeyEvent.dwControlKeyState = control;
    }
    DWORD written = 0;
    return WriteConsoleInputW(conin, records, 2, &written) && written == 2;
}

static int send_char(wchar_t ch) {
    if (ch == L'\n' || ch == L'\r') return send_key(VK_RETURN, L'\r', 0);
    if (ch == L'\t') return send_key(VK_TAB, L'\t', 0);
    SHORT scan = VkKeyScanW(ch);
    WORD vk = scan == -1 ? 0 : (WORD)(scan & 0xff);
    DWORD control = 0;
    if (scan != -1) {
        if (scan & 0x100) control |= SHIFT_PRESSED;
        if (scan & 0x200) control |= LEFT_CTRL_PRESSED;
        if (scan & 0x400) control |= LEFT_ALT_PRESSED;
    }
    return send_key(vk, ch, control);
}

static int send_named_key(const char *name) {
    if (strcmp(name, "space") == 0) return send_key(VK_SPACE, L' ', 0);
    if (strcmp(name, "enter") == 0) return send_key(VK_RETURN, L'\r', 0);
    if (strcmp(name, "esc") == 0) return send_key(VK_ESCAPE, 27, 0);
    if (strcmp(name, "tab") == 0) return send_key(VK_TAB, L'\t', 0);
    if (strcmp(name, "shift-tab") == 0) return send_key(VK_TAB, L'\t', SHIFT_PRESSED);
    if (strcmp(name, "up") == 0) return send_key(VK_UP, 0, ENHANCED_KEY);
    if (strcmp(name, "down") == 0) return send_key(VK_DOWN, 0, ENHANCED_KEY);
    if (strcmp(name, "left") == 0) return send_key(VK_LEFT, 0, ENHANCED_KEY);
    if (strcmp(name, "right") == 0) return send_key(VK_RIGHT, 0, ENHANCED_KEY);
    if (strcmp(name, "c-c") == 0) return send_key('C', 3, LEFT_CTRL_PRESSED);
    /* A single UTF-8 character. */
    wchar_t wide[4];
    int n = MultiByteToWideChar(CP_UTF8, 0, name, -1, wide, 4);
    if (n < 2) return 0;
    return send_char(wide[0]);
}

static void type_text(const char *b64) {
    size_t len;
    unsigned char *utf8 = b64_decode(b64, &len);
    int wide_len = MultiByteToWideChar(CP_UTF8, 0, (const char *)utf8, (int)len, NULL, 0);
    wchar_t *wide = (wchar_t *)malloc(sizeof(wchar_t) * (size_t)(wide_len + 1));
    MultiByteToWideChar(CP_UTF8, 0, (const char *)utf8, (int)len, wide, wide_len);
    for (int i = 0; i < wide_len; i++) {
        if (wide[i] == L'\r' && i + 1 < wide_len && wide[i + 1] == L'\n') continue;
        send_char(wide[i]);
    }
    free(wide);
    free(utf8);
}

/* --- screen --------------------------------------------------------------------------- */

static void print_screen(void) {
    CONSOLE_SCREEN_BUFFER_INFO info;
    if (!GetConsoleScreenBufferInfo(conout, &info)) {
        replyf("err GetConsoleScreenBufferInfo failed (%lu)", GetLastError());
        return;
    }
    int rows = info.srWindow.Bottom - info.srWindow.Top + 1;
    int cols = info.srWindow.Right - info.srWindow.Left + 1;
    if (rows < 1 || cols < 1 || rows > 500 || cols > 1000) {
        replyf("err unexpected screen size %dx%d", cols, rows);
        return;
    }
    wchar_t *line = (wchar_t *)malloc(sizeof(wchar_t) * (size_t)(cols + 1));
    size_t cap = (size_t)rows * ((size_t)cols * 3 + 1) + 1;
    char *utf8 = (char *)malloc(cap);
    size_t used = 0;
    for (int r = 0; r < rows; r++) {
        COORD at = {info.srWindow.Left, (SHORT)(info.srWindow.Top + r)};
        DWORD read = 0;
        if (!ReadConsoleOutputCharacterW(conout, line, (DWORD)cols, at, &read)) read = 0;
        while (read > 0 && (line[read - 1] == L' ' || line[read - 1] == 0)) read--;
        int n = WideCharToMultiByte(CP_UTF8, 0, line, (int)read, utf8 + used, (int)(cap - used - 2), NULL, NULL);
        if (n > 0) used += (size_t)n;
        utf8[used++] = '\n';
    }
    char *encoded = b64_encode((const unsigned char *)utf8, used);
    char header[96];
    int h = snprintf(header, sizeof(header), "screen %d %d %d %d ", rows, cols,
                     info.dwCursorPosition.Y - info.srWindow.Top, info.dwCursorPosition.X - info.srWindow.Left);
    size_t total = (size_t)h + strlen(encoded);
    char *message = (char *)malloc(total + 1);
    memcpy(message, header, (size_t)h);
    memcpy(message + h, encoded, strlen(encoded) + 1);
    reply(message, total);
    free(message);
    free(encoded);
    free(utf8);
    free(line);
}

/* --- main loop ---------------------------------------------------------------------------- */

static int read_line(HANDLE in, char *buffer, size_t size) {
    size_t n = 0;
    for (;;) {
        char c;
        DWORD read = 0;
        if (!ReadFile(in, &c, 1, &read, NULL) || read == 0) return n > 0 ? 1 : 0;
        if (c == '\n') break;
        if (c == '\r') continue;
        if (n + 1 < size) buffer[n++] = c;
    }
    buffer[n] = 0;
    return 1;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) {
        return 1;
    }
    DWORD pid = (DWORD)_wtoi(argv[1]);
    HANDLE in_pipe = GetStdHandle(STD_INPUT_HANDLE);
    out_pipe = GetStdHandle(STD_OUTPUT_HANDLE);
    FreeConsole();
    if (!AttachConsole(pid)) {
        replyf("err cannot attach to the console of process %lu (error %lu)", pid, GetLastError());
        return 2;
    }
    conin = CreateFileW(L"CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    conout = CreateFileW(L"CONOUT$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (conin == INVALID_HANDLE_VALUE || conout == INVALID_HANDLE_VALUE) {
        replyf("err cannot open the console buffers (error %lu)", GetLastError());
        return 3;
    }
    replyf("ready pid=%lu protocol=1", pid);

    char line[65536];
    while (read_line(in_pipe, line, sizeof(line))) {
        if (line[0] == 'k' && line[1] == ' ') {
            if (send_named_key(line + 2)) reply("ok", 2);
            else replyf("err could not press \"%s\" (error %lu)", line + 2, GetLastError());
        } else if (line[0] == 't' && line[1] == ' ') {
            type_text(line + 2);
            reply("ok", 2);
        } else if (line[0] == 's') {
            print_screen();
        } else if (line[0] == 'q') {
            break;
        }
    }
    FreeConsole();
    return 0;
}
