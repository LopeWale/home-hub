# Images for the main README

Already here: `enclosure-overview.png` (assembly overview) and `assembly-viewer.png`
(the interactive assembly page).

To add. Save each with exactly this name, then uncomment its line in `../../README.md`.

| File | What to show |
|---|---|
| `hero.jpg` | The finished Home Hub on the wall, straight on, screen on. |
| `screen-home.png` | Home page: calendar and to-do lists. |
| `screen-cast.png` | Cast page, idle (how to cast and the TV code) or playing. |
| `screen-sports.png` | Sports page with a game selected. |
| `screen-globe.png` | Globe page with a place selected. |
| `admin-page.png` | The admin page on a phone. |
| `print-parts.jpg` | The printed parts laid out before assembly. |
| `build-inside.jpg` | Inside the enclosure with the service lid off: monitor, Pi and cables. |
| `wiring.jpg` | The cables: HDMI, monitor power, touch USB, Pi power. |

Screenshots straight from the Pi (full 1920x1080, no glare), over SSH:

```bash
ssh pi@homehub.local 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/$(id -u) grim /tmp/screen.png'
scp pi@homehub.local:/tmp/screen.png docs/images/screen-home.png
```

**Before you publish a screenshot, check it for personal details:** calendar event
names, to-do items, your home address or pin names on the Globe page, the guest
Wi-Fi password and QR code, the cast TV code, and the admin page token or
Tailscale address. Use sample entries or blur them.

Keep photos under about 1 MB each (JPEG for photos, PNG for screenshots) so the
repository stays small.
