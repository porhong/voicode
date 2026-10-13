# Wayland input adapter

Wayland deliberately has no global input-injection API like XTest. There are two ways
to drive the pointer:

| Approach                                                              | Status                                    | Notes                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`ydotool`](https://github.com/ReimuNotMoe/ydotool) via `/dev/uinput` | **Supported** (`mouse.driver: "ydotool"`) | Works on every compositor. Requires the `ydotoold` daemon and write access to `/dev/uinput` (usually the `input` group or a udev rule). Pointer position cannot be queried.                                                                                                    |
| XDG Desktop Portal `RemoteDesktop` + `libei`                          | Planned                                   | The standards-based path. The compositor shows the user a consent dialog and returns an EIS socket; the helper then emits pointer events with `libei`. Needs `xdg-desktop-portal` ≥ 1.18 and a backend with RemoteDesktop/`ConnectToEIS` support (GNOME 46+, KDE Plasma 6.1+). |

## Planned portal helper

The portal helper will be a small C program (`voicecode-input-portal`) speaking the same
stdin/stdout line protocol as the Windows and X11 helpers, so the agent needs no
changes beyond a new entry in `resolve-driver.ts`:

1. `CreateSession` → `SelectDevices(types=POINTER, persist_mode=2)` → `Start` on
   `org.freedesktop.portal.RemoteDesktop` (shows the consent dialog once; the restore
   token is cached in the agent config dir so later runs don't prompt).
2. `ConnectToEIS` → hand the returned fd to `ei_setup_backend_fd()`.
3. Bind the `EI_DEVICE_CAP_POINTER`, `EI_DEVICE_CAP_BUTTON` and `EI_DEVICE_CAP_SCROLL`
   capabilities and map `m`/`d`/`u`/`s` commands to `ei_device_pointer_motion`,
   `ei_device_button_button` and `ei_device_scroll_discrete`.
4. On `q`/EOF release held buttons, `ei_device_stop_emulating`, close the session.

Dependencies: `libportal` (or raw D-Bus via `sd-bus`) and `libei` ≥ 1.0.
