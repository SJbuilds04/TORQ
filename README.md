# TORQ

**T**ilt and **O**rientation **R**otation Controller

Turn a phone into a physical racing-game steering wheel. Tape the phone to a
cardboard disc, turn the disc, and it steers a real PC game.

No app store, no controller, no hardware beyond a piece of cardboard.

```
PHONE  ──wss──►  bridge.js  ──stdin──►  input_driver.py  ──►  GAME
(sensors)         (Node)                 (Windows input)
```

The app itself is plain HTML, CSS and JavaScript — no frameworks, no build
step. The PC side is one Node script and one Python script, both dependency-free.

---

## Files

| File | What it is |
| --- | --- |
| `index.html` | All five screens: landing, controller, settings, demo, connect |
| `style.css` | Design system, dark + light themes, portrait and landscape layouts |
| `app.js` | Sensor maths, filtering, calibration, rendering, WebSocket client |
| `bridge.js` | HTTPS + WebSocket server, launches the input driver |
| `input_driver.py` | Turns steering values into real Windows input events |
| `serve.js` | Static HTTPS server only — the app without game control |
| `test-steering.js` | 40 logic tests — `node test-steering.js` |

---

## Quick start

On the PC:

```bash
node bridge.js
```

It prints an address. On the phone:

1. Join the **same Wi-Fi** as the PC.
2. Open the printed `https://…:8443` address.
3. Accept the certificate warning (**Advanced → Continue**). It is self-signed.
4. Tap **Get Started**, allow motion access.
5. Hold the wheel straight, tap **Calibrate Center**.
6. **Click your game window on the PC** so it has keyboard focus.
7. Drive. Tap **Gas** on the phone if you want continuous throttle.

The bridge prints a live bar so you can see values arriving:

```
  [---------#-----|---------------]  -38   1423 pkt
```

### Important: lock your phone's rotation

As the wheel turns, the phone passes through the angles where iOS and Android
decide to flip the screen. Mid-corner UI rotation is horrible. Turn on rotation
lock (iOS Control Centre, Android quick settings) **before** mounting it.

Steering itself survives a flip — the app rebases its calibration so the value
stays continuous — but the layout jumping around will ruin the feel.

---

## Options

```bash
node bridge.js --keys ad          # use A / D instead of arrow keys
node bridge.js --throttle up      # hold Up permanently, hands-free acceleration
node bridge.js --deadzone 6       # ignore values below 6
node bridge.js --dry-run          # log key events instead of sending them
node bridge.js --no-input         # serve the app only, no game control
```

`--dry-run` is the safe way to check the chain end to end without arrow keys
firing into whatever window you happen to have open.

---

## How the game actually gets steered

There are two output modes. The driver picks the best one available.

### Keyboard (default, zero install)

A key is either down or up, so analog steering comes from **PWM**: at 40% lock
the key is held down for 40% of every 40 ms window. Games poll input far faster
than that, so it reads as proportional steering. Full lock (>90%) holds the key
down continuously instead of pulsing.

Events are sent as **hardware scan codes** via `SendInput`, not virtual keys,
because games using DirectInput or raw input ignore virtual-key-only events.

This works in any game that accepts keyboard steering, which is most of them.
It cannot express fine analog detail the way a real wheel does.

### Gamepad (true analog, needs a driver)

```bash
pip install vgamepad
```

That installs the ViGEmBus driver (admin prompt, possibly a reboot). Once it is
present, `bridge.js` automatically creates a **virtual Xbox 360 controller** and
drives the left stick with the real analog value. Much better than keyboard mode
for racing games.

**Steering only, deliberately.** The virtual pad drives the left stick X axis and
nothing else — no triggers, no buttons, Y stays centred. Throttle and brake stay
on your real keyboard. Confirm with the line printed at startup:

```
  Input driver: gamepad (virtual Xbox 360 left stick X - steering only)
```

### Switching modes from the phone

**Connect → Input Mode** offers Browser / Keyboard / Gamepad. Tapping one
restarts the PC-side driver in place — no terminal, no reconnecting. Your choice
is remembered and re-sent whenever the phone reconnects.

| Mode | Use it for |
| --- | --- |
| **Browser** | Anything running in a browser tab |
| **Keyboard** | Native games that only read the keyboard |
| **Gamepad** | Native games with controller support — best feel |

### Why browser games need their own mode

Two reasons a virtual gamepad cannot work in a browser game:

1. **Most browser games are keyboard-only.** They listen for `keydown` and never
   call the Gamepad API, so a controller is invisible to them.
2. **Browsers hide gamepads until you press a button on one** — an
   anti-fingerprinting measure. Since this pad deliberately has no buttons,
   `navigator.getGamepads()` never reveals it, even to a game that does support
   controllers.

And plain Keyboard mode feels laggy in a browser for a third reason: browser
games almost all *ramp* their steering while a key is held
(`if (keys.left) angle -= 0.05`), and **every release restarts that ramp**.
Fine PWM pulses the key ~33 times a second, so the car never reaches the angle
you asked for — which feels exactly like lag. The 60 Hz animation frame also
aliases against a 33 Hz pulse train.

**Browser mode** fixes this by pulsing rarely and holding early: past roughly a
third of lock the key is simply held down, letting the game's own ramp do the
smoothing it was designed for.

| Steering | Keyboard mode | Browser mode |
| --- | --- | --- |
| 15 | pulses ~40×/sec | pulses ~13×/sec |
| 30 | pulses ~40×/sec | held |
| 50–100 | pulses ~40×/sec | held continuously |

---

## Building the wheel

1. Cut a disc of cardboard roughly 28–32 cm across.
2. Tape the phone flat in the middle, **screen facing you**, top edge up when
   the wheel is straight. Landscape is fine and gets its own layout.
3. Hold it tilted back toward you, anywhere from upright to about 60° of lean.

The one pose that does **not** work is a wheel lying flat like a table. Gravity
then points straight through the screen and can no longer tell how far the phone
has rotated. The app detects this and falls back to compass-based tracking,
which drifts — the sensor panel shows `Tracking Mode: Yaw` when that happens.
Tilt the wheel up and it returns to `Tilt`.

---

## Settings

| Setting | Range | What it does |
| --- | --- | --- |
| Sensitivity | 0.5x – 3x | How fast the value climbs. 3x reaches full lock in a third of the rotation. |
| Dead Zone | 0° – 10° | Rotation near centre that is ignored, so the car does not wander at rest. |
| Max Steering Angle | 30° – 540° | How far you physically turn the cardboard to reach ±100. Past 360° it also shows turns, so 540° = 1.5 turns each way, like a real car. |
| Smoothing | Off – Max | Filter strength. Adaptive, so more smoothing costs far less lag than it used to. |
| Invert Direction | — | Flips left and right if the phone is mounted upside down. |

**Demo Mode** puts a car on a procedural road so you can feel the steering
before wiring it into a real game. **Show Sensor Data** opens a live panel with
raw alpha/beta/gamma, computed angle, update rate and a scrolling graph.

---

## How the angle is measured

The app deliberately does **not** use the compass heading. Absolute headings
drift and change meaning depending on which way your desk faces.

Instead it reconstructs the **gravity vector in the phone's own frame** from the
reported Euler angles, then reads the phone's roll around its screen normal:

```js
gravity = { x: cosβ·sinγ,  y: -sinβ,  z: -cosβ·cosγ }
angle   = atan2(gravity.x, -gravity.y)      // degrees, positive = right
```

That depends only on how the phone sits relative to *down*, so it is immune to
yaw drift. Calibration stores the current roll; every later reading is a delta
from it.

### Unlimited rotation

The raw roll only spans ±180°, so reading it directly would make the wheel snap
to the opposite lock the moment you passed half a turn. Instead each sensor
event contributes a small *delta*, and those are summed:

```js
rollCont += wrap180(roll - rollPrev);   // per event, always well under 180°
angle     = rollCont - rollCenter;       // continuous, unbounded
```

Events arrive every 15–30 ms, so a single delta is never ambiguous. Turn the
wheel three times and the angle reads 1080°, not zero. Nothing downstream wraps.

### Latency

Smoothing normally forces a trade: filter hard and the wheel feels laggy, filter
lightly and it jitters at rest. This uses a **One Euro filter**, which raises its
own cutoff frequency in proportion to how fast the signal is moving. Held still,
it filters hard and kills sensor noise. Mid-turn, it barely filters at all.

A second, deliberately short interpolation in the `requestAnimationFrame` loop
only bridges the gap between sensor events. Both use `1 - exp(-dt/tau)`, so they
behave identically whether the sensor reports at 60 Hz or stutters at 10 Hz.

The remaining latency is the keyboard PWM window (30 ms worst case). Gamepad
mode removes that entirely — see below.

---

## Tests

```bash
node test-steering.js
```

40 tests covering permission and sensor-failure states, calibration from
arbitrary poses, left/right/centre behaviour, dead zone, sensitivity,
normalisation, filter stability, and the flat-phone fallback. `app.js` exports
its pure maths and skips all DOM setup when there is no `document`, so the tests
run against the real shipping code rather than a copy.

---

## Troubleshooting

**"Sensors Not Available" / no data.** You are on `http://`. The URL must be
`https://`. Motion sensors are a secure-context feature on both platforms.

**Phone connects but the game does not move.** The game must be the **focused
window** — input goes wherever Windows is currently typing. Check the bridge is
showing packets arriving, then click the game and try again.

**Steering works in a menu but not in-game.** Some games only read DirectInput
or XInput. Install `vgamepad` for true gamepad mode.

**Link Status stuck on "Not connected".** You opened the page from somewhere
other than the bridge (a file:// path, or a different server). The WebSocket
points at whatever host served the page, so it must be the bridge's address.

**Certificate warning every time.** Expected for a self-signed cert. If the
PC's IP changes, delete `.certs/` and restart so a new one is generated.

**iPhone never asks for permission.** iOS only allows the request from a real
tap, once per page load. Reload and tap **Get Started** again. If you denied it
before, enable Settings → Safari → Motion & Orientation Access.

**A key got stuck down.** The app releases everything when it is backgrounded or
disconnected. If something slips through, press the arrow key once manually, or
restart `bridge.js`.

**Value drifts when the wheel is still.** Raise the dead zone to 4–6°, or
recalibrate. If the sensor panel shows `Tracking Mode: Yaw`, the wheel is
mounted too flat — tilt it up.

**Steering feels laggy.** Lower Smoothing. **Jittery?** Raise it. If it still
feels soft, the remaining lag is the keyboard PWM window — install `vgamepad`
for true analog output, which removes it.

**Turning a long way behaves oddly.** Raise Max Steering Angle. If it is set to
90° and you turn 200°, the value has been pinned at full lock for most of that
travel — which is correct, but feels like nothing is happening.

**Left and right are swapped.** Turn on Invert Direction in Settings.
