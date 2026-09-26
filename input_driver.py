"""
=============================================================================
TORQ — Windows input driver.

Reads steering values (-100..100, one per line) on stdin and turns them into
real input events that PC games accept.

Two output modes, picked automatically:

  gamepad   Needs `pip install vgamepad` (which installs the ViGEmBus driver).
            Creates a virtual Xbox 360 controller and drives the left stick.
            True analog steering — this is the good one.

  keyboard  Zero install, works right now. Because a key is either down or up,
            analog steering is produced with PWM: at 40% lock the key is held
            down 40% of every 40 ms window. Games sample input far faster than
            that, so it reads as proportional steering.

Usage:
    python input_driver.py [--keys arrows|ad] [--mode auto|keyboard|gamepad]
                           [--throttle KEY] [--deadzone N]

Keys go to whatever window has focus, so the game must be the active window.
=============================================================================
"""

import sys
import time
import threading
import argparse
import ctypes
from ctypes import wintypes

# ---------------------------------------------------------------------------
# Win32 SendInput
# ---------------------------------------------------------------------------

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD),
                ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG),
                ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD),
                ("wParamL", wintypes.WORD),
                ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


INPUT_KEYBOARD = 1
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT

# Hardware scan codes. Games that read DirectInput / raw input ignore
# virtual-key-only events, so everything below is sent as a scan code.
SCAN = {
    "left":  (0x4B, True),    # extended
    "right": (0x4D, True),    # extended
    "up":    (0x48, True),    # extended
    "down":  (0x50, True),    # extended
    "a":     (0x1E, False),
    "d":     (0x20, False),
    "w":     (0x11, False),
    "s":     (0x1F, False),
    "space": (0x39, False),
}


DRY_RUN = False


def send_key(name, down):
    """Press or release one key by hardware scan code."""
    if name not in SCAN:
        return
    if DRY_RUN:
        sys.stdout.write("KEY %s %s\n" % (name, "down" if down else "up"))
        sys.stdout.flush()
        return
    scan, extended = SCAN[name]
    flags = KEYEVENTF_SCANCODE
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    if not down:
        flags |= KEYEVENTF_KEYUP

    inp = INPUT(type=INPUT_KEYBOARD,
                ki=KEYBDINPUT(wVk=0, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=0))
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


# ---------------------------------------------------------------------------
# Output backends
# ---------------------------------------------------------------------------

class KeyboardOutput:
    """
    Proportional steering from on/off keys, via PWM.

    Two tunings, because native and browser games want opposite things:

    keyboard  Native games poll input very fast (often 1 kHz), so a short
              PWM window reads as a clean analog value. Fine control, and
              the pulsing is invisible to the game.

    browser   Browser games are written for a key you simply HOLD. Nearly all
              of them ramp steering while the key is down —
              `if (keys.left) angle -= 0.05` — and every release restarts
              that ramp from zero. Short pulses therefore never let the car
              reach the angle you asked for, which feels exactly like lag.
              They also sample input only once per animation frame (60 Hz),
              so a ~33 Hz pulse train aliases badly.

              So here we pulse rarely and hold early: past half lock the key
              is simply held down, letting the game's own ramp do the
              smoothing it was designed to do.
    """

    PROFILES = {
        'keyboard': dict(period=0.030, hold_at=0.90, on_bias=0.00),
        'browser':  dict(period=0.090, hold_at=0.50, on_bias=0.35),
    }

    TICK = 0.002        # how finely we slice the duty window

    def __init__(self, left_key, right_key, deadzone, profile='keyboard', throttle_key=None):
        p = self.PROFILES.get(profile, self.PROFILES['keyboard'])
        self.period = p['period']
        self.hold_at = p['hold_at']
        self.on_bias = p['on_bias']
        self.mode = profile

        self.left_key = left_key
        self.right_key = right_key
        self.deadzone = deadzone
        self.throttle_key = throttle_key
        self.value = 0.0
        self.running = True
        self.down = {left_key: False, right_key: False}
        self.throttle_down = False
        self.name = ("browser-tuned keyboard (%s / %s)" if profile == 'browser'
                     else "keyboard (%s / %s)") % (left_key, right_key)

    def set_value(self, v):
        self.value = v

    def _hold(self, key, want_down):
        if self.down.get(key, False) != want_down:
            send_key(key, want_down)
            self.down[key] = want_down

    def set_throttle(self, on):
        if not self.throttle_key:
            return
        if on != self.throttle_down:
            send_key(self.throttle_key, on)
            self.throttle_down = on

    def run(self):
        start = time.perf_counter()
        while self.running:
            now = time.perf_counter()
            v = self.value
            mag = abs(v)

            if mag <= self.deadzone:
                self._hold(self.left_key, False)
                self._hold(self.right_key, False)
            else:
                duty = (mag - self.deadzone) / max(100.0 - self.deadzone, 1.0)
                duty = min(max(duty, 0.0), 1.0)

                # Lift the floor so the first movement past the dead zone is
                # already a usable hold rather than a 2% flicker the game
                # cannot act on.
                if self.on_bias > 0:
                    duty = self.on_bias + (1.0 - self.on_bias) * duty

                if duty >= self.hold_at:
                    on = True           # hold it down; let the game ramp
                else:
                    phase = ((now - start) % self.period) / self.period
                    on = phase < duty

                if v < 0:
                    self._hold(self.right_key, False)
                    self._hold(self.left_key, on)
                else:
                    self._hold(self.left_key, False)
                    self._hold(self.right_key, on)

            time.sleep(self.TICK)

        self.release()

    def release(self):
        for k in list(self.down):
            if self.down[k]:
                send_key(k, False)
                self.down[k] = False
        self.set_throttle(False)


class GamepadOutput:
    """
    True analog steering through a virtual Xbox 360 left stick.

    STEERING ONLY, by design. Nothing else on the pad is ever driven: no
    triggers, no buttons, Y stays centred. Throttle, brake and everything
    else stay on the real keyboard where the user wants them.
    """

    def __init__(self, deadzone, throttle_key=None):
        import vgamepad as vg
        self.vg = vg
        self.pad = vg.VX360Gamepad()
        self.deadzone = deadzone
        self.value = 0.0
        self.running = True
        self.mode = 'gamepad'
        self.name = "gamepad (virtual Xbox 360 left stick X - steering only)"

    def set_value(self, v):
        self.value = v

    def set_throttle(self, on):
        pass    # intentionally ignored: the phone only steers

    def run(self):
        while self.running:
            v = self.value
            if abs(v) <= self.deadzone:
                x = 0.0
            else:
                span = max(100.0 - self.deadzone, 1.0)
                x = (abs(v) - self.deadzone) / span
                x = min(x, 1.0) * (1.0 if v > 0 else -1.0)

            self.pad.left_joystick_float(x_value_float=x, y_value_float=0.0)
            self.pad.update()
            time.sleep(0.008)

        self.release()

    def release(self):
        try:
            self.pad.reset()
            self.pad.update()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keys", default="arrows", choices=["arrows", "ad"])
    ap.add_argument("--mode", default="auto",
                    choices=["auto", "keyboard", "gamepad", "browser"])
    ap.add_argument("--throttle", default="", help="key held while driving, e.g. up or w")
    ap.add_argument("--deadzone", type=float, default=4.0)
    ap.add_argument("--dry-run", action="store_true",
                    help="log key events instead of sending them (for testing)")
    args = ap.parse_args()

    global DRY_RUN
    DRY_RUN = args.dry_run
    if DRY_RUN:
        log("INFO dry run - no real key events will be sent")
        # A virtual pad would emit for real, so fall back to keys — but only
        # from the gamepad-capable modes. 'browser' is a keyboard profile and
        # must keep its own tuning, or it cannot be tested at all.
        if args.mode in ("auto", "gamepad"):
            args.mode = "keyboard"

    left, right = ("left", "right") if args.keys == "arrows" else ("a", "d")
    throttle = args.throttle.strip().lower() or None

    out = None
    if args.mode in ("auto", "gamepad"):
        try:
            out = GamepadOutput(args.deadzone, throttle)
        except Exception as e:
            if args.mode == "gamepad":
                log("ERROR gamepad mode unavailable: %s" % e)
                return 1
            log("INFO vgamepad not available (%s) - using keyboard" % type(e).__name__)

    if out is None:
        profile = 'browser' if args.mode == 'browser' else 'keyboard'
        out = KeyboardOutput(left, right, args.deadzone, profile, throttle)

    # The bridge parses this: READY|<effective mode>|<human description>
    log("READY|%s|%s" % (out.mode, out.name))

    worker = threading.Thread(target=out.run, daemon=True)
    worker.start()

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            if line == "QUIT":
                break
            if line == "THROTTLE ON":
                out.set_throttle(True)
                continue
            if line == "THROTTLE OFF":
                out.set_throttle(False)
                continue
            if line == "RELEASE":
                out.set_value(0.0)
                continue
            try:
                out.set_value(float(line))
            except ValueError:
                pass
    except KeyboardInterrupt:
        pass
    finally:
        out.running = False
        time.sleep(0.08)
        out.release()
        log("STOPPED")

    return 0


if __name__ == "__main__":
    sys.exit(main())
