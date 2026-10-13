/*
 * voicecode-input-wayland — Wayland mouse injection helper for the VoiceCode agent.
 *
 * Uses the XDG Desktop Portal RemoteDesktop interface to obtain an EIS (emulated
 * input server) socket from the compositor, then emits pointer events with libei.
 * The compositor shows the user a consent dialog the first time; the portal's
 * restore token is saved (--token-file) so later runs connect without asking.
 *
 * Same stdin/stdout line protocol as the other helpers:
 *   m <dx> <dy> | d <l|r|m> | u <l|r|m> | s <dx> <dy> | p | q
 * `p` is unsupported (Wayland does not expose the global pointer position).
 *
 * Requires xdg-desktop-portal with RemoteDesktop v2 (ConnectToEIS), e.g. GNOME 46+
 * or KDE Plasma 6.1+.
 *
 * Build: gcc -O2 -o voicecode-input-wayland voicecode-input-wayland.c \
 *          $(pkg-config --cflags --libs gio-2.0 gio-unix-2.0 libei-1.0)
 * (Debian/Ubuntu 24.04+: apt install libglib2.0-dev libei-dev)
 */
#include <errno.h>
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <libei.h>
#include <linux/input-event-codes.h>
#include <poll.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PORTAL_BUS "org.freedesktop.portal.Desktop"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define REMOTE_DESKTOP "org.freedesktop.portal.RemoteDesktop"
#define DEVICE_POINTER 2u
#define PERSIST_UNTIL_REVOKED 2u

enum { BTN_IDX_LEFT, BTN_IDX_RIGHT, BTN_IDX_MIDDLE, BTN_COUNT };
static const uint32_t BUTTON_CODES[BTN_COUNT] = {BTN_LEFT, BTN_RIGHT, BTN_MIDDLE};

static GDBusConnection *bus;
static char *sender_path; /* unique bus name with ':' dropped and '.' -> '_' */
static unsigned token_counter;

static struct ei *ei;
static struct ei_device *pointer_dev, *button_dev, *scroll_dev;
static bool emulating;
static uint32_t emulation_sequence;
static bool pressed[BTN_COUNT];
static bool announced;

static void reply(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stdout, fmt, args);
    va_end(args);
    fputc('\n', stdout);
    fflush(stdout);
}

static void die(int code, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fputc('\n', stderr);
    exit(code);
}

/* ---------------------------------------------------------------- portal ---- */

struct request_state {
    bool done;
    uint32_t response;
    GVariant *results;
};

static void on_response(GDBusConnection *c, const char *sender, const char *path,
                        const char *iface, const char *signal, GVariant *params, gpointer data) {
    (void)c, (void)sender, (void)path, (void)iface, (void)signal;
    struct request_state *state = data;
    g_variant_get(params, "(u@a{sv})", &state->response, &state->results);
    state->done = true;
}

/*
 * Calls a portal method that answers through an org.freedesktop.portal.Request object.
 * `options` must not contain handle_token; one is added here. The Response signal is
 * subscribed before the call so a fast reply cannot be missed.
 * Returns the results vardict (caller unrefs) or NULL if the user cancelled/failed.
 */
static GVariant *portal_request(const char *method, const char *session, GVariantBuilder *options,
                                const char *extra_string_arg) {
    char token[32];
    snprintf(token, sizeof(token), "voicecode%u", ++token_counter);
    char *request_path = g_strdup_printf("%s/request/%s/%s", PORTAL_PATH, sender_path, token);
    g_variant_builder_add(options, "{sv}", "handle_token", g_variant_new_string(token));

    /* The AddMatch for this subscription is sent before the method call on the same
     * connection, so the bus cannot deliver the Response before we listen for it. */
    struct request_state state = {0};
    guint sub = g_dbus_connection_signal_subscribe(
        bus, PORTAL_BUS, "org.freedesktop.portal.Request", "Response", request_path, NULL,
        G_DBUS_SIGNAL_FLAGS_NONE, on_response, &state, NULL);

    GVariant *params;
    if (session && extra_string_arg)
        params = g_variant_new("(osa{sv})", session, extra_string_arg, options);
    else if (session)
        params = g_variant_new("(oa{sv})", session, options);
    else
        params = g_variant_new("(a{sv})", options);

    GError *error = NULL;
    GVariant *ret = g_dbus_connection_call_sync(bus, PORTAL_BUS, PORTAL_PATH, REMOTE_DESKTOP, method,
                                                params, G_VARIANT_TYPE("(o)"),
                                                G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);
    if (!ret) die(5, "%s failed: %s", method, error->message);
    g_variant_unref(ret);

    while (!state.done) g_main_context_iteration(NULL, TRUE);

    g_dbus_connection_signal_unsubscribe(bus, sub);
    g_free(request_path);

    if (state.response != 0) {
        if (state.results) g_variant_unref(state.results);
        return NULL;
    }
    return state.results;
}

static uint32_t portal_version(void) {
    GVariant *ret = g_dbus_connection_call_sync(
        bus, PORTAL_BUS, PORTAL_PATH, "org.freedesktop.DBus.Properties", "Get",
        g_variant_new("(ss)", REMOTE_DESKTOP, "version"), G_VARIANT_TYPE("(v)"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL);
    if (!ret) return 0;
    GVariant *inner;
    g_variant_get(ret, "(v)", &inner);
    uint32_t version = g_variant_get_uint32(inner);
    g_variant_unref(inner);
    g_variant_unref(ret);
    return version;
}

static char *read_token(const char *file) {
    char *contents = NULL;
    if (!file || !g_file_get_contents(file, &contents, NULL, NULL)) return NULL;
    g_strstrip(contents);
    if (!*contents) {
        g_free(contents);
        return NULL;
    }
    return contents;
}

static void write_token(const char *file, const char *token) {
    if (!file || !token) return;
    GError *error = NULL;
    if (!g_file_set_contents_full(file, token, -1, G_FILE_SET_CONTENTS_CONSISTENT, 0600, &error)) {
        fprintf(stderr, "could not save restore token: %s\n", error->message);
        g_error_free(error);
    }
}

/* Runs the portal handshake and returns a connected EIS socket fd. */
static int connect_eis(const char *token_file) {
    GError *error = NULL;
    bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (!bus) die(2, "cannot connect to the session bus: %s", error->message);

    sender_path = g_strdup(g_dbus_connection_get_unique_name(bus) + 1);
    for (char *p = sender_path; *p; p++)
        if (*p == '.') *p = '_';

    uint32_t version = portal_version();
    if (version < 2) die(4, "RemoteDesktop portal v2 (ConnectToEIS) not available (found v%u)", version);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&opts, "{sv}", "session_handle_token", g_variant_new_string("voicecode"));
    GVariant *res = portal_request("CreateSession", NULL, &opts, NULL);
    if (!res) die(6, "CreateSession was refused");
    char *session = NULL;
    g_variant_lookup(res, "session_handle", "s", &session);
    g_variant_unref(res);
    if (!session) die(6, "CreateSession returned no session handle");

    g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&opts, "{sv}", "types", g_variant_new_uint32(DEVICE_POINTER));
    g_variant_builder_add(&opts, "{sv}", "persist_mode", g_variant_new_uint32(PERSIST_UNTIL_REVOKED));
    char *restore = read_token(token_file);
    if (restore) g_variant_builder_add(&opts, "{sv}", "restore_token", g_variant_new_string(restore));
    res = portal_request("SelectDevices", session, &opts, NULL);
    g_free(restore);
    if (!res) die(6, "SelectDevices was refused");
    g_variant_unref(res);

    g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
    res = portal_request("Start", session, &opts, "");
    if (!res) die(7, "remote control was not allowed by the user");
    char *new_token = NULL;
    if (g_variant_lookup(res, "restore_token", "s", &new_token)) {
        write_token(token_file, new_token);
        g_free(new_token);
    }
    g_variant_unref(res);

    GUnixFDList *fds = NULL;
    g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
    GVariant *ret = g_dbus_connection_call_with_unix_fd_list_sync(
        bus, PORTAL_BUS, PORTAL_PATH, REMOTE_DESKTOP, "ConnectToEIS",
        g_variant_new("(oa{sv})", session, &opts), G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NONE,
        -1, NULL, &fds, NULL, &error);
    if (!ret) die(8, "ConnectToEIS failed: %s", error->message);
    gint32 handle;
    g_variant_get(ret, "(h)", &handle);
    int fd = g_unix_fd_list_get(fds, handle, &error);
    if (fd < 0) die(8, "ConnectToEIS returned no fd: %s", error->message);
    g_variant_unref(ret);
    g_object_unref(fds);
    g_free(session);
    return fd;
}

/* ------------------------------------------------------------------ libei ---- */

static void frame(struct ei_device *dev) { ei_device_frame(dev, ei_now(ei)); }

static void maybe_announce(void) {
    if (!announced && emulating && pointer_dev) {
        announced = true;
        reply("ready platform=wayland backend=libei protocol=1");
    }
}

static void take_device(struct ei_device **slot, struct ei_device *dev) {
    if (*slot) return;
    *slot = ei_device_ref(dev);
}

static void drop_device(struct ei_device **slot, struct ei_device *dev) {
    if (*slot == dev) {
        ei_device_unref(*slot);
        *slot = NULL;
    }
}

static void handle_ei_events(void) {
    ei_dispatch(ei);
    struct ei_event *event;
    while ((event = ei_get_event(ei))) {
        struct ei_device *dev = ei_event_get_device(event);
        switch (ei_event_get_type(event)) {
            case EI_EVENT_DISCONNECT:
                die(9, "the compositor ended the remote control session");
                break;
            case EI_EVENT_SEAT_ADDED:
                ei_seat_bind_capabilities(ei_event_get_seat(event), EI_DEVICE_CAP_POINTER,
                                          EI_DEVICE_CAP_BUTTON, EI_DEVICE_CAP_SCROLL, NULL);
                break;
            case EI_EVENT_DEVICE_ADDED:
                if (ei_device_has_capability(dev, EI_DEVICE_CAP_POINTER)) take_device(&pointer_dev, dev);
                if (ei_device_has_capability(dev, EI_DEVICE_CAP_BUTTON)) take_device(&button_dev, dev);
                if (ei_device_has_capability(dev, EI_DEVICE_CAP_SCROLL)) take_device(&scroll_dev, dev);
                break;
            case EI_EVENT_DEVICE_RESUMED:
                ei_device_start_emulating(dev, ++emulation_sequence);
                emulating = true;
                maybe_announce();
                break;
            case EI_EVENT_DEVICE_PAUSED:
                emulating = false;
                break;
            case EI_EVENT_DEVICE_REMOVED:
                drop_device(&pointer_dev, dev);
                drop_device(&button_dev, dev);
                drop_device(&scroll_dev, dev);
                break;
            default:
                break;
        }
        ei_event_unref(event);
    }
}

static void button(int idx, bool down) {
    if (pressed[idx] == down || !button_dev || !emulating) return;
    pressed[idx] = down;
    ei_device_button_button(button_dev, BUTTON_CODES[idx], down);
    frame(button_dev);
}

static void release_all(void) {
    for (int i = 0; i < BTN_COUNT; i++)
        if (pressed[i]) button(i, false);
}

static int parse_button(char c) {
    switch (c) {
        case 'l': return BTN_IDX_LEFT;
        case 'r': return BTN_IDX_RIGHT;
        case 'm': return BTN_IDX_MIDDLE;
        default: return -1;
    }
}

/* Returns false when the agent asked us to quit. */
static bool handle_command(const char *line) {
    long a = 0, b = 0;
    char c = 0;
    switch (line[0]) {
        case 'm':
            if (sscanf(line + 1, "%ld %ld", &a, &b) == 2 && pointer_dev && emulating) {
                ei_device_pointer_motion(pointer_dev, (double)a, (double)b);
                frame(pointer_dev);
            }
            break;
        case 'd':
        case 'u':
            if (sscanf(line + 1, " %c", &c) == 1 && parse_button(c) >= 0)
                button(parse_button(c), line[0] == 'd');
            break;
        case 's':
            /* libei discrete scroll uses the same 120-per-detent units as the agent. */
            if (sscanf(line + 1, "%ld %ld", &a, &b) == 2 && scroll_dev && emulating) {
                ei_device_scroll_discrete(scroll_dev, (int32_t)a, (int32_t)b);
                frame(scroll_dev);
            }
            break;
        case 'p':
            reply("err pointer position is not available on Wayland");
            break;
        case 'q':
            return false;
        default:
            break;
    }
    return true;
}

int main(int argc, char **argv) {
    const char *token_file = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--token-file") == 0 && i + 1 < argc) token_file = argv[++i];
    }

    int eis_fd = connect_eis(token_file);

    ei = ei_new_sender(NULL);
    ei_configure_name(ei, "voicecode-agent");
    if (ei_setup_backend_fd(ei, eis_fd) != 0) die(8, "libei could not use the EIS socket");

    char buffer[4096];
    size_t used = 0;
    struct pollfd fds[2] = {{.fd = ei_get_fd(ei), .events = POLLIN}, {.fd = STDIN_FILENO, .events = POLLIN}};

    for (;;) {
        if (poll(fds, 2, -1) < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (fds[0].revents & POLLIN) handle_ei_events();
        if (fds[1].revents & (POLLIN | POLLHUP)) {
            ssize_t n = read(STDIN_FILENO, buffer + used, sizeof(buffer) - used - 1);
            if (n <= 0) break; /* EOF: the agent is gone */
            used += (size_t)n;
            buffer[used] = '\0';
            char *start = buffer, *newline;
            while ((newline = strchr(start, '\n'))) {
                *newline = '\0';
                if (!handle_command(start)) goto quit;
                start = newline + 1;
            }
            used = strlen(start);
            memmove(buffer, start, used);
            if (used >= sizeof(buffer) - 1) used = 0; /* drop an absurdly long line */
        }
    }
quit:
    release_all();
    if (pointer_dev && emulating) ei_device_stop_emulating(pointer_dev);
    ei_unref(ei);
    return 0;
}
