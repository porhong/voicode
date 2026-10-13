# Wayland input helper

Wayland deliberately has no global input-injection API like XTest. The agent supports
two backends and tries them in this order:

| Backend                                                                  | Requirements                                                                                                    | Notes                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voicecode-input-wayland` — XDG Desktop Portal `RemoteDesktop` + `libei` | `xdg-desktop-portal` with RemoteDesktop v2 (`ConnectToEIS`): GNOME 46+, KDE Plasma 6.1+; `libei` 1.x at runtime | The standards-based path. The desktop shows a consent dialog the first time; the portal's restore token is saved to `<agent home>/wayland-restore-token`, so later starts connect silently until you revoke it in your desktop's privacy settings. |
| [`ydotool`](https://github.com/ReimuNotMoe/ydotool) via `/dev/uinput`    | `ydotoold` running, write access to `/dev/uinput`                                                               | Works on any compositor without a dialog, but needs uinput permissions.                                                                                                                                                                            |

The portal helper cannot report the pointer position (Wayland does not expose it), so
`mouse.position` requests fail on Wayland; movement, buttons and scrolling work.

## How the helper works

1. Connects to the session bus and checks the RemoteDesktop portal is version 2+.
2. `CreateSession` → `SelectDevices(types=POINTER, persist_mode=2, restore_token)` →
   `Start` (consent dialog unless the restore token is still valid) → saves the new
   restore token.
3. `ConnectToEIS` returns a socket that is handed to `ei_setup_backend_fd()`; the helper
   binds the pointer, button and scroll capabilities and starts emulating when the
   compositor resumes the devices, then prints `ready`.
4. Commands from the agent map to `ei_device_pointer_motion`, `ei_device_button_button`
   and `ei_device_scroll_discrete` (which uses the same 120-units-per-notch scale as the
   agent). On `q` or EOF it releases held buttons and exits.

## Building

```bash
sudo apt install libglib2.0-dev libei-dev pkg-config   # Ubuntu 24.04+ (Fedora: glib2-devel libei-devel)
node scripts/build-native.mjs --helper wayland
```

Release builds are produced by CI on Ubuntu 24.04 for x64 and arm64.
