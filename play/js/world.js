// world.js — pure Node port of the Fruit Fly World dish (the autopilot lane).
//
// Bit-exact equivalence target: what the browser's headless
// GameScene.autopilot({seed, brain, gens}) produces for deterministic brains
// (genes / circuit / judgment-local), run at the fixed 60 Hz cadence
// (this.update(frames*DT, DT), DT = 1000/60).
//
// Ported field-by-field from public/play/js/scene-game.js (flyline). Everything
// render-only (sprites, tweens, audio, HUD, floaters, replay buffer, camera
// shake, stink lines) is dropped; every line that touches sim state is kept in
// the original order, because the world RNG (one seeded mulberry32 stream, see
// sim.js seedRng/rng) is consumed in a fixed call order and any divergence
// changes everything downstream.
//
// Two fidelity notes that are easy to get wrong:
//
//  * Decision timing. The browser autopilot drains the brain driver's pending
//    decision (a Promise.resolve microtask) at the `await Promise.resolve()`
//    at the top of each frame-loop iteration — i.e. after frame N's update,
//    before frame N+1's update. Between generations there is NO await, so a
//    decision scheduled on the final frame of gen g is applied AFTER
//    nextGen()/resetGenerationWorld() and lands as the FIRST record of gen
//    g+1's freshly reset brainLog (and overwrites lastBrainBehavior). This
//    module reuses the real createBrainDriver and replicates the exact await
//    structure in runLineage(), so that leak is reproduced automatically.
//    stepWorld() itself is synchronous: callers that step manually must yield
//    to the event loop between steps or decisions will not resolve.
//
//  * The guard-trait browser bug. In scene-game.js the "guarded" check
//    compares the fly's world coordinates against egg SPRITE pixel
//    coordinates (e.x/e.y), which are always > 0.2 world units away on any
//    real canvas — the branch can never fire. This port pins guarded=false
//    with a comment at the site, so a naive "fix" cannot silently diverge
//    from the browser baseline.
//
// Plain ESM, no DOM, no Phaser, no Math.random, no Date.now. Types: world.d.ts.

import {
  GEN_DURATION, CYCLE_SEC, FOOD_RADIUS, FOOD_SENSE, THREAT_SENSE, GRID_N, FOOD_COUNT,
  LAY_THRESHOLD, LAY_COST, LAY_CD, DASH_SPEED, DASH_TIME, DASH_CD, DASH_COST,
  PRED_BASE, PRED_LUNGE, PRED_LUNGE_RANGE, PRED_CATCH, PRED_DPS,
  GF, PRED_VISUAL, FOOD_TYPES, ODOR_TIME, NAMED_ONCE, STACKABLE, draftCards,
  clamp01, dist, normalize, makeRng, rollRivalGenes,
  recomputeStats,
  GF_PARAMS, stepGF, fireGF, makeGFState
} from "./sim.js";
import { createCircuitBrain } from "./brain-circuit.js";
import { createLocalBrain } from "./brain-local.js";
import { createBrainDriver } from "./brain-driver.js";
import { contentHash } from "./brain.js";
import { dcos, dsin, datan } from "./dmath.js";

// dish/3: all sim-lane trig/exp goes through dmath.js kernels so arm64 Chrome
// and x64 Node produce bit-identical worlds (Math.sin/cos/exp differ in the
// last ulp across architectures — see dmath.js header).
export const WORLD_VERSION = "dish/3";

// autopilot()'s deterministic default draft policy (economy first).
const PREF = ["forager", "fecund", "hardy", "thrift", "nocturnal", "white", "curly", "swift"];

const PLAYER_GENES = { food: .6, threat: .7, light: .3, novelty: .4, forage: .5 };

// ============================== world RNG ==============================
// The browser uses sim.js's single shared seedRng/rng stream. makeRng(seed)
// produces a bit-identical stream (same (s>>>0)||1 init, same update), so a
// per-world function re-seeded exactly where the scene calls seedRng() is
// indistinguishable — and safe to instantiate more than once per process.

function randomInDishR(r, maxR) {
  const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * maxR;
  return { x: dcos(a) * rr, y: dsin(a) * rr };
}

// ============================== flies ==============================
// Local makeFly/resetFly: identical to sim.js except wanderAngle is drawn from
// the caller's stream (sim.js's versions consume the shared module RNG, which
// would couple unrelated worlds in one process).

function makeFlyW(isPlayer, genes, wanderAngle) {
  const f = {
    isPlayer, x: 0, y: 0, vx: 0, vy: 0, angle: 0, energy: 100, alive: true, eggs: 0,
    wanderAngle, genes, trail: [], layCd: 0, dashT: 0, dashCdT: 0,
    odorT: 0, boostT: 0, foodBoostT: 0, pheromoneBoostT: 0, pheromoneSite: null, kbCdT: 0,
    gf: makeGFState(),
    deathReason: "", _warned: false, _diapauseNotified: false
  };
  // NB cannibalSlowT is intentionally NOT reset below (see resetFlyW) — the
  // browser's resetFly never clears it either, so it leaks across generations.
  f.cannibalSlowT = 0;
  if (isPlayer) f.traits = []; else f.rivalTraits = [];
  recomputeStats(f);
  return f;
}

function resetFlyW(world, fly, pos) {
  fly.x = pos.x; fly.y = pos.y; fly.vx = 0; fly.vy = 0; fly.alive = true; fly.eggs = 0; fly.trail = [];
  fly.layCd = LAY_CD; fly.dashT = 0; fly.dashCdT = 0; fly.odorT = 0; fly.boostT = 0;
  fly.foodBoostT = 0; fly.pheromoneBoostT = 0; fly.pheromoneSite = null; fly.kbCdT = 0;
  fly.wanderAngle = world.rng() * Math.PI * 2; recomputeStats(fly); fly.energy = fly.stats.maxEnergy;
}

// ============================== sensing ==============================

function senseScaleW(world, fly) {
  let s = fly.stats.senseMult;
  if (!fly.stats.nocturnal) s *= (1 - 0.3 * world.nightFactor);
  if (fly.stats.nightPenalty > 1) s /= 1 + (fly.stats.nightPenalty - 1) * world.nightFactor;
  if (fly.stats.clock && world.nightFactor > 0.5) s *= 0.9;
  return s;
}

function findNearestFoodW(world, fly) {
  let best = null, bd = Infinity;
  for (const f of world.food) { const d = dist(fly, f); if (d < bd) { bd = d; best = f; } }
  const sense = FOOD_SENSE * senseScaleW(world, fly) * fly.stats.foodSenseMult;
  if (!best || bd > sense) return null;
  return { dir: normalize({ x: best.x - fly.x, y: best.y - fly.y }), signal: 1 - bd / sense };
}

function findThreatW(world, fly) {
  if (!world.predator.alive) return null;
  const d = dist(fly, world.predator), sense = THREAT_SENSE * senseScaleW(world, fly);
  if (fly.stats.diapause && fly.energy < 30 && d > 0.18) return null;
  if (fly.stats.mimic && fly.vx * fly.vx + fly.vy * fly.vy < 0.004 && world.nightFactor < 0.7) return null;
  if (d > sense) return null;
  return { dirAway: normalize({ x: fly.x - world.predator.x, y: fly.y - world.predator.y }), signal: 1 - d / sense, d };
}

function lightPosW(world) {
  const a = world.genElapsed / CYCLE_SEC * Math.PI * 2;
  return { x: dcos(a) * 0.5, y: dsin(a) * 0.5 };
}

function lightSignalW(world, fly) {
  const lp = lightPosW(world);
  const d = dist(fly, lp), signal = clamp01(1 - d / 1.4);
  if (signal <= 0.02) return { signal: 0, dir: { x: 0, y: 0 } };
  return { signal, dir: normalize({ x: lp.x - fly.x, y: lp.y - fly.y }) };
}

function cellKeyOf(p) {
  const i = Math.min(GRID_N - 1, Math.max(0, Math.floor((p.x + 1) / 2 * GRID_N)));
  const j = Math.min(GRID_N - 1, Math.max(0, Math.floor((p.y + 1) / 2 * GRID_N)));
  return i + "," + j;
}

function computeSignalsW(world, fly) {
  const f = findNearestFoodW(world, fly), th = findThreatW(world, fly), l = lightSignalW(world, fly);
  // novelty: share of unvisited cells in the 3x3 neighborhood
  const key = cellKeyOf(fly).split(",");
  const i0 = +key[0], j0 = +key[1];
  let unvis = 0, total = 0;
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    const i = i0 + di, j = j0 + dj;
    if (i < 0 || j < 0 || i >= GRID_N || j >= GRID_N) continue;
    total++;
    if (!world.visitedCells.has(i + "," + j)) unvis++;
  }
  return { food: f ? f.signal : 0, threat: th ? th.signal : 0, light: l.signal, novelty: total ? unvis / total : 0 };
}

// ============================== steering ==============================

function brainSteerW(world, fly) {
  const d = world.brainDriver ? world.brainDriver.last : null;
  const beh = d ? d.behavior : "explore";
  if (beh === "freeze") return { x: 0, y: 0 };
  if (beh === "avoid") { const th = findThreatW(world, fly); if (th) return th.dirAway; }
  if (beh === "approach") { const f = findNearestFoodW(world, fly); if (f) return f.dir; }
  fly.wanderAngle += (world.rng() - 0.5) * 0.5;
  return normalize({ x: dcos(fly.wanderAngle), y: dsin(fly.wanderAngle) });
}

function decideSteerW(world, fly) {
  const s = { x: 0, y: 0 };
  const f = findNearestFoodW(world, fly);
  if (f) { const w = fly.genes.food * (0.6 + 0.8 * fly.genes.forage); s.x += f.dir.x * w * f.signal; s.y += f.dir.y * w * f.signal; }
  const th = findThreatW(world, fly);
  if (th) { s.x += th.dirAway.x * fly.genes.threat * 1.6 * th.signal; s.y += th.dirAway.y * fly.genes.threat * 1.6 * th.signal; }
  const l = lightSignalW(world, fly);
  if (l.signal > 0) { s.x += l.dir.x * fly.genes.light * l.signal; s.y += l.dir.y * fly.genes.light * l.signal; }
  fly.wanderAngle += (world.rng() - 0.5) * 0.5;
  s.x += dcos(fly.wanderAngle) * 0.12; s.y += dsin(fly.wanderAngle) * 0.12;
  return normalize(s);
}

function getSteerW(world, fly) {
  // headless autopilot: no agent API, no pointer, no keys.
  if (fly.isPlayer && world.brainDriver) return brainSteerW(world, fly);
  if (fly.isPlayer && world.driveMode === "manual") return { x: 0, y: 0 };
  const steer = decideSteerW(world, fly);
  if (fly.stats.phototax && world.nightFactor > 0.5) {
    const light = lightSignalW(world, fly);
    return normalize({ x: steer.x * 0.75 + light.dir.x * 0.25, y: steer.y * 0.75 + light.dir.y * 0.25 });
  }
  return steer;
}

// ============================== GF brainstem + dash ==============================

function updateGFW(world, fly, dt) {
  const g = fly.gf;
  let size = 0, vel = 0;
  if (world.predator.alive) {
    const d = Math.max(0.02, dist(fly, world.predator));
    const theta = 2 * datan(GF.PRED_ANG_R / d);
    vel = Math.max(0, (theta - g.prevTheta) / Math.max(dt, 1e-3));
    g.prevTheta = theta;
    if (d <= PRED_VISUAL) { size = theta; }
  } else g.prevTheta = 0;
  stepGF(g, dt, {
    size, vel, mode: world.state.connectivityMode,
    threshold: fly.stats.gfThresh, leakRate: GF_PARAMS.LEAK_RATE_GAME,
    now: world.simTime, refractory: fly.stats.dashCd * 0.5
  });
  if (g.iframe > 0) g.iframe = Math.max(0, g.iframe - dt);
}

function tryDashW(world, fly, events) {
  if (!fly.alive || fly.dashCdT > 0) return;
  const reflex = fly.gf.armed;
  const hopper = fly.stats.hopper && !reflex;
  if (!reflex && !hopper) return;
  const cost = reflex ? DASH_COST * 0.6 : DASH_COST * 1.5;
  const finalCost = fly.stats.swift && !reflex ? cost * 1.4 : cost;
  if (fly.energy < finalCost) return;
  fly.dashT = reflex ? DASH_TIME * 1.5 : DASH_TIME * 0.7;
  fly.dashCdT = fly.stats.dashCd * (hopper ? 1.5 : 1);
  fly.energy -= cost;
  fly.energy -= finalCost - cost;
  fireGF(fly.gf, world.simTime);
  if (reflex) {
    fly.gf.iframe = 0.18;
    if (fly.stats.reflexBoost) fly.boostT = 1.5;
    if (world.predator.alive) {
      const a = normalize({ x: fly.x - world.predator.x, y: fly.y - world.predator.y });
      const b = DASH_SPEED * fly.stats.speed * 1.1 * fly.stats.gfJumpMult;
      fly.vx += a.x * b; fly.vy += a.y * b;
    }
    if (fly.isPlayer) {
      world.escapesThisGen = (world.escapesThisGen || 0) + 1;
      events.push({ type: "escape", who: fly.isPlayer ? "player" : "rival" });
    }
  } else if (fly.isPlayer) {
    events.push({ type: "dash", who: "player" });
  }
}

// ============================== fly update ==============================

function relocateFoodW(world, item, fly) {
  if (fly.stats.sitter) { return; }
  const roverFactor = fly.stats.rover ? 0.15 : 0;
  if (item.type === "yeast") {
    const a = world.rng() * Math.PI * 2, rr = 0.72 + world.rng() * 0.2 + roverFactor;
    item.x = dcos(a) * Math.min(0.94, rr); item.y = dsin(a) * Math.min(0.94, rr);
  } else {
    const p = randomInDishR(world.rng, Math.min(0.94, 0.85 + roverFactor));
    item.x = p.x; item.y = p.y;
  }
}

function updateFlyW(world, fly, dt, events) {
  if (!fly.alive) return;
  fly.layCd = Math.max(0, fly.layCd - dt); fly.dashCdT = Math.max(0, fly.dashCdT - dt); fly.dashT = Math.max(0, fly.dashT - dt);
  fly.odorT = Math.max(0, fly.odorT - dt); fly.boostT = Math.max(0, fly.boostT - dt);
  fly.foodBoostT = Math.max(0, (fly.foodBoostT || 0) - dt);
  fly.pheromoneBoostT = Math.max(0, (fly.pheromoneBoostT || 0) - dt);
  fly.cannibalSlowT = Math.max(0, (fly.cannibalSlowT || 0) - dt);
  fly.kbCdT = Math.max(0, fly.kbCdT - dt);
  updateGFW(world, fly, dt);
  if (!(fly.isPlayer && world.driveMode === "manual") && fly.gf.armed) tryDashW(world, fly, events);
  const steerRaw = getSteerW(world, fly);
  const steer = fly.stats.adh && fly.boostT > 0 ? normalize({
    x: steerRaw.x * fly.stats.speedTurn + dcos(fly.angle) * (1 - fly.stats.speedTurn),
    y: steerRaw.y * fly.stats.speedTurn + dsin(fly.angle) * (1 - fly.stats.speedTurn)
  }) : steerRaw;
  const inDiapause = fly.stats.diapause && fly.energy < 30;
  const diapauseSlow = inDiapause ? 0.6 : 1;
  const diapauseMetab = inDiapause ? 0.4 : 1;
  const adhSlow = fly.stats.adh && fly.boostT > 0 ? 0.72 : 1;
  const foragerSlow = fly.stats.forager && fly.foodBoostT > 0 ? 0.82 : 1;
  const cannibalSlow = fly.cannibalSlowT > 0 ? 0.8 : 1;
  const spd = fly.stats.speed * diapauseSlow * adhSlow * foragerSlow * cannibalSlow * (fly.dashT > 0 ? DASH_SPEED : 1) * (fly.boostT > 0 ? 1.4 : 1);
  fly.vx += (steer.x * spd - fly.vx) * Math.min(1, dt * 12); fly.vy += (steer.y * spd - fly.vy) * Math.min(1, dt * 12);
  fly.x += fly.vx * dt; fly.y += fly.vy * dt;
  const r = Math.hypot(fly.x, fly.y);
  if (r > 0.96) { fly.x = fly.x / r * 0.96; fly.y = fly.y / r * 0.96; fly.vx *= -0.3; fly.vy *= -0.3; }
  if (Math.hypot(fly.vx, fly.vy) > 0.01) fly.angle = Math.atan2(fly.vy, fly.vx);
  if (fly.isPlayer) world.visitedCells.add(cellKeyOf(fly));
  const phototaxMetab = fly.stats.phototax && dist(fly, lightPosW(world)) < 0.3 ? 0.7 : 1;
  const clockMetab = fly.stats.clock ? (world.nightFactor > 0.5 ? 1.2 : 0.8) : 1;
  fly.energy -= fly.stats.metab * diapauseMetab * phototaxMetab * clockMetab * dt;

  // eat
  for (const item of world.food) {
    if (dist(fly, item) < FOOD_RADIUS) {
      const ft = FOOD_TYPES[item.type];
      const pheromoneGain = fly.pheromoneBoostT > 0 && fly.pheromoneSite && dist(item, fly.pheromoneSite) < 0.18 ? 1.5 : 1;
      fly.energy = Math.min(fly.stats.maxEnergy, fly.energy + ft.gain * fly.stats.foodMult * pheromoneGain);
      if (fly.stats.forager) { fly.foodBoostT = 1; }
      if (item.type === "rot" && !fly.stats.noOdor) { fly.odorT = ODOR_TIME; }
      events.push({ type: "eat", who: fly.isPlayer ? "player" : "rival", food: item.type });
      relocateFoodW(world, item, fly);
    }
  }
  // lay egg (eggs are plain data here; the browser uses Phaser images with
  // wx/wy world coords attached — every rule that reads eggs is ported)
  if (fly.energy >= LAY_THRESHOLD && fly.layCd <= 0) {
    fly.energy -= fly.stats.layCost; fly.eggs++; fly.layCd = LAY_CD;
    if (fly.stats.fecund) { fly.odorT = Math.max(fly.odorT, 2); }
    if (fly.stats.pheromone) {
      const site = { x: fly.x, y: fly.y, owner: fly.isPlayer ? "player" : "rival", t: 3 };
      fly.pheromoneSite = site;
      if (!fly.isPlayer && world.playerFly.stats.pheromone) {
        world.playerFly.pheromoneBoostT = 3;
        world.playerFly.pheromoneSite = { x: fly.x, y: fly.y };
      }
      if (fly.isPlayer && world.rivalFly.stats.pheromone) {
        world.rivalFly.pheromoneBoostT = 3;
        world.rivalFly.pheromoneSite = { x: fly.x, y: fly.y };
      }
    }
    world.eggs.push({ x: fly.x, y: fly.y, wx: fly.x, wy: fly.y, owner: fly.isPlayer ? "player" : "rival" });
    events.push({ type: "egg", who: fly.isPlayer ? "player" : "rival", x: fly.x, y: fly.y });
  }
  if (fly.energy <= 0) {
    fly.energy = 0; fly.alive = false;
    if (fly.isPlayer) { fly.deathReason = "energy"; events.push({ type: "death", who: "player", reason: "energy" }); }
  }
}

// ============================== predator ==============================

function predSpeedNowW(world) {
  const scale = Math.min(1.8, 1 + 0.05 * (world.state.genNumber - 1));
  return (PRED_BASE + PRED_BASE * 0.5 * world.nightFactor) * scale;
}

function updatePredatorW(world, dt, events) {
  const pr = world.predator;
  if (!pr.alive) return;
  const base = predSpeedNowW(world);
  if (pr.phase === "approach") {
    let target = null, bd = Infinity, smelly = null;
    for (const f of world.flies) { if (f.alive && f.odorT > 0) smelly = f; }
    // PARITY BUG (kept from the browser): the guard check there is
    //   eggs.some(e => e.owner==="player" && dist(this.playerFly, e) < 0.2)
    // where e.x/e.y are the egg SPRITE's pixel coordinates while playerFly is
    // in world units — always more than 0.2 apart on any real canvas, so the
    // guarded branch never fires. Pinned false here on purpose.
    const guarded = false;
    for (const f of world.flies) {
      if (!f.alive) continue;
      if (guarded && f.isPlayer) continue;
      const d = dist(pr, f);
      if (d < bd) { bd = d; target = f; }
    }
    if (smelly && (!guarded || smelly !== world.playerFly)) target = smelly;
    if (!target && !guarded && world.playerFly.alive) target = world.playerFly;
    if (!target) return;
    pr.target = target;
    if (target.odorT > 0) bd = dist(pr, target);
    const spdA = base * (target.odorT > 0 ? 1.15 : 1) * (target === world.rivalFly && world.playerFly.stats.guard ? 1.05 : 1);
    const dir = normalize({ x: target.x - pr.x, y: target.y - pr.y });
    pr.vx += (dir.x * spdA - pr.vx) * Math.min(1, dt * 6); pr.vy += (dir.y * spdA - pr.vy) * Math.min(1, dt * 6);
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
    if (bd < PRED_LUNGE_RANGE) {
      const ld = Math.hypot(target.x - pr.x, target.y - pr.y) || 1;
      pr.lungeDir = { x: (target.x - pr.x) / ld, y: (target.y - pr.y) / ld };
      pr.phase = "lunge"; pr.lungeT = 0;
      world.slowmoT = 0.30; // the commit moment — this feeds dtScale in stepWorld
      events.push({ type: "lunge" });
    }
  } else if (pr.phase === "lunge") {
    pr.lungeT += dt;
    const lspd = base * (PRED_LUNGE / PRED_BASE);
    pr.vx = pr.lungeDir.x * lspd; pr.vy = pr.lungeDir.y * lspd;
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
    const r = Math.hypot(pr.x, pr.y);
    if (pr.lungeT > 0.45 || r > 0.95) { pr.phase = "recover"; pr.recoverT = 0; }
  } else {
    pr.recoverT += dt;
    pr.vx *= 0.85; pr.vy *= 0.85;
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
    if (pr.recoverT > 0.5) pr.phase = "approach";
  }
  const rr = Math.hypot(pr.x, pr.y);
  if (rr > 0.98) { pr.x = pr.x / rr * 0.98; pr.y = pr.y / rr * 0.98; }
  pr.angle = Math.atan2(pr.vy, pr.vx); pr.legPhase += dt * 14;

  for (const f of world.flies) {
    if (f.stats.cannibal && f.isPlayer && world.rivalFly.alive && dist(f, world.rivalFly) < 0.14) {
      f.energy = Math.min(f.stats.maxEnergy, f.energy + 2 * dt);
      world.rivalFly.energy = Math.max(0, world.rivalFly.energy - 2 * dt);
      world.rivalFly.cannibalSlowT = 0.3;
      if (!f.stats.noOdor) f.odorT = Math.max(f.odorT, 1.2);
    }
    // guard: predator eats the player's eggs when passing over the cluster
    // (note: this check correctly uses wx/wy world coords, unlike the
    // "guarded" targeting check above)
    for (const egg of world.eggs) {
      if (world.playerFly.stats.guard && egg.owner === "player" && dist(pr, { x: egg.wx, y: egg.wy }) < PRED_CATCH * 1.5) {
        world.eggs.splice(world.eggs.indexOf(egg), 1);
        world.playerFly.eggs = Math.max(0, world.playerFly.eggs - 1);
        events.push({ type: "eggLost" });
        break;
      }
    }
    if (f.alive && f.gf.iframe <= 0 && dist(pr, f) < PRED_CATCH) {
      if (f.stats.tiger && f.kbCdT <= 0) {
        f.kbCdT = 8;
        const ka = normalize({ x: pr.x - f.x, y: pr.y - f.y });
        pr.vx += ka.x * 1.6; pr.vy += ka.y * 1.6; pr.phase = "recover"; pr.recoverT = -0.7; f.gf.iframe = 0.25;
        events.push({ type: "tiger", who: f.isPlayer ? "player" : "rival" });
        continue;
      }
      f.energy -= PRED_DPS * f.stats.predDmg * dt;
      if (f.energy <= 0) {
        f.energy = 0; f.alive = false;
        if (f.isPlayer) { f.deathReason = "predator"; events.push({ type: "death", who: "player", reason: "predator" }); }
      }
    }
  }
  if (world.playerFly.alive) {
    const pd = dist(pr, world.playerFly);
    if (pd < 0.35) world.dangerFlash = Math.max(world.dangerFlash, (0.35 - pd) / 0.35 * 0.8);
  }
}

// ============================== brain layer ==============================

function updateBrainW(world, dt) {
  if (!world.brainDriver) return;
  // Real driver + real brains: the decision lands as a Promise microtask, at
  // exactly the moment the browser's per-frame await drains it (see header).
  world.brainDriver.update(world.simTime, dt,
    () => ({
      signals: computeSignalsW(world, world.playerFly), energy: world.playerFly.energy,
      timeLeft: world.genTimeLeft, behavior: world.lastBrainBehavior
    }),
    res => {
      world.lastBrainBehavior = res.behavior;
      world.brainLog.push(res.record);
      if (world.brainLog.length > 2000) world.brainLog.shift();
    });
}

function attachBrainW(world, id) {
  world.brainLog = []; world.lastBrainBehavior = "explore";
  if (id === "circuit") {
    world.brainDriver = createBrainDriver({
      brain: createCircuitBrain({ seed: (world.seed ^ 0xC0FFEE) >>> 0 }),
      intervalSec: 0.1
    });
  } else if (id === "judgment") {
    // headless judgment = the local heuristic (the remote oracle lane is a
    // browser-only, wall-time-paced feature and is intentionally not ported)
    world.brainDriver = createBrainDriver({
      brain: createLocalBrain(), intervalSec: 0.5
    });
  } else world.brainDriver = null;
  if (id !== "manual") world.driveMode = "auto";
  else if (world.driveMode === "auto") world.driveMode = "manual";
}

// ============================== generation flow ==============================

function resetGenerationWorld(world) {
  const gen = world.state.genNumber;
  // seedRng(worldSeed + gen*2654435761): identical stream init (>>>0 ||1).
  world.rng = makeRng(world.state.worldSeed + gen * 2654435761);
  world.food = [];
  const nSugar = Math.max(4, FOOD_COUNT - Math.floor((gen - 1) / 2)), nYeast = 2 + Math.floor(gen / 4), nRot = 2 + Math.floor(gen / 5);
  for (let i = 0; i < nSugar; i++) { const p = randomInDishR(world.rng, 0.85); world.food.push({ x: p.x, y: p.y, type: "sugar" }); }
  for (let i = 0; i < nYeast; i++) { const a = world.rng() * Math.PI * 2, r = 0.72 + world.rng() * 0.2; world.food.push({ x: dcos(a) * r, y: dsin(a) * r, type: "yeast" }); }
  for (let i = 0; i < nRot; i++) { const p = randomInDishR(world.rng, 0.85); world.food.push({ x: p.x, y: p.y, type: "rot" }); }

  world.eggs = [];
  world.genTimeLeft = GEN_DURATION; world.genElapsed = 0; world.nightFactor = 0; world.ended = false;
  // fresh brain each generation — EXCEPT the driver's pending microtask from
  // the previous gen, which the browser applies after this reset (see header).
  world.brainLog = []; world.lastBrainBehavior = "explore"; world.escapesThisGen = 0;
  if (world.brainDriver) world.brainDriver.reset();

  world.playerFly.traits = world.state.ownedTraits;
  resetFlyW(world, world.playerFly, { x: 0, y: 0 });
  world.playerFly.deathReason = "";
  // dish/2 determinism fix: the rival's genes re-derive from the world seed
  // every generation (idempotent) so autopilot/bench/setSeed runs no longer
  // depend on genes rolled at page-load time.
  world.rivalFly.genes = rollRivalGenes(world.state.worldSeed);
  // rival arms race: one deterministic mutation per gen (gen > 1)
  if (world.savedRivalSnapshot) { world.rivalFly.rivalTraits = world.savedRivalSnapshot.slice(); world.savedRivalSnapshot = null; }
  const poolR = NAMED_ONCE.concat(STACKABLE).filter(t => STACKABLE.includes(t) || !world.rivalFly.rivalTraits.includes(t));
  if (poolR.length && gen > 1) {
    const pick = poolR[Math.floor(world.rng() * poolR.length)];
    world.rivalFly.rivalTraits.push(pick);
  }
  resetFlyW(world, world.rivalFly, randomInDishR(world.rng, 0.5));

  const pp = randomInDishR(world.rng, 0.9);
  Object.assign(world.predator, { x: pp.x, y: pp.y, vx: 0, vy: 0, alive: true, phase: "approach", lungeT: 0, recoverT: 0 });
  world.running = true;
}

function genResult(world, g, log) {
  return {
    gen: g,
    eggs: world.playerFly.eggs,
    rivalEggs: world.rivalFly.eggs,
    survived: world.playerFly.alive,
    deathReason: world.playerFly.alive ? "time" : (world.playerFly.deathReason || "predator"),
    decisions: log.length,
    logHash: contentHash(log.map(r => r.contentHash))
  };
}

// ============================== public API ==============================

export function createWorld(opts = {}) {
  // autopilot(): (opts.seed || state.worldSeed || 42) >>> 0 — on a fresh
  // browser profile state.worldSeed is 1337, so a missing/0 seed resolves to
  // 1337 there. Replicated (pass an explicit seed to avoid the edge case).
  const s = ((opts.seed ?? 0) || 1337) >>> 0;
  const brainId = ["circuit", "judgment", "genes", "manual"].includes(opts.brain) ? opts.brain : "circuit";
  const gens = Math.max(1, Math.min(8, opts.gens || 3));

  // The rival's genes are a pure function of the run seed (rollRivalGenes,
  // re-rolled by resetGenerationWorld in the browser — dish/2). Before the
  // fix the browser rolled them once at scene create() from the PAGE-LOAD
  // world seed and never re-rolled, so the same (seed, brain) run depended on
  // the visitor's localStorage. rivalGeneSeed overrides for experiments.
  const geneSeed = (opts.rivalGeneSeed ?? s) >>> 0;
  const grng = makeRng(geneSeed);
  const playerWander = grng() * Math.PI * 2;
  const rivalGenes = rollRivalGenes(geneSeed);
  const playerFly = makeFlyW(true, PLAYER_GENES, playerWander);
  const rivalFly = makeFlyW(false, rivalGenes, grng() * Math.PI * 2);

  const world = {
    version: WORLD_VERSION,
    seed: s, brain: brainId, gens,
    state: {
      genNumber: 1, ownedTraits: [], rivalTraits: [], worldSeed: s,
      connectivityMode: "real", lineageEggs: 0, bestEggs: 0, eggsHistory: [], brainId: brainId
    },
    playerFly, rivalFly, flies: [playerFly, rivalFly],
    predator: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, alive: true, legPhase: 0, phase: "approach", lungeDir: { x: 0, y: 0 }, lungeT: 0, recoverT: 0, target: null },
    food: [], eggs: [],
    simTime: 0, genElapsed: 0, genTimeLeft: GEN_DURATION, nightFactor: 0,
    visitedCells: new Set(), slowmoT: 0, dangerFlash: 0,
    running: false, started: false, ended: false,
    driveMode: "manual",
    brainLog: [], lastBrainBehavior: "explore",
    brainDriver: null, escapesThisGen: 0, savedRivalSnapshot: null,
    rng: makeRng(1) // replaced by resetGenerationWorld() below
  };

  attachBrainW(world, brainId);
  // ---- autopilot()'s one-time pre-reset (mirrors what it resets here vs
  // what resetGenerationWorld resets — the difference is deliberate) ----
  world.started = true;
  world.visitedCells = new Set(); world.simTime = 0; world.slowmoT = 0; world.dangerFlash = 0;
  world.savedRivalSnapshot = null;
  world.predator.target = null; world.predator.angle = 0;
  world.predator.lungeDir = { x: 0, y: 0 }; world.predator.legPhase = 0;
  world.playerFly.gf = makeGFState(); world.rivalFly.gf = makeGFState();
  world.escapesThisGen = 0;
  resetGenerationWorld(world);
  return world;
}

// One fixed step (dt in seconds; the autopilot passes (1000/60)/1000, which is
// bit-identical to 1/60). Returns this frame's events (informational only).
// Decisions resolve as microtasks: await between steps (runLineage does).
export function stepWorld(world, dt) {
  const events = [];
  const dtReal = Math.min(dt, 0.1);
  // slow-mo window right after a lunge commit (dtScale arithmetic kept exact)
  if (world.slowmoT > 0) world.slowmoT -= dtReal;
  const dtScale = world.slowmoT > 0 ? 0.35 : 1;

  if (world.running && !world.ended && world.started) {
    const dtSim = dtReal * dtScale;
    world.simTime += dtSim; world.genElapsed += dtSim;
    world.nightFactor = (1 - dcos(2 * Math.PI * world.genElapsed / CYCLE_SEC)) / 2;
    updateFlyW(world, world.playerFly, dtSim, events);
    updateFlyW(world, world.rivalFly, dtSim, events);
    updatePredatorW(world, dtSim, events);
    updateBrainW(world, dtSim);
    world.genTimeLeft -= dtSim;
    if (!world.playerFly.alive || world.genTimeLeft <= 0) endGeneration(world);
  }
  world.dangerFlash = Math.max(0, world.dangerFlash - dtReal * 2.2);
  return events;
}

// Scene endGeneration(): closes the generation (idempotent) and returns the
// per-gen record — computed from brainLog as it stands NOW (the browser's
// autopilot slices the log before any pending decision can drain).
export function endGeneration(world) {
  if (world.ended) return null;
  world.ended = true; world.running = false;
  const eggs = world.playerFly.eggs;
  world.state.eggsHistory.push(eggs); if (world.state.eggsHistory.length > 30) world.state.eggsHistory.shift();
  world.state.lineageEggs += eggs;
  if (eggs > world.state.bestEggs) world.state.bestEggs = eggs;
  return genResult(world, world.state.genNumber, world.brainLog);
}

// Scene nextGen(): inherit a mutation, bump the gen, rebuild the world.
export function nextGeneration(world, traitId) {
  world.state.ownedTraits.push(traitId);
  world.state.genNumber += 1;
  resetGenerationWorld(world);
  return world;
}

// Full autopilot-equivalent run. Async by necessity: the per-frame
// `await Promise.resolve()` is what drains the brain driver's decision
// microtask at exactly the moment the browser's autopilot does — including
// the cross-generation boundary, where the final pending decision of gen g
// lands in gen g+1's reset brainLog (faithful to the browser; do not "fix").
export async function runLineage(opts = {}) {
  const world = createWorld(opts);
  const policy = typeof opts.policy === "function" ? opts.policy : null;
  const DT = 1000 / 60;
  const out = [];
  for (let g = 1; g <= world.gens; g++) {
    let frames = 0;
    while (!world.ended && frames < GEN_DURATION * 60 + 240) {
      await Promise.resolve();
      stepWorld(world, DT / 1000); frames++;
    }
    const log = world.brainLog.slice();
    const eggs = world.playerFly.eggs, rivalEggs = world.rivalFly.eggs;
    const rec = genResult(world, g, log);
    out.push({
      gen: rec.gen, eggs: rec.eggs, rivalEggs: rec.rivalEggs,
      win: eggs >= rivalEggs,
      survived: rec.survived, deathReason: rec.deathReason,
      escapes: world.escapesThisGen || 0, decisions: rec.decisions, logHash: rec.logHash,
      brainModel: world.brainDriver ? world.brainDriver.model : "player",
      log
    });
    if (g < world.gens) {
      const cards = draftCards(world.seed, world.state.genNumber,
        world.playerFly.eggs, world.rivalFly.eggs, world.state.ownedTraits);
      const q = {
        cards, state: {
          gen: world.state.genNumber, eggs: world.playerFly.eggs,
          rivalEggs: world.rivalFly.eggs, ownedTraits: world.state.ownedTraits.slice(),
          lineageEggs: world.state.lineageEggs
        }
      };
      let pick = policy ? policy(q.cards, q.state) : null;
      if (!cards.includes(pick)) pick = PREF.find(t => cards.includes(t)) || cards[0];
      nextGeneration(world, pick);
    }
  }
  return out;
}
