/*
 * voicecode-input-x11 — X11/XTest mouse injection helper for the VoiceCode agent.
 *
 * Same stdin/stdout line protocol as the Windows helper:
 *   m <dx> <dy> | d <l|r|m> | u <l|r|m> | s <dx> <dy> | p | q
 * Prints "ready platform=x11 ..." once connected to the display.
 *
 * Build: gcc -O2 -o voicecode-input-x11 voicecode-input-x11.c -lX11 -lXtst
 * (Debian/Ubuntu: apt install libx11-dev libxtst-dev)
 */
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_COUNT };
static const unsigned int LOGICAL[BTN_COUNT] = {1, 3, 2};

static Display *display;
static int pressed[BTN_COUNT];
static long wheel_x, wheel_y; /* accumulated wheel units, 120 per notch */

static void reply(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stdout, fmt, args);
    va_end(args);
    fputc('\n', stdout);
    fflush(stdout);
}

/*
 * XTest injects physical buttons. Map the logical button we want (1 = primary) back to
 * the physical button the user's pointer mapping assigns to it, so left-handed setups
 * still get a primary click.
 */
static unsigned int physical_button(unsigned int logical) {
    unsigned char map[256];
    int n = XGetPointerMapping(display, map, sizeof(map));
    for (int i = 0; i < n; i++) {
        if (map[i] == logical) return (unsigned int)(i + 1);
    }
    return logical;
}

static void click(unsigned int physical) {
    XTestFakeButtonEvent(display, physical, True, CurrentTime);
    XTestFakeButtonEvent(display, physical, False, CurrentTime);
}

static void button(int b, int down) {
    if (pressed[b] == down) return;
    pressed[b] = down;
    XTestFakeButtonEvent(display, physical_button(LOGICAL[b]), down ? True : False, CurrentTime);
    XFlush(display);
}

static void release_all(void) {
    for (int i = 0; i < BTN_COUNT; i++) {
        if (pressed[i]) button(i, 0);
    }
}

static void scroll(long dx, long dy) {
    /* X11 wheels are discrete: buttons 4/5 = up/down, 6/7 = left/right. */
    wheel_y += dy;
    wheel_x += dx;
    while (wheel_y >= 120) { click(physical_button(5)); wheel_y -= 120; }
    while (wheel_y <= -120) { click(physical_button(4)); wheel_y += 120; }
    while (wheel_x >= 120) { click(physical_button(7)); wheel_x -= 120; }
    while (wheel_x <= -120) { click(physical_button(6)); wheel_x += 120; }
    XFlush(display);
}

static int parse_button(char c) {
    switch (c) {
        case 'l': return BTN_LEFT;
        case 'r': return BTN_RIGHT;
        case 'm': return BTN_MIDDLE;
        default: return -1;
    }
}

int main(void) {
    int event_base, error_base, major, minor;
    char line[128];

    display = XOpenDisplay(NULL);
    if (!display) {
        fprintf(stderr, "cannot open X display (is DISPLAY set?)\n");
        return 2;
    }
    if (!XTestQueryExtension(display, &event_base, &error_base, &major, &minor)) {
        fprintf(stderr, "XTEST extension is not available\n");
        return 3;
    }
    reply("ready platform=x11 xtest=%d.%d protocol=1", major, minor);

    while (fgets(line, sizeof(line), stdin)) {
        long a = 0, b = 0;
        char c = 0;
        switch (line[0]) {
            case 'm':
                if (sscanf(line + 1, "%ld %ld", &a, &b) == 2) {
                    XTestFakeRelativeMotionEvent(display, (int)a, (int)b, CurrentTime);
                    XFlush(display);
                }
                break;
            case 'd':
            case 'u':
                if (sscanf(line + 1, " %c", &c) == 1 && parse_button(c) >= 0) button(parse_button(c), line[0] == 'd');
                break;
            case 's':
                if (sscanf(line + 1, "%ld %ld", &a, &b) == 2) scroll(a, b);
                break;
            case 'p': {
                Window root, child;
                int rx, ry, wx, wy;
                unsigned int mask;
                if (XQueryPointer(display, DefaultRootWindow(display), &root, &child, &rx, &ry, &wx, &wy, &mask)) {
                    reply("pos %d %d", rx, ry);
                } else {
                    reply("err pointer is on another screen");
                }
                break;
            }
            case 'q':
                release_all();
                XCloseDisplay(display);
                return 0;
            default:
                break;
        }
    }
    release_all();
    XCloseDisplay(display);
    return 0;
}
