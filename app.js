/* =========================================================================
   TORQ — Tilt and Orientation Rotation Controller
   Vanilla JS, no dependencies, no backend.

   Architecture
     1. SteeringMath  — pure, side-effect-free maths (also exported for Node tests)
     2. Sensors       — DeviceOrientation plumbing + permission handling
     3. Engine        — calibration, filtering, the rAF loop, value output
     4. Transport     — sendSteeringValue(): the future WebSocket seam
     5. UI            — views, controls, wheel/gauge rendering, demo, debug panel

   How the angle is derived (this is the important part):
   We do NOT use the compass heading. We reconstruct the device's gravity
   vector from alpha/beta/gamma and read the phone's *roll around its own
   screen normal* from it. That number is immune to yaw drift and to which
   way the room is facing. Calibration simply stores the current roll and
   everything downstream is a delta from it.

   If the phone is mounted nearly flat (gravity pointing straight through the
   screen) roll becomes undefined, so we crossfade to a relative-alpha yaw
   measurement. The crossfade is weighted by how much gravity still lies in
   the screen plane.
   ========================================================================= */

(function (global) {
  'use strict';

  /* =====================================================================
     1. PURE MATHS
     ===================================================================== */

  var RAD = Math.PI / 180;
  var DEG = 180 / Math.PI;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Wrap any angle into [-180, 180). Note 180 folds to -180. */
  function wrap180(deg) {
    var a = (deg + 180) % 360;
    if (a < 0) a += 360;
    return a - 180;
  }

  /**
   * Gravity direction expressed in the DEVICE frame, from W3C euler angles.
   * Returns a unit vector pointing the way gravity pulls, in device axes
   * (+x = right edge, +y = top edge, +z = out of the screen).
   *
   * Derived from the spec's ZXY intrinsic rotation matrix R (device -> world):
   * gravity_world = (0,0,-1), so gravity_device = Rᵀ·(0,0,-1) = -R[2][*].
   */
  function gravityFromEuler(alpha, beta, gamma) {
    var b = (beta || 0) * RAD;
    var g = (gamma || 0) * RAD;
    var cB = Math.cos(b), sB = Math.sin(b);
    var cG = Math.cos(g), sG = Math.sin(g);
    return { x: cB * sG, y: -sB, z: -cB * cG };
  }

  /** How much of gravity lies in the screen plane: 1 = phone upright, 0 = flat. */
  function tiltMagnitude(gv) { return Math.hypot(gv.x, gv.y); }

  /**
   * Roll of the phone around its own screen normal, in degrees.
   * 0 = the calibrated "screen upright" pose, positive = clockwise from the
   * driver's point of view = steering RIGHT.
   */
  function rollFromGravity(gv) { return Math.atan2(gv.x, -gv.y) * DEG; }

  /**
   * One step of yaw change, for the near-flat-phone fallback.
   * Screen-up and screen-down flip the apparent direction, hence the gz sign.
   * Deliberately an *increment*, not an absolute offset, so it accumulates
   * across unlimited rotation just like the tilt path does.
   */
  function yawIncrement(alpha, alphaPrev, gz) {
    if (alpha == null || alphaPrev == null) return 0;
    return wrap180(alpha - alphaPrev) * (gz < 0 ? -1 : 1);
  }

  /**
   * Weight for the gravity-based roll. 1 = trust roll completely,
   * 0 = phone is too flat, fall back to yaw. Smoothstep between.
   */
  function blendWeight(tilt, lo, hi) {
    lo = (lo == null) ? 0.20 : lo;
    hi = (hi == null) ? 0.50 : hi;
    var t = clamp((tilt - lo) / (hi - lo), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Crossfade two angles along the shortest arc between them. */
  function blendAngle(from, to, w) { return from + wrap180(to - from) * w; }

  /** Subtract the dead zone, keeping the sign and collapsing the centre to 0. */
  function applyDeadZone(angle, deadZone) {
    if (!(deadZone > 0)) return angle;
    var m = Math.abs(angle);
    if (m <= deadZone) return 0;
    return (angle < 0 ? -1 : 1) * (m - deadZone);
  }

  /**
   * Final normalisation: physical degrees -> game value in [-100, 100].
   * At `maxAngle` degrees of physical rotation the output reaches ±100 when
   * sensitivity is 1x; sensitivity scales how fast you get there.
   */
  function computeSteeringValue(angle, opts) {
    var dz = opts.deadZone || 0;
    var span = Math.max((opts.maxAngle || 90) - dz, 1);
    var sens = opts.sensitivity == null ? 1 : opts.sensitivity;
    var v = (applyDeadZone(angle, dz) / span) * 100 * sens;
    return clamp(v, -100, 100);
  }

  /**
   * Frame-rate independent exponential low-pass.
   * `tau` is the time constant in seconds: bigger = smoother = laggier.
   */
  function LowPass(tau) {
    this.tau = tau;
    this.value = 0;
    this.primed = false;
  }
  LowPass.prototype.reset = function (v) {
    this.value = v || 0;
    this.primed = false;
    return this.value;
  };
  LowPass.prototype.update = function (target, dt) {
    if (!this.primed) { this.primed = true; this.value = target; return this.value; }
    if (!(dt > 0)) return this.value;
    if (this.tau <= 0) { this.value = target; return this.value; }
    var k = 1 - Math.exp(-dt / this.tau);
    // Move along the shortest arc so a wrap from +179 to -179 does not spin.
    this.value = this.value + wrap180(target - this.value) * k;
    return this.value;
  };

  /** Exponential smoothing for plain (non-angular) numbers. */
  function damp(current, target, tau, dt) {
    if (!(dt > 0) || tau <= 0) return target;
    return current + (target - current) * (1 - Math.exp(-dt / tau));
  }

  /**
   * One Euro filter — the reason the wheel can be both steady and responsive.
   *
   * A fixed low-pass forces a straight trade: smooth at rest but laggy when
   * you turn, or responsive but jittery. This one raises its cutoff with the
   * signal's own speed, so it filters hard while the wheel is held still and
   * almost not at all mid-turn. Lag during real steering drops a lot.
   *
   * Operates on continuous (already unwrapped) angles.
   */
  function alphaFor(cutoff, dt) {
    var tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  function OneEuro(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff == null ? 2.5 : minCutoff;
    this.beta = beta == null ? 0.02 : beta;
    this.dCutoff = dCutoff == null ? 1.0 : dCutoff;
    this.x = 0;
    this.dx = 0;
    this.primed = false;
  }
  OneEuro.prototype.reset = function (v) {
    this.x = v || 0; this.dx = 0; this.primed = false;
    return this.x;
  };
  OneEuro.prototype.update = function (value, dt) {
    if (!this.primed) { this.primed = true; this.x = value; this.dx = 0; return this.x; }
    if (!(dt > 0)) return this.x;
    var rate = (value - this.x) / dt;
    this.dx += alphaFor(this.dCutoff, dt) * (rate - this.dx);
    var cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alphaFor(cutoff, dt) * (value - this.x);
    return this.x;
  };

  var SteeringMath = {
    clamp: clamp,
    wrap180: wrap180,
    gravityFromEuler: gravityFromEuler,
    tiltMagnitude: tiltMagnitude,
    rollFromGravity: rollFromGravity,
    yawIncrement: yawIncrement,
    blendWeight: blendWeight,
    blendAngle: blendAngle,
    applyDeadZone: applyDeadZone,
    computeSteeringValue: computeSteeringValue,
    LowPass: LowPass,
    OneEuro: OneEuro,
    damp: damp
  };

  global.SteeringMath = SteeringMath;
  if (typeof module !== 'undefined' && module.exports) module.exports = SteeringMath;

  // Running under Node for tests: stop here, there is no DOM to wire up.
  if (typeof document === 'undefined') return;


  /* =====================================================================
     2. SETTINGS
     ===================================================================== */

  var DEFAULTS = {
    sensitivity: 1,
    deadZone: 3,
    maxAngle: 90,
    smoothing: 35,     // 0..100 -> One Euro cutoff, see filterParams()
    invert: false,
    theme: 'auto',
    rotate: 'auto',    // auto | 90 | 270 — forced UI rotation for a sideways mount
    showSensors: false,
    wakeLock: true,
    demo: false,
    log: true,
    inputMode: 'auto'   // auto | gamepad | keyboard — which PC backend to use
  };
  var STORE_KEY = 'phone-steering.settings.v1';
  var settings = Object.assign({}, DEFAULTS);

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (e) { /* private mode — defaults are fine */ }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) {}
  }


  /* =====================================================================
     3. TRANSPORT — the seam for future WebSocket support
     ===================================================================== */

  /**
   * PHONE -> WebSocket -> PC -> GAME
   *
   * The socket points back at whatever host served this page, so there is no
   * IP to configure and the browser reuses the TLS certificate it already
   * trusted. An https:// page may only open wss://, never ws://.
   */
  var Transport = {
    socket: null,
    state: 'idle',        // idle | connecting | open | closed | error | unavailable
    driver: '',
    retries: 0,
    timer: null,
    listeners: [],
    lastSentValue: null,
    lastSentAt: 0,
    lastLogged: 0,
    lastLoggedValue: null,

    url: function () {
      return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/steer';
    },

    connect: function () {
      if (location.protocol === 'file:' || !('WebSocket' in global)) {
        this.setState('unavailable');
        return;
      }
      if (this.socket && (this.state === 'connecting' || this.state === 'open')) return;
      clearTimeout(this.timer);
      this.setState('connecting');

      var self = this, sock;
      try { sock = new WebSocket(this.url()); }
      catch (e) { this.setState('error'); this.scheduleRetry(); return; }
      this.socket = sock;

      sock.onopen = function () {
        self.retries = 0;
        self.setState('open');
        // Re-assert the chosen backend: the PC may have been restarted and
        // come back on its default.
        if (settings.inputMode && settings.inputMode !== 'auto') {
          self.send({ t: 'mode', mode: settings.inputMode });
        }
        toast('Connected to PC');
        if (navigator.vibrate) { try { navigator.vibrate([12, 40, 12]); } catch (e) {} }
      };
      sock.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (m.t === 'hello') {
            if (m.driver) self.driver = m.driver;
            if (m.mode) { settings.inputMode = m.mode; saveSettings(); }
            renderLink();
            syncControls();
          }
        } catch (e) {}
      };
      sock.onclose = function () {
        var was = self.state;
        self.socket = null;
        self.setState('closed');
        if (was === 'open') toast('PC disconnected');
        self.scheduleRetry();
      };
      sock.onerror = function () { self.setState('error'); };
    },

    scheduleRetry: function () {
      var self = this;
      var delay = Math.min(800 * Math.pow(1.6, this.retries++), 8000);
      clearTimeout(this.timer);
      this.timer = setTimeout(function () { self.connect(); }, delay);
    },

    setState: function (s) { this.state = s; renderLink(); },

    send: function (obj) {
      if (this.socket && this.socket.readyState === 1) {
        try { this.socket.send(JSON.stringify(obj)); return true; } catch (e) {}
      }
      return false;
    },

    /** Subscribe to every emitted value (the debug panel uses this). */
    onValue: function (fn) { this.listeners.push(fn); },

    emit: function (value) {
      for (var i = 0; i < this.listeners.length; i++) this.listeners[i](value);
      sendSteeringValue(value);
    }
  };

  /**
   * THE OUTPUT HOOK.
   * Called once per animation frame with the steering value in [-100, 100].
   */
  function sendSteeringValue(value) {
    var now = Date.now();

    // Send when it actually moved, plus a 10 Hz keepalive so the PC knows
    // we are still here while the wheel is held still.
    if (Transport.lastSentValue === null ||
        Math.abs(value - Transport.lastSentValue) > 0.15 ||
        now - Transport.lastSentAt > 100) {
      if (Transport.send({ t: 'steer', v: Math.round(value * 100) / 100 })) {
        Transport.lastSentValue = value;
        Transport.lastSentAt = now;
      }
    }

    if (!settings.log) return;
    if (now - Transport.lastLogged < 200) return;        // throttle to ~5 Hz
    var rounded = Math.round(value);
    if (rounded === Transport.lastLoggedValue) return;   // and only on change
    Transport.lastLogged = now;
    Transport.lastLoggedValue = rounded;
    console.log('[steering]', rounded);
  }
  global.sendSteeringValue = sendSteeringValue;


  /* =====================================================================
     4. SENSOR ENGINE
     ===================================================================== */

  var Engine = {
    supported: ('DeviceOrientationEvent' in global),
    needsPermission: false,
    permission: 'unknown',       // unknown | granted | denied | unsupported | n/a
    connected: false,            // are events actually arriving?

    raw: { alpha: null, beta: null, gamma: null },
    gravity: { x: 0, y: -1, z: 0 },
    tilt: 1,
    mode: '—',                   // Tilt | Hybrid | Yaw

    rollRaw: 0,                  // live roll from gravity, wrapped (deg)
    yawRaw: 0,                   // live alpha (deg)

    // Continuous, UNWRAPPED rotation. Accumulating small per-event deltas is
    // what lets the wheel pass 180 degrees and keep going for several full
    // turns instead of snapping to the opposite lock.
    rollPrev: null,
    rollCont: 0,
    yawPrev: null,
    yawCont: 0,

    rollCenter: 0,
    yawCenter: 0,
    calibrated: false,

    filter: new OneEuro(2.5, 0.02),
    angle: 0,                    // smoothed physical angle, deg (signed)
    display: 0,                  // render-loop interpolated angle
    value: 0,                    // steering value in [-100, 100]

    lastEventAt: 0,
    eventTimes: [],
    rateHz: 0,

    keyboard: 0                  // desktop fallback, only when no sensors
  };

  function handleOrientation(ev) {
    if (ev.alpha === null && ev.beta === null && ev.gamma === null) return;

    var now = performance.now();
    Engine.lastEventAt = now;
    if (!Engine.connected) {
      Engine.connected = true;
      Engine.permission = 'granted';
      setStatus('ok', 'Sensors Connected');
    }

    // rolling update-rate estimate
    Engine.eventTimes.push(now);
    while (Engine.eventTimes.length && now - Engine.eventTimes[0] > 1000) Engine.eventTimes.shift();
    Engine.rateHz = Engine.eventTimes.length;

    Engine.raw.alpha = ev.alpha;
    Engine.raw.beta = ev.beta;
    Engine.raw.gamma = ev.gamma;

    var gv = gravityFromEuler(ev.alpha, ev.beta, ev.gamma);
    Engine.gravity = gv;
    Engine.tilt = tiltMagnitude(gv);

    // --- accumulate continuous rotation ----------------------------------
    // Each event moves only a degree or two, so wrapping the DELTA is always
    // unambiguous. Summing those deltas gives an unbounded angle: turn three
    // full turns and it reads 1080, not a value folded back into ±180.
    var roll = rollFromGravity(gv);
    if (Engine.rollPrev === null) Engine.rollPrev = roll;
    Engine.rollCont += wrap180(roll - Engine.rollPrev);
    Engine.rollPrev = roll;
    Engine.rollRaw = roll;

    if (ev.alpha != null) {
      Engine.yawCont += yawIncrement(ev.alpha, Engine.yawPrev, gv.z);
      Engine.yawPrev = ev.alpha;
    }
    Engine.yawRaw = ev.alpha;

    if (!Engine.calibrated) applyCalibration();

    // --- relative angle from the calibrated centre -----------------------
    // Both terms are continuous now, so this is a plain subtraction and a
    // plain blend. No wrapping anywhere downstream.
    var dRoll = Engine.rollCont - Engine.rollCenter;
    var dYaw = Engine.yawCont - Engine.yawCenter;

    var w = (ev.alpha == null) ? 1 : blendWeight(Engine.tilt);
    Engine.mode = w > 0.95 ? 'Tilt' : (w < 0.05 ? 'Yaw' : 'Hybrid');

    var target = dYaw + (dRoll - dYaw) * w;

    var f = filterParams();
    Engine.filter.minCutoff = f.minCutoff;
    Engine.filter.beta = f.beta;
    Engine.angle = Engine.filter.update(target, 1 / Math.max(Engine.rateHz || 30, 10));
  }

  /** Map the Smoothing slider onto One Euro parameters. */
  function filterParams() {
    var s = clamp(settings.smoothing / 100, 0, 1);
    return {
      minCutoff: 5.0 - 4.3 * s,   // Hz: snappy at 0, heavily damped at 100
      beta: 0.030 - 0.018 * s     // how hard it opens up when you turn fast
    };
  }

  function applyCalibration() {
    Engine.rollCenter = Engine.rollCont;
    Engine.yawCenter = Engine.yawCont;
    Engine.calibrated = true;
    Engine.angle = 0;
    Engine.filter.reset(0);
    Engine.display = 0;
    Engine.keyboard = 0;
  }

  function calibrate(quiet) {
    if (Engine.raw.beta === null && Engine.raw.gamma === null && !Engine.connected) {
      toast('No sensor data yet — hold on a second.');
      return false;
    }
    applyCalibration();
    if (!quiet) {
      toast('Centre calibrated');
      if (navigator.vibrate) { try { navigator.vibrate(18); } catch (e) {} }
    }
    return true;
  }

  /* --- permissions ----------------------------------------------------- */

  function permissionRequired() {
    return typeof DeviceOrientationEvent !== 'undefined' &&
           typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  function attachSensorListeners() {
    // 'deviceorientation' is relative on most Android builds and absolute on
    // iOS; we only ever use deltas, so either is fine. We prefer the plain
    // event and ignore 'deviceorientationabsolute' to avoid compass drift.
    global.addEventListener('deviceorientation', handleOrientation, true);
  }

  /**
   * Must be called from a user gesture on iOS 13+.
   * Resolves with 'granted' | 'denied' | 'unsupported' | 'error'.
   */
  function requestSensors() {
    if (!Engine.supported) {
      Engine.permission = 'unsupported';
      return Promise.resolve('unsupported');
    }
    if (!permissionRequired()) {
      Engine.needsPermission = false;
      Engine.permission = 'n/a';
      attachSensorListeners();
      watchForSilence();
      return Promise.resolve('granted');
    }
    Engine.needsPermission = true;
    return DeviceOrientationEvent.requestPermission()
      .then(function (res) {
        Engine.permission = res;
        if (res === 'granted') {
          attachSensorListeners();
          watchForSilence();
          return 'granted';
        }
        return 'denied';
      })
      .catch(function (err) {
        console.warn('[steering] permission request failed:', err);
        Engine.permission = 'error';
        return 'error';
      });
  }

  /**
   * Some browsers grant permission but never fire an event (no gyro, sensor
   * blocked by policy, desktop). Detect that and degrade honestly.
   */
  var silenceTimer = null;
  function watchForSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(function () {
      if (!Engine.connected) {
        setStatus('bad', 'No sensor data');
        enableKeyboardFallback();
      }
    }, 2200);
  }

  // Keep an eye on sensors going quiet mid-session (screen lock, tab switch).
  setInterval(function () {
    if (!Engine.connected) return;
    if (performance.now() - Engine.lastEventAt > 1500) {
      Engine.connected = false;
      Engine.rateHz = 0;
      setStatus('warn', 'Sensor signal lost');
    }
  }, 1000);


  /* =====================================================================
     5. DOM HELPERS
     ===================================================================== */

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) toastEl = $('toast');
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 1900);
  }

  function setStatus(kind, text) {
    var dot = $('statusDot'), txt = $('statusText');
    if (!dot) return;
    dot.className = 'dot is-' + kind;
    txt.textContent = text;
  }


  /* =====================================================================
     6. VIEWS
     ===================================================================== */

  var viewStack = ['view-hero'];
  var currentView = 'view-hero';

  function showView(id, isBack) {
    if (id === currentView) return;
    var next = $(id);
    if (!next) return;
    var prev = $(currentView);
    if (prev) prev.classList.remove('is-active');
    next.classList.add('is-active');
    if (!isBack) viewStack.push(id);
    currentView = id;

    if (id === 'view-demo') Demo.start();
    else Demo.stop();

    // The sensor graph only needs to be live while its sheet is open.
    if (id === 'view-controller') syncControls();
  }

  function goBack() {
    if (viewStack.length > 1) {
      viewStack.pop();
      showView(viewStack[viewStack.length - 1], true);
    } else {
      showView('view-controller', true);
    }
  }


  /* =====================================================================
     7. GAUGE + WHEEL RENDERING
     ===================================================================== */

  var GAUGE = { cx: 150, cy: 112, r: 92, from: -160, to: -20 };

  function buildGaugeTicks() {
    var g = $('gaugeTicks');
    if (!g) return;
    var parts = [];
    for (var i = 0; i <= 28; i++) {
      var a = (GAUGE.from + (GAUGE.to - GAUGE.from) * (i / 28)) * RAD;
      var major = i % 7 === 0;
      var r1 = GAUGE.r + 9, r2 = GAUGE.r + (major ? 17 : 13);
      parts.push('<line x1="' + (GAUGE.cx + r1 * Math.cos(a)).toFixed(2) +
                 '" y1="' + (GAUGE.cy + r1 * Math.sin(a)).toFixed(2) +
                 '" x2="' + (GAUGE.cx + r2 * Math.cos(a)).toFixed(2) +
                 '" y2="' + (GAUGE.cy + r2 * Math.sin(a)).toFixed(2) +
                 '"' + (major ? ' class="is-major"' : '') + '/>');
    }
    g.innerHTML = parts.join('');
  }

  function placeGaugeMarker(value) {
    var m = $('gaugeMarker');
    if (!m) return;
    var t = (value + 100) / 200;                       // 0..1
    var deg = GAUGE.from + (GAUGE.to - GAUGE.from) * t;
    var a = deg * RAD;
    var x = GAUGE.cx + GAUGE.r * Math.cos(a);
    var y = GAUGE.cy + GAUGE.r * Math.sin(a);
    m.setAttribute('transform', 'translate(' + x.toFixed(2) + ',' + y.toFixed(2) + ') rotate(' + (deg + 90).toFixed(2) + ')');
  }

  var wheelRotor, wheelGlow, elValue, elAngle, elChipStatus, elChipDot, elChipSens;

  function renderController(angle, value) {
    if (!wheelRotor) return;

    wheelRotor.style.transform = 'rotate(' + angle.toFixed(2) + 'deg)';
    placeGaugeMarker(value);

    var rounded = Math.round(value);
    elValue.textContent = (rounded > 0 ? '+' : '') + rounded;
    elValue.classList.toggle('is-left', rounded < -1);
    elValue.classList.toggle('is-right', rounded > 1);

    elAngle.textContent = angle.toFixed(0) + '°';
    elChipSens.textContent = settings.sensitivity.toFixed(1) + 'x';

    var state, dotKind;
    if (!Engine.connected) { state = 'No Signal'; dotKind = 'bad'; }
    else if (rounded <= -2) { state = 'Left'; dotKind = 'ok'; }
    else if (rounded >= 2) { state = 'Right'; dotKind = 'ok'; }
    else { state = 'Center'; dotKind = 'ok'; }
    elChipStatus.textContent = state;
    elChipDot.className = 'dot is-' + dotKind;

    wheelGlow.classList.toggle('is-left', rounded < -8);
    wheelGlow.classList.toggle('is-right', rounded > 8);
  }

  var LINK_LABELS = {
    open:        ['ok',   'Connected to PC'],
    connecting:  ['warn', 'Connecting…'],
    closed:      ['bad',  'Not connected'],
    error:       ['bad',  'Connection failed'],
    idle:        ['warn', 'Starting…'],
    unavailable: ['bad',  'Open this page from the PC server']
  };

  function renderLink() {
    var m = LINK_LABELS[Transport.state] || LINK_LABELS.idle;
    var dot = $('linkDot'), txt = $('linkText'), drv = $('linkDriver'), nav = $('navLinkDot');
    if (dot) dot.className = 'dot is-' + m[0];
    if (txt) txt.textContent = m[1];
    if (drv) drv.textContent = Transport.driver || '—';
    if (nav) nav.className = 'dot is-' + m[0];
  }


  function renderConnect(value) {
    var v = $('connectValue');
    if (!v || currentView !== 'view-connect') return;
    var r = Math.round(value);
    v.textContent = (r > 0 ? '+' : '') + r;
    var bar = $('connectBar');
    var half = Math.abs(r) / 200 * 100;
    bar.style.width = half + '%';
    bar.style.left = r < 0 ? (50 - half) + '%' : '50%';
    bar.style.background = r < 0 ? 'var(--blue)' : 'var(--red)';
  }


  /* =====================================================================
     8. DEBUG PANEL (sensor data sheet)
     ===================================================================== */

  var Graph = {
    canvas: null, ctx: null, data: [], max: 160, dpr: 1,

    init: function () {
      this.canvas = $('graph');
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this.resize();
    },
    resize: function () {
      if (!this.canvas) return;
      var r = this.canvas.getBoundingClientRect();
      if (!r.width) return;
      this.dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(r.width * this.dpr);
      this.canvas.height = Math.round(r.height * this.dpr);
    },
    push: function (v) {
      this.data.push(v);
      if (this.data.length > this.max) this.data.shift();
    },
    draw: function () {
      if (!this.ctx || !this.canvas.width) return;
      var c = this.ctx, W = this.canvas.width, H = this.canvas.height, d = this.dpr;
      c.clearRect(0, 0, W, H);

      var pad = 10 * d;
      var mid = H / 2;

      // grid
      c.strokeStyle = 'rgba(128,136,150,.22)';
      c.lineWidth = 1 * d;
      c.setLineDash([3 * d, 5 * d]);
      [pad, mid, H - pad].forEach(function (y) {
        c.beginPath(); c.moveTo(pad * 3, y); c.lineTo(W - pad, y); c.stroke();
      });
      c.setLineDash([]);

      if (this.data.length < 2) return;

      var x0 = pad * 3, span = (W - pad) - x0;
      var pts = this.data;
      c.beginPath();
      for (var i = 0; i < pts.length; i++) {
        var x = x0 + span * (i / (this.max - 1));
        var y = mid - (pts[i] / 100) * (mid - pad);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.strokeStyle = '#3f8bff';
      c.lineWidth = 2.2 * d;
      c.lineJoin = 'round'; c.lineCap = 'round';
      c.stroke();

      // leading dot
      var last = pts[pts.length - 1];
      var lx = x0 + span * ((pts.length - 1) / (this.max - 1));
      var ly = mid - (last / 100) * (mid - pad);
      c.beginPath(); c.arc(lx, ly, 3.2 * d, 0, Math.PI * 2);
      c.fillStyle = '#7fc4ff'; c.fill();
    }
  };

  var sheetOpen = false;
  function openSheet(open) {
    sheetOpen = open;
    $('sensorSheet').classList.toggle('is-open', open);
    $('sensorSheet').setAttribute('aria-hidden', String(!open));
    settings.showSensors = open;
    saveSettings();
    syncControls();
    if (open) setTimeout(function () { Graph.resize(); }, 340);
  }

  function fmt(v) { return v == null ? '—' : v.toFixed(1) + '°'; }

  function renderDebug(angle, value) {
    if (!sheetOpen) return;
    $('dAlpha').textContent = fmt(Engine.raw.alpha);
    $('dBeta').textContent = fmt(Engine.raw.beta);
    $('dGamma').textContent = fmt(Engine.raw.gamma);
    $('dAngle').textContent = angle.toFixed(1) + '°';
    $('dValue').textContent = String(Math.round(value));

    var oOk = Engine.supported;
    $('dOrientDot').className = 'dot is-' + (oOk ? 'ok' : 'bad');
    $('dOrient').textContent = oOk ? 'Available' : 'Unavailable';

    var p = Engine.permission;
    var pKind = (p === 'granted' || p === 'n/a') ? 'ok' : (p === 'denied' || p === 'unsupported' ? 'bad' : 'warn');
    $('dPermDot').className = 'dot is-' + pKind;
    $('dPerm').textContent = p === 'n/a' ? 'Not required' :
                             p === 'granted' ? 'Granted' :
                             p === 'denied' ? 'Denied' :
                             p === 'unsupported' ? 'Unsupported' : 'Unknown';

    $('dMode').textContent = Engine.connected ? Engine.mode : '—';
    $('dRate').textContent = Engine.rateHz + ' Hz';

    Graph.draw();
  }


  /* =====================================================================
     9. DEMO MODE — pseudo-3D road, driven by the real steering value
     ===================================================================== */

  var Demo = {
    running: false,
    canvas: null, ctx: null, dpr: 1,
    W: 0, H: 0,
    z: 0,            // distance travelled
    speed: 0,        // km/h
    lateral: 0,      // -1 .. 1 across the road
    curve: 0,        // current road curvature
    curveTarget: 0,
    nextCurveAt: 0,

    init: function () {
      this.canvas = $('road');
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this.resize();
    },
    resize: function () {
      if (!this.canvas) return;
      var r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.W = Math.round(r.width * this.dpr);
      this.H = Math.round(r.height * this.dpr);
      this.canvas.width = this.W;
      this.canvas.height = this.H;
    },
    start: function () {
      if (this.running) return;
      this.running = true;
      this.resize();
    },
    stop: function () { this.running = false; },

    step: function (dt, steer) {
      // speed: builds on straights, scrubs off in hard turns
      var targetSpeed = 210 - Math.abs(steer) * 0.75;
      if (Math.abs(this.lateral) > 0.95) targetSpeed *= 0.45;   // off track
      this.speed = damp(this.speed, targetSpeed, 1.6, dt);

      this.z += this.speed * dt * 0.42;

      // random-ish track layout so there is something to steer around
      if (this.z > this.nextCurveAt) {
        this.nextCurveAt = this.z + 90 + Math.random() * 140;
        this.curveTarget = (Math.random() * 2 - 1) * 1.2;
      }
      this.curve = damp(this.curve, this.curveTarget, 1.1, dt);

      // the car drifts across the road: steering input minus the corner push
      var drift = (steer / 100) * 1.35 - this.curve * 0.26 * (this.speed / 200);
      this.lateral = clamp(this.lateral + drift * dt, -1.35, 1.35);
      // gentle self-centering so it is playable one-handed
      this.lateral = damp(this.lateral, this.lateral * 0.985, 0.6, dt);
    },

    draw: function (steer) {
      var c = this.ctx;
      if (!c || !this.W) return;
      var W = this.W, H = this.H, d = this.dpr;
      var horizon = H * 0.42;

      // sky
      var sky = c.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, '#0b1626');
      sky.addColorStop(0.55, '#16304d');
      sky.addColorStop(1, '#3d5a7a');
      c.fillStyle = sky;
      c.fillRect(0, 0, W, horizon);

      // sun haze
      var hx = W / 2 - this.lateral * W * 0.10 - this.curve * W * 0.05;
      var haze = c.createRadialGradient(hx, horizon, 0, hx, horizon, W * 0.55);
      haze.addColorStop(0, 'rgba(255,190,130,.35)');
      haze.addColorStop(1, 'rgba(255,190,130,0)');
      c.fillStyle = haze;
      c.fillRect(0, 0, W, horizon);

      // mountains (parallax against steering)
      c.fillStyle = '#0d1b2b';
      c.beginPath();
      c.moveTo(0, horizon);
      for (var mx = 0; mx <= W; mx += W / 14) {
        var n = Math.sin((mx / W) * 7.3 + 1.7) * 0.5 + Math.sin((mx / W) * 3.1) * 0.5;
        c.lineTo(mx - this.lateral * 26 * d, horizon - (28 + n * 34) * d);
      }
      c.lineTo(W, horizon);
      c.closePath();
      c.fill();

      // ground
      c.fillStyle = '#10161b';
      c.fillRect(0, horizon, W, H - horizon);

      // Road, scanline by scanline. A flat plane projects to straight road
      // edges, so the half-width is LINEAR in screen depth — not squared.
      var halfAtCamera = W * 0.46;
      var step = Math.max(1, Math.round(1 * d));
      for (var y = Math.ceil(horizon); y < H; y += step) {
        var p = (y - horizon) / (H - horizon);       // 0 at horizon, 1 at camera
        var pp = Math.max(p, 0.012);                 // keep 1/pp finite
        var zWorld = this.z + 2.4 / pp;              // world depth ∝ 1/screen depth

        var w = halfAtCamera * pp + 2 * d;
        var cx = W / 2
               + this.curve * (1 - pp) * (1 - pp) * W * 0.30
               - this.lateral * w;

        // grass / verge
        c.fillStyle = (Math.floor(zWorld / 11) % 2 === 0) ? '#1b2e22' : '#16261c';
        c.fillRect(0, y, W, step);

        // Detail finer than a scanline just aliases into moiré near the
        // horizon, so only draw it once the road is wide enough to hold it.
        if (w > 5 * d) {
          c.fillStyle = (Math.floor(zWorld / 5.5) % 2 === 0) ? '#e6e9ee' : '#e0323f';
          c.fillRect(cx - w * 1.10, y, w * 2.20, step);
        }

        c.fillStyle = (Math.floor(zWorld / 11) % 2 === 0) ? '#32373f' : '#2d323a';
        c.fillRect(cx - w, y, w * 2, step);

        if (w > 8 * d && Math.floor(zWorld / 4.2) % 2 === 0) {
          var lw = Math.max(1, w * 0.035);
          c.fillStyle = 'rgba(255,255,255,.75)';
          c.fillRect(cx - lw / 2, y, lw, step);
        }
      }

      // Haze where the road meets the horizon — also hides the last of the
      // sub-pixel shimmer up there.
      var fog = c.createLinearGradient(0, horizon, 0, horizon + (H - horizon) * 0.22);
      fog.addColorStop(0, 'rgba(61,90,122,.95)');
      fog.addColorStop(1, 'rgba(61,90,122,0)');
      c.fillStyle = fog;
      c.fillRect(0, horizon, W, (H - horizon) * 0.22);

      // off-track warning wash
      if (Math.abs(this.lateral) > 1) {
        c.fillStyle = 'rgba(255,32,56,' + Math.min((Math.abs(this.lateral) - 1) * 0.5, 0.22) + ')';
        c.fillRect(0, 0, W, H);
      }

      // car body reacts to steering
      var car = $('demoCar');
      if (car) {
        var lean = clamp(steer * 0.055, -7, 7);
        var slide = clamp(steer * 0.16, -34, 34);
        car.style.transform = 'translateX(calc(-50% + ' + slide.toFixed(1) + 'px)) rotate(' + lean.toFixed(2) + 'deg)';
      }

      // HUD
      var sp = Math.max(0, Math.round(this.speed));
      $('hudSpeed').textContent = sp;
      $('hudGear').textContent = String(clamp(Math.floor(sp / 42) + 1, 1, 6));
      var r = Math.round(steer);
      $('hudSteer').textContent = (r > 0 ? '+' : '') + r;
      var bar = $('hudBar');
      var half = Math.abs(r) / 200 * 100;
      bar.style.width = half + '%';
      bar.style.left = r < 0 ? (50 - half) + '%' : '50%';
      bar.style.background = r < 0 ? '#3f8bff' : '#ff2038';
    }
  };


  /* =====================================================================
     10. MAIN LOOP
     ===================================================================== */

  var lastFrame = 0;

  function frame(t) {
    requestAnimationFrame(frame);
    var dt = lastFrame ? Math.min((t - lastFrame) / 1000, 0.1) : 0.016;
    lastFrame = t;

    // Desktop / no-sensor fallback: arrow keys, clearly labelled in the UI.
    var source = Engine.connected ? Engine.angle : Engine.keyboard;

    // Render-loop interpolation only bridges the gap between sensor events,
    // so tie it to the sensor interval and keep it short. The One Euro filter
    // already did the real smoothing; a long tau here would just add lag.
    // No wrapping: these are continuous angles that may exceed 360.
    var tau = clamp(0.8 / Math.max(Engine.rateHz || 30, 10), 0.012, 0.06);
    Engine.display += (source - Engine.display) * (1 - Math.exp(-dt / tau));

    var signed = settings.invert ? -Engine.display : Engine.display;
    var value = computeSteeringValue(signed, settings);
    Engine.value = value;

    // Not clamped — the wheel graphic should keep spinning past a full turn.
    renderController(Engine.display, value);
    renderConnect(value);
    renderDebug(signed, value);
    if (sheetOpen) Graph.push(value);

    if (Demo.running) {
      Demo.step(dt, value);
      Demo.draw(value);
    }

    Transport.emit(value);
  }


  /* =====================================================================
     11. CONTROLS + WIRING
     ===================================================================== */

  function setSliderFill(el) {
    var min = parseFloat(el.min), max = parseFloat(el.max);
    var pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
    el.style.setProperty('--pct', pct + '%');
  }

  /** Past a full turn, degrees stop meaning much — show turns as well. */
  function formatMaxAngle(v) {
    if (v >= 360) return v + '° (' + (v / 360).toFixed(2).replace(/\.?0+$/, '') + ' turns)';
    return v + '°';
  }

  function smoothingLabel(v) {
    if (v < 15) return 'Off';
    if (v < 38) return 'Light';
    if (v < 62) return 'Medium';
    if (v < 85) return 'Heavy';
    return 'Max';
  }

  function syncControls() {
    var s = settings;
    var map = [['inSens', s.sensitivity], ['inDead', s.deadZone], ['inMax', s.maxAngle], ['inSmooth', s.smoothing]];
    map.forEach(function (pair) {
      var el = $(pair[0]);
      if (!el) return;
      el.value = pair[1];
      setSliderFill(el);
    });
    $('valSens').textContent = s.sensitivity.toFixed(1) + 'x';
    $('valDead').textContent = s.deadZone + '°';
    $('valMax').textContent = formatMaxAngle(s.maxAngle);
    $('valSmooth').textContent = smoothingLabel(s.smoothing);

    setSwitch($('swInvert'), s.invert);
    setSwitch($('swSensors'), s.showSensors);
    setSwitch($('swWake'), s.wakeLock);
    setSwitch($('swDemo'), s.demo);
    setSwitch($('swLog'), s.log);

    $$('#segTheme button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.themeOpt === s.theme);
    });
    $$('#segRotate button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.rot === s.rotate);
    });
    $$('#segMode button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.mode === s.inputMode);
    });
  }

  function setSwitch(el, on) {
    if (!el) return;
    el.classList.toggle('is-on', !!on);
    el.setAttribute('aria-checked', String(!!on));
  }

  function bindSwitch(id, key, onChange) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('click', function () {
      settings[key] = !settings[key];
      setSwitch(el, settings[key]);
      saveSettings();
      if (onChange) onChange(settings[key]);
    });
  }

  function bindSlider(id, key, labelId, format, parse) {
    var el = $(id);
    if (!el) return;
    var handler = function () {
      settings[key] = parse(el.value);
      $(labelId).textContent = format(settings[key]);
      setSliderFill(el);
      saveSettings();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

  /* --- theme ----------------------------------------------------------- */

  /**
   * Decide how the UI is oriented.
   *
   * iOS has no landscape rotation lock — "Rotation Lock" means portrait — so a
   * phone taped sideways to the wheel is stuck rendering portrait. Forcing a
   * rotation here lets the user keep the OS locked (no flipping mid-corner)
   * while the UI still reads correctly on the mount.
   */
  function applyLayout() {
    var rot = settings.rotate;
    var root = document.documentElement;

    if (rot === '90' || rot === '270') {
      root.setAttribute('data-rotate', rot);
      root.classList.add('is-landscape');
    } else {
      root.removeAttribute('data-rotate');
      var wide = global.innerWidth > global.innerHeight;
      root.classList.toggle('is-landscape', wide && global.innerHeight <= 560);
    }

    // The canvases are sized from their own boxes, which just changed.
    setTimeout(function () { Graph.resize(); Demo.resize(); }, 60);
  }

  var mq = global.matchMedia ? global.matchMedia('(prefers-color-scheme: light)') : null;

  function applyTheme() {
    var t = settings.theme;
    var resolved = t === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : t;
    document.documentElement.setAttribute('data-theme', resolved);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#f1f2f6' : '#08090c');
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (settings.theme === 'auto') applyTheme(); });

  /* --- wake lock -------------------------------------------------------- */

  var wakeSentinel = null;
  function updateWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (settings.wakeLock && !wakeSentinel) {
      navigator.wakeLock.request('screen').then(function (s) {
        wakeSentinel = s;
        s.addEventListener('release', function () { wakeSentinel = null; });
      }).catch(function () { /* denied or not visible — harmless */ });
    } else if (!settings.wakeLock && wakeSentinel) {
      wakeSentinel.release().catch(function () {});
      wakeSentinel = null;
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') updateWakeLock();
  });

  /* --- keyboard fallback ------------------------------------------------ */

  var keyboardOn = false;
  function enableKeyboardFallback() {
    if (keyboardOn) return;
    keyboardOn = true;
    var held = 0;
    global.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') held = -1;
      else if (e.key === 'ArrowRight') held = 1;
      else if (e.key === ' ') { Engine.keyboard = 0; return; }
      else return;
      e.preventDefault();
    });
    global.addEventListener('keyup', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') held = 0;
    });
    setInterval(function () {
      if (Engine.connected) return;
      if (held) Engine.keyboard = clamp(Engine.keyboard + held * 2.2, -settings.maxAngle * 1.1, settings.maxAngle * 1.1);
      else Engine.keyboard *= 0.90;
    }, 16);
    toast('No sensors — arrow keys enabled for testing');
  }

  /* --- gate ------------------------------------------------------------- */

  function showGate(cfg) {
    $('gateTitle').textContent = cfg.title;
    $('gateText').textContent = cfg.text;
    $('gateAction').textContent = cfg.action;
    $('gateHint').textContent = cfg.hint || '';
    $('gateIcon').classList.toggle('is-bad', !!cfg.bad);
    var sec = $('gateSecondary');
    sec.hidden = !cfg.secondary;
    if (cfg.secondary) sec.textContent = cfg.secondary;
    $('gate').classList.add('is-open');
    $('gate').setAttribute('aria-hidden', 'false');
    gateHandler = cfg.onAction;
    gateSecondaryHandler = cfg.onSecondary;
  }
  function hideGate() {
    $('gate').classList.remove('is-open');
    $('gate').setAttribute('aria-hidden', 'true');
  }
  var gateHandler = null, gateSecondaryHandler = null;

  function enterController() {
    hideGate();
    showView('view-controller');
    updateWakeLock();
    // Give the sensors a moment to settle, then zero the wheel automatically.
    setTimeout(function () { if (Engine.connected) calibrate(true); }, 600);
  }

  /** Full start-up path from the hero screen. Must run inside a user gesture. */
  function startFlow() {
    if (!Engine.supported) {
      showGate({
        title: 'Sensors Not Available',
        text: 'This browser does not expose the Device Orientation API, so the phone cannot measure how far you turn the wheel. Open this page in Safari on iPhone or Chrome on Android over HTTPS.',
        action: 'Continue with Keyboard',
        bad: true,
        secondary: 'Reload the page',
        hint: 'Motion sensors also require a secure (https://) connection.',
        onAction: function () { enableKeyboardFallback(); enterController(); },
        onSecondary: function () { location.reload(); }
      });
      return;
    }

    setStatus('warn', 'Connecting…');

    requestSensors().then(function (res) {
      if (res === 'granted') {
        enterController();
      } else if (res === 'denied') {
        showGate({
          title: 'Motion Access Denied',
          text: 'Safari blocked access to the motion sensors. Reload the page and tap "Allow", or enable Settings → Safari → Motion & Orientation Access on your iPhone.',
          action: 'Try Again',
          bad: true,
          secondary: 'Continue without sensors',
          onAction: function () { hideGate(); startFlow(); },
          onSecondary: function () { enableKeyboardFallback(); enterController(); }
        });
      } else if (res === 'unsupported') {
        showGate({
          title: 'Sensors Not Available',
          text: 'No orientation sensor was found on this device.',
          action: 'Continue without sensors',
          bad: true,
          onAction: function () { enableKeyboardFallback(); enterController(); }
        });
      } else {
        showGate({
          title: 'Could Not Start Sensors',
          text: 'Requesting motion access failed. This almost always means the page is not being served over HTTPS — iOS and Android both require a secure connection for motion sensors.',
          action: 'Try Again',
          bad: true,
          hint: location.protocol === 'https:' ? '' : 'You are on ' + location.protocol + '// — switch to https://',
          secondary: 'Continue without sensors',
          onAction: function () { hideGate(); startFlow(); },
          onSecondary: function () { enableKeyboardFallback(); enterController(); }
        });
      }
    });
  }


  /* =====================================================================
     12. BOOT
     ===================================================================== */

  function boot() {
    loadSettings();
    applyTheme();
    applyLayout();
    buildGaugeTicks();

    wheelRotor = $('wheelRotor');
    wheelGlow = $('wheelGlow');
    elValue = $('steerValue');
    elAngle = $('chipAngle');
    elChipStatus = $('chipStatus');
    elChipDot = $('chipDot');
    elChipSens = $('chipSens');

    Graph.init();
    Demo.init();
    syncControls();
    setStatus('warn', 'Waiting for permission');

    /* --- navigation --- */
    $$('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { showView(b.dataset.goto); });
    });
    $$('[data-back]').forEach(function (b) {
      b.addEventListener('click', goBack);
    });

    $('btnGetStarted').addEventListener('click', startFlow);
    $('btnHowItWorks').addEventListener('click', function () {
      $('howto').classList.add('is-open');
      $('howto').setAttribute('aria-hidden', 'false');
    });
    $$('[data-close-howto]').forEach(function (b) {
      b.addEventListener('click', function () {
        $('howto').classList.remove('is-open');
        $('howto').setAttribute('aria-hidden', 'true');
      });
    });

    $('gateAction').addEventListener('click', function () { if (gateHandler) gateHandler(); });
    $('gateSecondary').addEventListener('click', function () { if (gateSecondaryHandler) gateSecondaryHandler(); });

    /* --- calibration --- */
    $('btnCalibrate').addEventListener('click', function () { calibrate(false); });
    $('btnDemoCal').addEventListener('click', function () { calibrate(false); });

    /* --- sensor sheet --- */
    $('btnOpenSensors').addEventListener('click', function () { openSheet(true); });
    $$('[data-close-sheet]').forEach(function (b) {
      b.addEventListener('click', function () { openSheet(false); });
    });

    /* --- demo --- */
    $('btnOpenDemo').addEventListener('click', function () {
      settings.demo = true; saveSettings(); syncControls();
      showView('view-demo');
    });
    $('btnFullscreen').addEventListener('click', function () {
      var el = document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen) {
        el.requestFullscreen().catch(function () { toast('Fullscreen not allowed here'); });
      } else if (document.exitFullscreen) {
        document.exitFullscreen();
      } else {
        toast('Fullscreen is not supported in this browser');
      }
    });

    $('btnConnectInfo').addEventListener('click', function () {
      toast('Steering streams to ' + location.host + ' over WebSocket');
    });
    $$('#segMode button').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.dataset.mode;
        settings.inputMode = mode;
        saveSettings();
        syncControls();
        if (Transport.send({ t: 'mode', mode: mode })) {
          Transport.driver = 'switching…';
          renderLink();
          toast(mode === 'browser' ? 'Browser tuning — holds keys so the game can ramp'
              : mode === 'keyboard' ? 'Keyboard — fine PWM for native games'
              : mode === 'gamepad' ? 'Gamepad — true analog'
              : 'Using the best available driver');
        } else {
          toast('Not connected to the PC yet');
        }
      });
    });

    $('btnRelink').addEventListener('click', function () {
      Transport.retries = 0;
      Transport.connect();
      toast('Reconnecting…');
    });

    /* --- settings --- */
    bindSlider('inSens', 'sensitivity', 'valSens',
      function (v) { return v.toFixed(1) + 'x'; }, parseFloat);
    bindSlider('inDead', 'deadZone', 'valDead',
      function (v) { return v + '°'; }, parseFloat);
    bindSlider('inMax', 'maxAngle', 'valMax', formatMaxAngle, parseFloat);
    bindSlider('inSmooth', 'smoothing', 'valSmooth', smoothingLabel, parseFloat);

    bindSwitch('swInvert', 'invert');
    bindSwitch('swSensors', 'showSensors', function (on) { openSheet(on); });
    bindSwitch('swWake', 'wakeLock', updateWakeLock);
    // Only leave the demo if we are actually looking at it — toggling this
    // off from the settings screen should not navigate anywhere.
    bindSwitch('swDemo', 'demo', function (on) {
      if (on) showView('view-demo');
      else if (currentView === 'view-demo') goBack();
    });
    bindSwitch('swLog', 'log');

    $$('#segTheme button').forEach(function (b) {
      b.addEventListener('click', function () {
        settings.theme = b.dataset.themeOpt;
        saveSettings(); applyTheme(); syncControls();
      });
    });
    $$('#segRotate button').forEach(function (b) {
      b.addEventListener('click', function () {
        settings.rotate = b.dataset.rot;
        saveSettings(); applyLayout(); syncControls();
        toast(settings.rotate === 'auto' ? 'Rotation follows the phone' : 'Screen rotated ' + settings.rotate + '°');
      });
    });

    $('btnReset').addEventListener('click', function () {
      Object.assign(settings, DEFAULTS);
      saveSettings();
      applyTheme();
      syncControls();
      calibrate(true);
      openSheet(false);
      toast('Settings reset to defaults');
    });

    /* --- orientation changes only affect layout ---
       rollFromGravity() measures the *device* against gravity, so the OS
       flipping the UI does not move the physical wheel and must not touch
       the calibration. Just re-lay-out. --- */
    var onOrientationChange = function () { setTimeout(applyLayout, 220); };
    if (screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener('change', onOrientationChange);
    } else {
      global.addEventListener('orientationchange', onOrientationChange);
    }
    global.addEventListener('resize', applyLayout);

    /* --- stop rubber-banding / pinch zoom --- */
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('touchmove', function (e) {
      if (e.touches.length > 1) { e.preventDefault(); return; }
      var t = e.target;
      while (t && t !== document.body) {
        if (t.classList && (t.classList.contains('scroller') || t.classList.contains('sheet__body'))) return;
        if (t.tagName === 'INPUT') return;
        t = t.parentNode;
      }
      e.preventDefault();
    }, { passive: false });

    if (settings.showSensors) openSheet(true);

    renderLink();
    Transport.connect();

    // Never leave a key stuck down on the PC if the phone sleeps, the user
    // switches apps, or the page goes away.
    var panic = function () { Transport.send({ t: 'release' }); };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') panic();
    });
    global.addEventListener('pagehide', panic);

    requestAnimationFrame(frame);
    console.log('%c[torq] ready — call sendSteeringValue(v) to pipe values out', 'color:#3f8bff');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(typeof window !== 'undefined' ? window : globalThis);
