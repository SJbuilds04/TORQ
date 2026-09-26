/* =========================================================================
   Logic tests for the steering maths in app.js.
   Run with:   node test-steering.js
   No DOM is touched — app.js exports its pure maths and bails out early
   when `document` is undefined.
   ========================================================================= */

const M = require('./app.js');

let passed = 0, failed = 0;
const fails = [];

function test(name, fn) {
  try { fn(); passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { failed++; fails.push(name + ' — ' + e.message); console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
}
function group(name) { console.log('\n\x1b[1m' + name + '\x1b[0m'); }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol, msg) {
  tol = tol == null ? 1e-6 : tol;
  if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'value') + ': expected ' + b + ' ±' + tol + ', got ' + a);
}

const RAD = Math.PI / 180;

/**
 * Model a phone taped to a cardboard wheel.
 *   tiltBack = how far the wheel leans back from vertical (0 = upright, 90 = flat)
 *   roll     = how far the wheel has been turned clockwise (right) from centre
 * Returns the true gravity vector in device axes, plus the matching
 * alpha/beta/gamma a browser would report for that pose.
 */
function pose(tiltBack, roll, alpha) {
  const T = tiltBack * RAD, p = roll * RAD;
  const g = { x: Math.cos(T) * Math.sin(p), y: -Math.cos(T) * Math.cos(p), z: -Math.sin(T) };
  const beta = Math.asin(Math.cos(T) * Math.cos(p)) / RAD;
  const gamma = Math.atan2(Math.cos(T) * Math.sin(p), Math.sin(T)) / RAD;
  return { g, alpha: alpha == null ? 137.4 : alpha, beta, gamma };
}

/**
 * A wheel being turned, mirroring what handleOrientation() does per event:
 * accumulate wrapped deltas into one continuous, unbounded angle.
 */
function makeWheel(tiltBack) {
  return {
    tilt: tiltBack,
    prevRoll: null,
    rollCont: 0,
    prevAlpha: null,
    yawCont: 0,
    center: 0,
    yawCenter: 0,
    lastTurn: 0,

    /** Jump straight to an absolute physical rotation and read the angle. */
    at(turnDeg, alpha) {
      const p = pose(this.tilt, turnDeg, alpha);
      const gv = M.gravityFromEuler(p.alpha, p.beta, p.gamma);

      const roll = M.rollFromGravity(gv);
      if (this.prevRoll === null) this.prevRoll = roll;
      this.rollCont += M.wrap180(roll - this.prevRoll);
      this.prevRoll = roll;

      this.yawCont += M.yawIncrement(p.alpha, this.prevAlpha, gv.z);
      this.prevAlpha = p.alpha;
      this.lastTurn = turnDeg;

      const dRoll = this.rollCont - this.center;
      const dYaw = this.yawCont - this.yawCenter;
      const w = M.blendWeight(M.tiltMagnitude(gv));
      return dYaw + (dRoll - dYaw) * w;
    },

    /** Sweep to a rotation the way a hand would, in small sensor-sized steps. */
    turnTo(target, stepDeg = 4) {
      const dir = target >= this.lastTurn ? 1 : -1;
      let a = this.lastTurn, last = this.at(a);
      while (a !== target) {
        a += dir * stepDeg;
        if ((dir > 0 && a > target) || (dir < 0 && a < target)) a = target;
        last = this.at(a);
      }
      return last;
    },

    calibrate() { this.center = this.rollCont; this.yawCenter = this.yawCont; }
  };
}

/** A calibrated wheel sitting at centre. */
function wheelAt(tiltBack) {
  const w = makeWheel(tiltBack);
  w.at(0);
  w.calibrate();
  return w;
}

const SET = { sensitivity: 1, deadZone: 3, maxAngle: 90 };
const value = (a, s) => M.computeSteeringValue(a, s || SET);


/* ===================================================================== */
group('0. Module surface');

test('app.js exports the maths without needing a DOM', () => {
  ['wrap180', 'gravityFromEuler', 'rollFromGravity', 'computeSteeringValue', 'LowPass', 'OneEuro']
    .forEach(k => ok(typeof M[k] === 'function', 'missing export: ' + k));
});

test('wrap180 folds angles into [-180, 180)', () => {
  near(M.wrap180(0), 0);
  near(M.wrap180(190), -170);
  near(M.wrap180(-190), 170);
  near(M.wrap180(360), 0);
  near(M.wrap180(-359), 1, 1e-9);
  near(M.wrap180(540), -180);      // the seam folds to the negative end
  near(M.wrap180(180), -180);
});


/* ===================================================================== */
group('1. Sensor permission / availability states');

test('null sensor readings never produce NaN', () => {
  const gv = M.gravityFromEuler(null, null, null);
  ok(Number.isFinite(gv.x) && Number.isFinite(gv.y) && Number.isFinite(gv.z), 'gravity went NaN');
  ok(Number.isFinite(M.rollFromGravity(gv)), 'roll went NaN');
});

test('a dead sensor (all zeros = flat) reports zero tilt, not a fake angle', () => {
  const gv = M.gravityFromEuler(0, 0, 0);
  near(M.tiltMagnitude(gv), 0, 1e-9, 'tilt');
  near(M.blendWeight(0), 0, 1e-9, 'blend weight');
});

test('missing alpha contributes no yaw instead of crashing', () => {
  near(M.yawIncrement(null, 100, -1), 0, 1e-9);
  near(M.yawIncrement(100, null, -1), 0, 1e-9);
});

test('steering value stays finite for garbage input', () => {
  ok(Number.isFinite(M.computeSteeringValue(0, { sensitivity: 1, deadZone: 0, maxAngle: 0 })),
     'zero maxAngle must not divide by zero');
});


/* ===================================================================== */
group('2. Calibration');

test('calibrating at the current pose puts the wheel at exactly 0', () => {
  near(wheelAt(35).at(0), 0, 1e-9, 'angle');
});

test('calibration works from an arbitrary already-turned pose', () => {
  // Phone mounted crooked: 22° off centre when the wheel is actually straight.
  const w = makeWheel(35);
  w.turnTo(22);
  w.calibrate();
  near(w.at(22), 0, 1e-9, 'angle at new centre');
  near(w.turnTo(52), 30, 1e-6, 'a further 30° must read 30, not 52');
});

test('calibration is independent of compass heading (no absolute bearing)', () => {
  const w = makeWheel(35);
  w.at(0, 10);
  w.calibrate();
  // Same physical rotation, phone facing a totally different direction.
  near(w.at(40, 300), 40, 1e-6, 'angle');
});

test('calibration holds across different wheel tilt angles', () => {
  [10, 25, 45, 60].forEach(tilt => {
    near(wheelAt(tilt).turnTo(45), 45, 1e-6, 'tilt ' + tilt + '°');
  });
});


/* ===================================================================== */
group('3. Left rotation → negative');

test('turning left gives a negative angle and a negative value', () => {
  [-15, -30, -60, -90].forEach(turn => {
    const a = wheelAt(35).turnTo(turn);
    near(a, turn, 1e-6, 'angle at ' + turn + '°');
    ok(value(a) < 0, 'value at ' + turn + '° should be negative');
  });
});

test('left value magnitude grows monotonically with rotation', () => {
  const w = wheelAt(35);
  let prev = 0;
  for (let t = -5; t >= -90; t -= 5) {
    const v = value(w.turnTo(t));
    ok(v <= prev + 1e-9, 'not monotonic at ' + t + '°');
    prev = v;
  }
  // Full lock lands at exactly -maxAngle (-90°), not before it.
  near(prev, -100, 1e-9, 'saturated left value');
});


/* ===================================================================== */
group('4. Right rotation → positive');

test('turning right gives a positive angle and a positive value', () => {
  [15, 30, 60, 90].forEach(turn => {
    const a = wheelAt(35).turnTo(turn);
    near(a, turn, 1e-6, 'angle at ' + turn + '°');
    ok(value(a) > 0, 'value at ' + turn + '° should be positive');
  });
});

test('left and right are exact mirrors', () => {
  [12, 36, 56, 80].forEach(turn => {
    const l = value(wheelAt(35).turnTo(-turn));
    const r = value(wheelAt(35).turnTo(turn));
    near(l, -r, 1e-6, 'mirror at ' + turn + '°');
  });
});


/* ===================================================================== */
group('5. Centering');

test('returning to the calibrated pose returns the value to 0', () => {
  const w = wheelAt(35);
  w.turnTo(70);
  near(value(w.turnTo(0)), 0, 1e-9, 'back at centre');
});

test('a smoothed value converges back to 0 after the wheel is released', () => {
  const f = new M.OneEuro(2.5, 0.02);
  f.reset(60); f.primed = true;
  for (let i = 0; i < 90; i++) f.update(0, 1 / 60);
  ok(Math.abs(f.x) < 0.5, 'did not settle, got ' + f.x);
});

test('the sweep through centre passes through zero only inside the dead zone', () => {
  const w = wheelAt(35);
  const zeros = [];
  for (let t = -20; t <= 20; t += 0.5) {
    if (value(w.turnTo(t, 0.5)) === 0) zeros.push(t);
  }
  ok(zeros.length > 0, 'never reached zero');
  ok(Math.min(...zeros) >= -3.001 && Math.max(...zeros) <= 3.001, 'zero band wider than the dead zone');
});


/* ===================================================================== */
group('6. Dead zone');

test('small wobble inside the dead zone is suppressed entirely', () => {
  const s = { sensitivity: 1, deadZone: 5, maxAngle: 90 };
  [0, 1.5, -2, 4.9, -4.9].forEach(a => near(M.computeSteeringValue(a, s), 0, 0, 'angle ' + a));
});

test('just outside the dead zone the output is small, not a jump', () => {
  const s = { sensitivity: 1, deadZone: 5, maxAngle: 90 };
  const v = M.computeSteeringValue(5.5, s);
  ok(v > 0 && v < 1.5, 'expected a tiny positive value, got ' + v);
});

test('dead zone is subtracted, not clipped — full range is preserved', () => {
  const s = { sensitivity: 1, deadZone: 10, maxAngle: 90 };
  near(M.computeSteeringValue(90, s), 100, 1e-9, 'at max angle');
  near(M.computeSteeringValue(50, s), 50, 1e-9, 'halfway through the usable span');
});

test('a zero dead zone passes the angle straight through', () => {
  near(M.computeSteeringValue(45, { sensitivity: 1, deadZone: 0, maxAngle: 90 }), 50, 1e-9);
});

test('dead zone never inverts the sign', () => {
  const s = { sensitivity: 1, deadZone: 6, maxAngle: 90 };
  for (let a = -90; a <= 90; a += 1.5) {
    const v = M.computeSteeringValue(a, s);
    ok(v === 0 || Math.sign(v) === Math.sign(a), 'sign flipped at ' + a);
  }
});


/* ===================================================================== */
group('7. Sensitivity');

test('2x sensitivity doubles the value below saturation', () => {
  const base = { sensitivity: 1, deadZone: 0, maxAngle: 90 };
  const fast = { sensitivity: 2, deadZone: 0, maxAngle: 90 };
  near(M.computeSteeringValue(30, fast), M.computeSteeringValue(30, base) * 2, 1e-9);
});

test('0.5x sensitivity halves it', () => {
  near(M.computeSteeringValue(90, { sensitivity: 0.5, deadZone: 0, maxAngle: 90 }), 50, 1e-9);
});

test('3x sensitivity reaches full lock at a third of the angle', () => {
  const s = { sensitivity: 3, deadZone: 0, maxAngle: 90 };
  near(M.computeSteeringValue(30, s), 100, 1e-9);
  near(M.computeSteeringValue(90, s), 100, 1e-9, 'stays clamped past full lock');
});

test('sensitivity never breaks the -100..100 contract', () => {
  for (let sens = 0.5; sens <= 3.001; sens += 0.1) {
    for (let a = -720; a <= 720; a += 13) {
      const v = M.computeSteeringValue(a, { sensitivity: sens, deadZone: 3, maxAngle: 90 });
      ok(v >= -100 && v <= 100, 'out of range: ' + v + ' (sens ' + sens + ', angle ' + a + ')');
    }
  }
});


/* ===================================================================== */
group('8. Steering normalisation');

test('max steering angle maps exactly to ±100', () => {
  [30, 60, 90, 120, 180, 360, 540].forEach(max => {
    const s = { sensitivity: 1, deadZone: 0, maxAngle: max };
    near(M.computeSteeringValue(max, s), 100, 1e-9, 'max ' + max + '°');
    near(M.computeSteeringValue(-max, s), -100, 1e-9, 'max ' + max + '° left');
    near(M.computeSteeringValue(max / 2, s), 50, 1e-9, 'half of ' + max + '°');
  });
});

test('over-rotating past the max angle clamps instead of wrapping', () => {
  const s = { sensitivity: 1, deadZone: 0, maxAngle: 90 };
  near(M.computeSteeringValue(150, s), 100, 1e-9);
  near(M.computeSteeringValue(-150, s), -100, 1e-9);
  near(M.computeSteeringValue(2000, s), 100, 1e-9);
});

test('a narrow max angle makes the wheel more sensitive, as expected', () => {
  const narrow = { sensitivity: 1, deadZone: 0, maxAngle: 30 };
  const wide = { sensitivity: 1, deadZone: 0, maxAngle: 180 };
  ok(M.computeSteeringValue(25, narrow) > M.computeSteeringValue(25, wide), 'narrow should react harder');
});

test('end to end: a real 45° turn on a 90° wheel reads +50', () => {
  const a = wheelAt(30).turnTo(45);
  near(M.computeSteeringValue(a, { sensitivity: 1, deadZone: 0, maxAngle: 90 }), 50, 1e-6);
});


/* ===================================================================== */
group('9. Large turns and multiple rotations');

test('REGRESSION: turning past 180° does not flip to the opposite lock', () => {
  const w = wheelAt(35);
  const a = w.turnTo(200);
  near(a, 200, 1e-5, 'angle past half a turn');
  ok(a > 0, 'angle went negative — the wrap bug is back');
  ok(value(a) === 100, 'value should stay pinned at full right, got ' + value(a));
});

test('a full 360° turn reads as a full turn, not zero', () => {
  near(wheelAt(35).turnTo(360), 360, 1e-5);
});

test('several full rotations keep counting in both directions', () => {
  [720, 1080, -720, -1080].forEach(target => {
    near(wheelAt(35).turnTo(target), target, 1e-4, 'turning to ' + target + '°');
  });
});

test('value stays pinned at full lock throughout a multi-turn sweep', () => {
  const w = wheelAt(35);
  for (let t = 90; t <= 1080; t += 10) {
    const v = value(w.turnTo(t));
    ok(v === 100, 'lost full lock at ' + t + '°, got ' + v);
  }
});

test('unwinding several turns comes back through centre correctly', () => {
  const w = wheelAt(35);
  w.turnTo(900);
  near(w.turnTo(0), 0, 1e-4, 'back at centre');
  const back = w.turnTo(-450);
  near(back, -450, 1e-4, 'and on round the other way');
  near(value(back), -100, 0, 'still full left');
});

test('a 540° wheel gives proportional output across its whole range', () => {
  const s = { sensitivity: 1, deadZone: 0, maxAngle: 540 };
  const w = wheelAt(35);
  near(M.computeSteeringValue(w.turnTo(135), s), 25, 1e-4, 'quarter lock');
  near(M.computeSteeringValue(w.turnTo(270), s), 50, 1e-4, 'half lock');
  near(M.computeSteeringValue(w.turnTo(540), s), 100, 1e-4, 'full lock');
});

test('the value never jumps discontinuously across the old ±180 seam', () => {
  const s = { sensitivity: 1, deadZone: 0, maxAngle: 360 };
  const w = wheelAt(35);
  let prev = M.computeSteeringValue(w.turnTo(150), s);
  for (let t = 152; t <= 220; t += 2) {
    const v = M.computeSteeringValue(w.turnTo(t), s);
    ok(Math.abs(v - prev) < 2, 'discontinuity at ' + t + '°: ' + prev + ' -> ' + v);
    prev = v;
  }
});


/* ===================================================================== */
group('10. Filtering: smooth at rest, responsive while turning');

test('One Euro settles to a held value', () => {
  const f = new M.OneEuro(2.5, 0.02);
  for (let i = 0; i < 120; i++) f.update(40, 1 / 60);
  near(f.x, 40, 0.5, 'settled value');
});

test('One Euro suppresses jitter while the wheel is held still', () => {
  const f = new M.OneEuro(2.5, 0.02);
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    const noisy = Math.sin(i * 1.7) * 0.6;          // ±0.6° of sensor noise
    const out = f.update(noisy, 1 / 60);
    if (i > 60) worst = Math.max(worst, Math.abs(out));
  }
  ok(worst < 0.35, 'noise got through: ±' + worst.toFixed(3) + '°');
});

test('One Euro tracks a fast turn far more closely than a heavy fixed filter', () => {
  const rate = 300;                                  // deg/sec — a quick flick
  const euro = new M.OneEuro(2.5, 0.02);
  const fixed = new M.LowPass(0.10);
  let truth = 0, eErr = 0, fErr = 0;
  for (let i = 0; i < 30; i++) {
    truth += rate / 60;
    eErr = Math.abs(truth - euro.update(truth, 1 / 60));
    fErr = Math.abs(truth - fixed.update(truth, 1 / 60));
  }
  ok(eErr < fErr, 'One Euro lag ' + eErr.toFixed(1) + '° vs fixed ' + fErr.toFixed(1) + '°');
  ok(eErr < 12, 'still lagging ' + eErr.toFixed(1) + '° behind a fast turn');
});

test('One Euro is frame-rate independent', () => {
  const run = (dt, steps) => {
    const f = new M.OneEuro(2.5, 0.02);
    f.update(0, dt);
    for (let i = 0; i < steps; i++) f.update(50, dt);
    return f.x;
  };
  near(run(1 / 60, 60), run(1 / 20, 20), 4, 'fast vs slow sensor after 1s');
});

test('One Euro handles continuous angles beyond 360 without wrapping', () => {
  const f = new M.OneEuro(2.5, 0.02);
  for (let i = 0; i < 400; i++) f.update(900, 1 / 60);
  near(f.x, 900, 1, 'should track 900°, not fold it');
});


/* ===================================================================== */
group('11. Flat-phone fallback');

test('an upright phone is tracked by tilt alone', () => {
  const gv = M.gravityFromEuler(0, 90, 0);
  near(M.tiltMagnitude(gv), 1, 1e-9, 'tilt');
  near(M.blendWeight(M.tiltMagnitude(gv)), 1, 1e-9, 'weight');
});

test('a wheel-mounted phone (35° lean) still tracks purely on tilt', () => {
  const p = pose(35, 0);
  near(M.blendWeight(M.tiltMagnitude(M.gravityFromEuler(p.alpha, p.beta, p.gamma))), 1, 1e-9);
});

test('a nearly flat phone hands over to yaw instead of going wild', () => {
  const p = pose(85, 0);                       // 5° off horizontal
  const gv = M.gravityFromEuler(p.alpha, p.beta, p.gamma);
  ok(M.blendWeight(M.tiltMagnitude(gv)) === 0, 'should have fully handed over to yaw');
  near(M.yawIncrement(80, 110, -1), 30, 1e-9, 'screen-up: falling alpha is a right turn');
});

test('yaw fallback wraps cleanly across the 0/360 compass seam', () => {
  near(M.yawIncrement(5, 355, -1), -10, 1e-9, 'crossing 360→0');
  near(M.yawIncrement(355, 5, -1), 10, 1e-9, 'crossing 0→360');
});

test('yaw fallback flips sign when the phone faces the other way', () => {
  near(M.yawIncrement(80, 110, -1), -M.yawIncrement(80, 110, 1), 1e-9);
});

test('yaw increments accumulate past a full rotation', () => {
  let total = 0, a = 0;
  for (let i = 0; i < 90; i++) {            // 90 steps of -8° = -720° of alpha
    const next = (a - 8 + 360) % 360;
    total += M.yawIncrement(next, a, -1);
    a = next;
  }
  near(total, 720, 1e-6, 'two full turns to the right');
});


/* ===================================================================== */
group('12. Full simulated drive');

test('a complete left→centre→right sweep behaves sanely', () => {
  const w = wheelAt(32);
  const f = new M.OneEuro(2.5, 0.02);
  const path = [];
  for (let t = 0; t < 120; t++) {
    const turn = 70 * Math.sin((t / 120) * Math.PI * 2);
    const a = f.update(w.at(turn), 1 / 60);
    path.push(value(a));
  }
  ok(Math.min(...path) < -60, 'never steered meaningfully left');
  ok(Math.max(...path) > 60, 'never steered meaningfully right');
  ok(path.every(v => v >= -100 && v <= 100), 'left the -100..100 range');
  for (let i = 1; i < path.length; i++) {
    ok(Math.abs(path[i] - path[i - 1]) < 12, 'jitter spike at frame ' + i);
  }
});

test('a hard lock-to-lock swing stays continuous', () => {
  const w = wheelAt(32);
  const s = { sensitivity: 1, deadZone: 2, maxAngle: 270 };
  let prev = M.computeSteeringValue(w.turnTo(-400), s);
  for (let t = -396; t <= 400; t += 4) {
    const v = M.computeSteeringValue(w.turnTo(t), s);
    ok(Math.abs(v - prev) < 4, 'jump at ' + t + '°: ' + prev + ' -> ' + v);
    prev = v;
  }
  near(prev, 100, 0, 'ends at full right lock');
});


/* ===================================================================== */
console.log('\n' + '─'.repeat(52));
console.log(failed === 0
  ? '\x1b[32m' + passed + ' passed, 0 failed\x1b[0m'
  : '\x1b[31m' + passed + ' passed, ' + failed + ' FAILED\x1b[0m');
if (failed) { fails.forEach(f => console.log('  • ' + f)); process.exit(1); }
