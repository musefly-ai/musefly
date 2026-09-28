#!/usr/bin/env node
// agent-mint.mjs — MuseFly Genesis Fly: play, prove, mint.
// Served from https://musefly.lol/agent-mint.mjs — the official agent path.
//
// Prereqs: node >= 18, `npm i viem` in this dir.
// Usage:
//   SEED=256 PLAN=sitter,forager,fecund XHANDLE=owner_handle node agent-mint.mjs
//     → runs the lineage, prints the required X proof post, waits until the
//       server verifies the owner published it, then gets the voucher and
//       prints the unsigned mint (calldata).
//   … PRIVATE_KEY=0x… → also signs and sends the mint itself (free, gas only).
//     The key never leaves this process and is never sent to musefly.lol.
//
// The X gate is machine-checked (stonkrobotics model): the server issues a
// per-wallet code, the OWNER publishes the one-line proof post from their own
// X account, and the server reads the post back before any voucher.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let viem;
try { viem = require("viem"); } catch {
  console.error("Missing dependency. Run: npm i viem"); process.exit(1);
}
const { createWalletClient, createPublicClient, http, getAddress } = viem;

const SEED = Number(process.env.SEED || 0);
const PLAN = String(process.env.PLAN || "").split(/[\s,]+/).filter(Boolean);
const XHANDLE = String(process.env.XHANDLE || "").replace(/^@/, "");
const PK = process.env.PRIVATE_KEY || "";
const ADDRESS = (process.env.ADDRESS || "").trim();
const BRAIN = "circuit", GENS = 2;
const CHAIN_ID = 4663;
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const FIELDS = ["gen", "eggs", "rivalEggs", "survived", "deathReason", "decisions", "logHash"];
const passportAbi = [{
  type: "function", name: "mint", stateMutability: "payable",
  inputs: [
    { name: "voucher", type: "tuple", components: [
      { name: "recipient", type: "address" }, { name: "campaign", type: "bytes32" },
      { name: "nonce", type: "bytes32" }, { name: "deadline", type: "uint256" },
      { name: "participant", type: "bool" }, { name: "free", type: "bool" }
    ] },
    { name: "signature", type: "bytes" }
  ],
  outputs: [{ name: "tokenId", type: "uint256" }]
}];

if (!Number.isInteger(SEED) || SEED <= 0 || SEED > 0xffffffff) { console.error("SEED must be an island number (1..4294967295). Example: SEED=256"); process.exit(1); }
if (!PLAN.length) { console.error("PLAN must be comma-separated mutation ids, best first. Example: PLAN=sitter,forager,fecund,hardy"); process.exit(1); }
if (XHANDLE && !/^[A-Za-z0-9_]{1,15}$/.test(XHANDLE)) { console.error("XHANDLE must be the owner's X handle (they publish the proof post from that account)."); process.exit(1); }

// signer (optional): with PRIVATE_KEY the agent sends the mint itself
let account = null;
if (PK) {
  const { privateKeyToAccount } = require("viem/accounts");
  account = privateKeyToAccount(PK);
}

// 1. run the lineage with the exact engine the site serves (no trust needed).
// world.js imports its siblings relatively, so download the module graph into
// a temp dir and import from there — a data: URL can't resolve "./sim.js".
console.log(`[1/4] running island ${SEED}, brain ${BRAIN}, ${GENS} gens, plan: ${PLAN.join(",")}`);
const fsp = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { pathToFileURL } = await import("node:url");
const JS_RE = /from\s+"\.\/([A-Za-z0-9_.-]+\.js)"/g;
const modules = new Map();
async function fetchModule(name) {
  if (modules.has(name)) return;
  const src = await (await fetch(`https://musefly.lol/play/js/${name}`)).text();
  modules.set(name, src);
  for (const m of src.matchAll(JS_RE)) await fetchModule(m[1]);
}
await fetchModule("world.js");
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "musefly-agent-"));
for (const [name, src] of modules) await fsp.writeFile(path.join(dir, name), src);
const world = await import(pathToFileURL(path.join(dir, "world.js")).href);
const policy = (cards) => PLAN.find((t) => cards.includes(t)) ?? null;
const run = await world.runLineage({ seed: SEED, brain: BRAIN, gens: GENS, policy });
const gens = run.map((g) => Object.fromEntries(FIELDS.map((f) => [f, g[f]])));
console.log("      " + gens.map((g) => `gen${g.gen}: eggs=${g.eggs} ${g.survived ? "survived" : "died (" + g.deathReason + ")"} hash=${String(g.logHash).slice(0, 8)}`).join(" | "));

// 2. the X share gate (machine-verified, stonkrobotics model)
const recipient = account ? account.address : (ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(ADDRESS) ? getAddress(ADDRESS) : null);
if (!recipient) { console.error("Need a recipient wallet: set PRIVATE_KEY (agent signs) or ADDRESS (owner's wallet, 0x…40 hex)."); process.exit(1); }
const shareGet = () => fetch(`https://musefly.lol/api/musefly/share?address=${recipient}`, { headers: { Origin: "https://musefly.lol" } });
let share = await (await shareGet()).json();
if (!share.confirmed) {
  console.log("[2/4] X proof post required — the OWNER must publish this exact text from their X account:");
  console.log("      ┌────────────────────────────────────────────────────");
  for (const line of String(share.postText || "").split("\n")) console.log("      │ " + line);
  console.log("      └────────────────────────────────────────────────────");
  console.log("      one-tap composer: " + (share.intentUrl || ""));
  if (!XHANDLE) {
    console.error("      Waiting on that post. Re-run with XHANDLE=<owner's handle> and this script will verify it automatically and continue to the mint.");
    process.exit(0);
  }
  console.log(`      polling @${XHANDLE} every 15s (up to 6 min) for the post…`);
  let done = false;
  for (let i = 0; i < 24 && !done; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const vr = await fetch("https://musefly.lol/api/musefly/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://musefly.lol" },
      body: JSON.stringify({ address: recipient, handle: XHANDLE })
    });
    const vd = await vr.json().catch(() => ({}));
    if (vr.ok && vd.confirmed) done = true;
    else if (vr.status === 409 || vd.retryable) console.log(`      not indexed yet (${i + 1}/24) — retrying…`);
    else { console.error("share not verified: " + (vd.error || vr.status)); process.exit(1); }
  }
  if (!done) { console.error("timed out waiting for the proof post — run again once it's up"); process.exit(1); }
  console.log("      post verified ✓");
} else {
  console.log("[2/4] X share already verified for this wallet ✓");
}

// 3. voucher: the server re-runs the identical world and grades it.
console.log(`[3/4] requesting voucher for ${recipient}${XHANDLE ? " (xHandle=" + XHANDLE + " recorded)" : ""}…`);
const res = await fetch("https://musefly.lol/api/musefly/voucher", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://musefly.lol" },
  body: JSON.stringify({ address: recipient, seed: SEED, brain: BRAIN, gens: GENS, plan: PLAN, xHandle: XHANDLE, claim: { gens } })
});
let data = null;
try { data = await res.json(); } catch { /* handled below */ }
if (!res.ok || !data || !data.voucher) { console.error("voucher failed:", JSON.stringify(data).slice(0, 400)); process.exit(1); }
console.log(`      voucher ok (lane=${data.lane}, contract=${data.contract})`);

// 3. mint
const voucher = { ...data.voucher, deadline: BigInt(data.voucher.deadline) };
if (!account) {
  console.log("[4/4] no PRIVATE_KEY — here is everything an agent needs to sign (or hand to the owner for https://musefly.lol/adopt):");
  console.log(JSON.stringify({ chainId: data.chainId, contract: data.contract, functionSignature: "mint((address,bytes32,bytes32,uint256,bool,bool),bytes)", value: "0", voucher: data.voucher, signature: data.signature, rpc: RPC, explorer: EXPLORER }, null, 2));
  process.exit(0);
}
console.log(`[4/4] signing + sending mint from ${account.address} (free, gas only)…`);
const wallet = createWalletClient({ account, chain: { id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }, transport: http(RPC) });
const hash = await wallet.writeContract({ address: data.contract || getAddress("0xe0b99bd7a9b1efa5c5cdc0b7c433ebffe1d37823"), abi: passportAbi, functionName: "mint", args: [voucher, data.signature], value: 0n, account });
console.log(`      tx ${EXPLORER}/tx/${hash}`);
const publicClient = createPublicClient({ transport: http(RPC) });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") { console.error("mint tx reverted"); process.exit(1); }
console.log(`      Genesis Fly minted. ${EXPLORER}/address/${account.address}`);
