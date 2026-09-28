// musefly-airdrop.mjs — owner batch airdrop of Genesis Flies via ownerMintBatch.
// Runs ON THE JAKARTA SERVER next to the FFW release node_modules (viem).
//   node musefly-airdrop.mjs --list /root/alloc-combined-all-eoa.txt          (dry run)
//   node musefly-airdrop.mjs --list /root/alloc-combined-all-eoa.txt --exec   (send)
// Contract: FruitFlyPassport 0xe0b99bd7a9b1efa5c5cdc0b7c433ebffe1d37823 (Robinhood Chain 4663)
// ownerMintBatch skips zero addresses and wallets that already minted, so it is
// naturally one-per-wallet and safe to re-run. Resume: /root/musefly-airdrop-done.txt.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { spawnSync } from "node:child_process";

// 2026-09-28: official robinhood RPC fake-reverts zero-storage reads — default to publicnode.
const RPC = (process.argv.find((a) => a.startsWith("--rpc=")) || "=https://robinhood-rpc.publicnode.com").split("=")[1];
const CONTRACT = "0xe0b99bd7a9b1efa5c5cdc0b7c433ebffe1d37823";
const CHAIN_ID = 4663n;
const CHUNK = parseInt((process.argv.find((a) => a.startsWith("--chunk=")) || "=100").split("=")[1], 10);
const EXEC = process.argv.includes("--exec");
const LIST = (process.argv.find((a) => a.startsWith("--list=")) || "=/root/alloc-combined-all-eoa.txt").split("=")[1];
const DONE = (process.argv.find((a) => a.startsWith("--done=")) || "=/root/musefly-airdrop-done.txt").split("=")[1];

// key: --key=0x… > env MINT_VOUCHER_PRIVATE_KEY > /etc/fruit-fly-world.env (server)
const argKey = (process.argv.find((a) => a.startsWith("--key=")) || "=").split("=")[1];
const key = (argKey || process.env.MINT_VOUCHER_PRIVATE_KEY ||
  spawnSync("bash", ["-c", "grep '^MINT_VOUCHER_PRIVATE_KEY=' /etc/fruit-fly-world.env 2>/dev/null | cut -d= -f2-"], { encoding: "utf8" }).stdout || "").trim();
if (!key) { console.error("no key: pass --key=0x… or MINT_VOUCHER_PRIVATE_KEY env (server: /etc/fruit-fly-world.env)"); process.exit(1); }
const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);

const client = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, chain: { id: Number(CHAIN_ID), name: "robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: [RPC] }, transport: http(RPC) });

const raw = readFileSync(LIST, "utf8").split("\n").map((l) => l.trim().toLowerCase())
  .filter((l) => /^0x[0-9a-f]{40}$/.test(l));
const uniq = [...new Set(raw)];
const done = existsSync(DONE) ? new Set(readFileSync(DONE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)) : new Set();
console.log(`list: ${raw.length} lines → ${uniq.length} unique; already airdropped (done file): ${done.size}`);

// pre-filter: hasMinted(address) — ownerMintBatch would skip these anyway; saves gas.
// NOTE: this RPC (and the official one) reverts eth_call for never-written storage, so
// "unknown" (null) must be treated as PENDING, not skipped. on-chain skip keeps it safe.
const HAS_MINTED = "0x38e21cce";
const pending = [];
let checked = 0, unknown = 0;
const queue = [...uniq];
await Promise.all(Array.from({ length: 5 }, async () => {
  while (queue.length) {
    const a = queue.shift();
    let has = null;
    for (let t = 0; t < 4 && has === null; t++) {
      try {
        const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACT, data: HAS_MINTED + a.slice(2) }, "latest"] }) });
        if (res.status === 429) { await new Promise((r) => setTimeout(r, 2500)); continue; }
        const j = await res.json();
        if (j.result) has = j.result === "0x" + "0".repeat(63) + "1";
      } catch (e) { await new Promise((r) => setTimeout(r, 2000)); }
    }
    checked++;
    if (has === null) unknown++;
    if (checked % 100 === 0) console.error(`hasMinted check ${checked}/${uniq.length}`);
    if (has !== true && !done.has(a)) pending.push(a);
  }
}));
pending.sort();
console.log(`pending recipients (not confirmed-minted, not yet airdropped): ${pending.length} (unknown-reads: ${unknown})`);

const OWNER_MINT_BATCH = "0x6e67a3a1"; // ownerMintBatch(address[])
const enc = (addrs) => OWNER_MINT_BATCH
  + "0000000000000000000000000000000000000000000000000000000000000020"
  + addrs.length.toString(16).padStart(64, "0")
  + addrs.map((a) => a.slice(2).padStart(64, "0")).join("");

const chunks = [];
for (let i = 0; i < pending.length; i += CHUNK) chunks.push(pending.slice(i, i + CHUNK));
const bal = await client.getBalance({ address: account.address });
console.log(`owner ${account.address} balance: ${formatEther(bal)} ETH — ${chunks.length} chunks of ≤${CHUNK}`);

let totalMinted = 0;
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  const data = enc(c);
  let gas;
  try { gas = await client.estimateGas({ account: account.address, to: CONTRACT, data }); }
  catch (e) { console.error(`chunk ${i + 1}: estimateGas failed — ${String(e.message).slice(0, 160)} — SKIPPING (will not revert whole batch)`); continue; }
  console.log(`chunk ${i + 1}/${chunks.length}: ${c.length} wallets, gas ≈ ${gas}`);
  if (!EXEC) continue;
  const hash = await wallet.sendTransaction({ to: CONTRACT, data, gas });
  const rc = await client.waitForTransactionReceipt({ hash });
  const minted = BigInt(rc.status === "success" ? 1n : 0n); // actual count = events; conservative
  console.log(`chunk ${i + 1}: tx ${hash} status=${rc.status} block=${rc.blockNumber}`);
  appendFileSync(DONE, c.join("\n") + "\n");
  totalMinted += c.length;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(EXEC ? `DONE — sent ${chunks.length} txs covering ~${totalMinted} wallets` : "DRY RUN — pass --exec to send");
