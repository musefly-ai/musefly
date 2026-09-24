// Type declarations for the pure-Node dish world (plain ESM, no build step).
// Implementation: js/world.js — a bit-exact port of the browser autopilot lane
// (public/play/js/scene-game.js). Only the public surface is declared.
import type { BrainDriver } from "./brain-driver.js";
import type { GFNeuronState } from "./gf-neuron.js";

export declare const WORLD_VERSION: "dish/1";

export type BrainId = "genes" | "circuit" | "judgment" | "manual";

export interface WorldOptions {
  /** World seed (>>>0). Missing/0 falls back to 1337, like a fresh browser profile. */
  seed?: number;
  /** Which brain drives the player fly. Default "circuit". */
  brain?: string;
  /** Generation count, clamped to 1..8. Default 3. */
  gens?: number;
  /**
   * Seed of the stream the rival fly's genes were rolled from at scene
   * create() — 1337 on a fresh browser profile (the autopilot never re-rolls
   * them). Override only for experiments.
   */
  rivalGeneSeed?: number;
  /** Draft policy: (cards, state) => traitId; result must be in cards. */
  policy?: (cards: string[], state: DraftState) => string | null | undefined;
}

export interface DraftState {
  gen: number;
  eggs: number;
  rivalEggs: number;
  ownedTraits: string[];
  lineageEggs: number;
}

export interface WorldFly {
  isPlayer: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  energy: number;
  alive: boolean;
  eggs: number;
  wanderAngle: number;
  genes: { food: number; threat: number; light: number; novelty: number; forage: number };
  layCd: number;
  dashT: number;
  dashCdT: number;
  odorT: number;
  boostT: number;
  foodBoostT: number;
  pheromoneBoostT: number;
  pheromoneSite: { x: number; y: number } | null;
  kbCdT: number;
  cannibalSlowT: number;
  deathReason: string;
  gf: GFNeuronState;
  traits?: string[];
  rivalTraits?: string[];
  stats?: Record<string, number | boolean>;
}

export interface WorldPredator {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  alive: boolean;
  legPhase: number;
  phase: "approach" | "lunge" | "recover";
  lungeDir: { x: number; y: number };
  lungeT: number;
  recoverT: number;
  target: WorldFly | null;
}

export interface WorldEgg {
  x: number;
  y: number;
  wx: number;
  wy: number;
  owner: "player" | "rival";
}

export interface WorldFood {
  x: number;
  y: number;
  type: "sugar" | "yeast" | "rot";
}

export interface World {
  readonly version: string;
  readonly seed: number;
  readonly brain: string;
  readonly gens: number;
  state: {
    genNumber: number;
    ownedTraits: string[];
    rivalTraits: string[];
    worldSeed: number;
    connectivityMode: string;
    lineageEggs: number;
    bestEggs: number;
    eggsHistory: number[];
    brainId: string;
  };
  playerFly: WorldFly;
  rivalFly: WorldFly;
  flies: WorldFly[];
  predator: WorldPredator;
  food: WorldFood[];
  eggs: WorldEgg[];
  simTime: number;
  genElapsed: number;
  genTimeLeft: number;
  nightFactor: number;
  visitedCells: Set<string>;
  slowmoT: number;
  dangerFlash: number;
  running: boolean;
  started: boolean;
  ended: boolean;
  driveMode: string;
  brainLog: unknown[];
  lastBrainBehavior: string;
  brainDriver: BrainDriver | null;
  escapesThisGen: number;
}

export type WorldEvent =
  | { type: "egg"; who: "player" | "rival"; x: number; y: number }
  | { type: "eat"; who: "player" | "rival"; food: "sugar" | "yeast" | "rot" }
  | { type: "death"; who: "player"; reason: "energy" | "predator" }
  | { type: "escape"; who: "player" | "rival" }
  | { type: "dash"; who: "player" }
  | { type: "lunge" }
  | { type: "tiger"; who: "player" | "rival" }
  | { type: "eggLost" };

export interface GenResult {
  gen: number;
  eggs: number;
  rivalEggs: number;
  survived: boolean;
  deathReason: "time" | "energy" | "predator" | string;
  decisions: number;
  logHash: string;
}

export interface LineageGenResult extends GenResult {
  win: boolean;
  escapes: number;
  brainModel: string;
  log: unknown[];
}

export declare function createWorld(opts?: WorldOptions): World;
/**
 * Advance one fixed step (dt in seconds; the autopilot passes (1000/60)/1000,
 * bit-identical to 1/60). Returns this frame's events (informational only).
 * Brain decisions resolve as microtasks: await between steps (runLineage does).
 */
export declare function stepWorld(world: World, dt?: number): WorldEvent[];
/** Close the generation (idempotent) and return its per-gen result, or null if already ended. */
export declare function endGeneration(world: World): GenResult | null;
/** Inherit a mutation, bump the generation, rebuild the world. */
export declare function nextGeneration(world: World, traitId: string): World;
/** Full autopilot-equivalent run (fixed 60 Hz, default draft policy unless overridden). */
export declare function runLineage(opts?: WorldOptions): Promise<LineageGenResult[]>;
