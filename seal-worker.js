// seal-worker.js — pre-seals the MuseFly Genesis claim OFF the main thread.
// world.js is deterministic and DOM-free, so running it in a dedicated module
// Worker yields byte-identical records to the page/main-thread path AND the
// server replay — while the live Phaser game keeps its own sim.js RNG stream
// untouched (they used to share one module instance: the background seal
// re-seeded the global RNG mid-game and its microtask loop froze the page).
self.onmessage = async (e) => {
  const { seed, plan, brain, gens } = e.data || {};
  try {
    const world = await import("/play/js/world.js");
    const policy = (cards) => (plan || []).find((t) => cards.includes(t)) ?? null;
    const run = await world.runLineage({ seed, brain, gens, policy });
    const F = ["gen", "eggs", "rivalEggs", "survived", "deathReason", "decisions", "logHash"];
    self.postMessage({ gens: run.map((g) => Object.fromEntries(F.map((f) => [f, g[f]]))) });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
