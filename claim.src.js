// claim.src.js — Genesis Flies claim UI for musefly.lol (bundled to /claim.bundle.js).
//
// Build: NODE_PATH=../fruit-fly-world/node_modules npx esbuild claim.src.js --bundle --minify --format=esm --outfile=claim.bundle.js
//
// The claim is "earned by playing": this page replays the owner's lineage
// headless with the SAME world.js the game runs and the SAME draft policy the
// in-game "YOUR AI'S PICK" uses, then asks the server to re-run it. Match ⇒ a
// free voucher for the Robinhood Chain passport contract. Never any payment.
import { createWalletClient, createPublicClient, custom, http, toEventSelector, decodeEventLog, getAddress } from "viem";

const CHAIN_ID = 4663;
const CHAIN = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://robinhoodchain.blockscout.com" } }
};
const EXPLORER = CHAIN.blockExplorers.default.url;
const CONTRACT = "0xe0b99bd7a9b1efa5c5cdc0b7c433ebffe1d37823";

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

const CLAIM_FIELDS = ["gen", "eggs", "rivalEggs", "survived", "deathReason", "decisions", "logHash"];

// the 24 mutation ids — pinned to play/js/sim.js TRAIT_INFO and the /adopt table
const TRAIT_IDS = new Set(["white","curly","ebony","fecund","swift","hardy","nocturnal","shaker","forager","thrift","tiger","giant","sitter","rover","diapause","adh","phototax","pheromone","clock","vestigial","mimic","hopper","cannibal","guard"]);

const $ = (id) => document.getElementById(id);
const status = (html, cls) => {
  const el = $("gcStatus");
  el.className = "gc-status" + (cls ? " " + cls : "");
  el.innerHTML = html;
  // success / failure must be unmissable — bring the line into view
  if (cls === "ok" || cls === "err") el.scrollIntoView({ block: "nearest", behavior: "smooth" });
};
// long waits must show a live counter or users think the page died
function timedStatus(prefixHtml, promise) {
  const t0 = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    status(`${prefixHtml} <span class="gc-tick">${s}s</span>`);
  };
  tick();
  const iv = setInterval(tick, 1000);
  return Promise.resolve(promise).finally(() => clearInterval(iv));
}

function loadPlan() {
  let plan = [];
  try { plan = JSON.parse(localStorage.getItem("musefly_plan_v1") || "[]"); } catch (_) {}
  // manual players never passed an AI plan — fall back to the traits their fly
  // actually ended up with (acquisition order = draft order, replays exactly)
  if (!Array.isArray(plan) || !plan.length) {
    try { plan = JSON.parse(localStorage.getItem("flyline_v1") || "{}").traits || []; } catch (_) {}
  }
  return Array.isArray(plan) ? [...new Set(plan.filter((t) => TRAIT_IDS.has(t)))] : [];
}

function gather() {
  const planRaw = $("gcPlan").value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const plan = [...new Set(planRaw)];
  const seed = Number($("gcSeed").value) >>> 0;
  // gcX accepts a post URL OR a bare @handle; only a bare handle is sent as
  // xHandle — a URL would fail the server's handle validation.
  const rawX = ($("gcX").value || "").trim().replace(/^@/, "");
  const xHandle = /^[A-Za-z0-9_]{1,15}$/.test(rawX) ? rawX : "";
  return { plan, seed, xHandle, xInput: rawX };
}

// ---- the X share gate (machine-verified, stonkrobotics model) ----
// Returns true when the address may mint. On a miss, paints exactly what to
// do into #gcStatus: the one-tap composer, the copyable text, and where to
// paste the result.
async function ensureShare(account) {
  const info = await fetch("/api/musefly/share?address=" + encodeURIComponent(account)).then((r) => r.json()).catch(() => ({}));
  if (info.confirmed) return true;
  const input = $("gcX").value.trim();
  if (!input) {
    const text = info.postText || "";
    status(
      `📣 <b>One post on X unlocks your free mint — machine-checked.</b><br>` +
      `<a href="${info.intentUrl || "#"}" target="_blank" rel="noreferrer">Post it in one tap →</a>` +
      (text ? ` · <a href="#" id="gcCopyPost">copy the text</a>` : "") +
      `<br>Then paste the <b>post link or your @handle</b> into the X field above and click “Mint my free NFT” again. Your code: <b>${info.shareCode || ""}</b>`
    );
    const copy = $("gcCopyPost");
    if (copy) copy.onclick = (e) => { e.preventDefault(); navigator.clipboard.writeText(text).then(() => { copy.textContent = "copied ✓"; }); };
    return false;
  }
  const isUrl = /^https?:\/\//i.test(input);
  status("Verifying your X post…");
  const res = await fetch("/api/musefly/share", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(isUrl ? { address: account, url: input } : { address: account, handle: input })
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.confirmed) return true;
  if (res.status === 409 || data.retryable) {
    status("X hasn't indexed your post yet — give it ~15 seconds, then click “Mint my free NFT” again. Nothing was reposted.");
  } else {
    status(data.error || "Share not verified.", "err");
  }
  return false;
}

// stonkrobotics-style one-tap post: connect wallet → personal code → the X
// composer opens with the post already typed in. No manual copy-paste.
async function postOnX() {
  const btn = $("gcPost");
  try {
    btn.disabled = true;
    if (!window.ethereum) throw new Error("No wallet found — install a compatible wallet and retry.");
    const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    status(`Wallet connected: ${account.slice(0, 6)}…${account.slice(-4)}. Building your post…`);
    const info = await fetch("/api/musefly/share?address=" + encodeURIComponent(account)).then((r) => r.json()).catch(() => ({}));
    if (info.confirmed) { status("Your X post is already verified for this wallet ✓ — go straight to “Mint my free NFT”.", "ok"); return; }
    const url = info.intentUrl || "";
    const text = info.postText || "";
    if (!url) throw new Error("Could not build the post — retry in a moment.");
    const win = window.open(url, "_blank", "noopener");
    status(
      (win
        ? "X opened in a new tab with your post ready — just hit <b>Post</b>."
        : `Pop-up blocked — <a href="${url}" target="_blank" rel="noreferrer">open your pre-filled post →</a>`) +
      (text ? ` · <a href="#" id="gcCopyPost2">copy the text</a> · code: <b>${info.shareCode || ""}</b>` : "") +
      "<br>Then come back, paste the post link (or your @handle) above, and hit “Mint my free NFT”."
    );
    const copy = $("gcCopyPost2");
    if (copy) copy.onclick = (e) => { e.preventDefault(); navigator.clipboard.writeText(text).then(() => { copy.textContent = "copied ✓"; }); };
  } catch (error) {
    status(error instanceof Error ? error.message : "Could not open the composer.", "err");
  } finally {
    btn.disabled = false;
  }
}

async function ensureChain() {
  const provider = window.ethereum;
  if (!provider) throw new Error("No wallet found — install a compatible wallet and retry.");
  const chainIdHex = "0x" + CHAIN_ID.toString(16);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (error) {
    const code = error?.data?.originalError?.code ?? error?.code;
    if (code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: chainIdHex, chainName: CHAIN.name, nativeCurrency: CHAIN.nativeCurrency, rpcUrls: CHAIN.rpcUrls.default.http, blockExplorerUrls: [EXPLORER] }]
    });
  }
}

// ---- the claim pipeline ----
async function claim() {
  const btn = $("gcClaim");
  try {
    btn.disabled = true;
    if (!window.ethereum) throw new Error("No wallet found — install a compatible wallet and retry.");
    const { plan, seed, xHandle, xInput } = gather();
    if (!plan.length) throw new Error("No mutations found for your run. If you just survived a generation: go back to the game, pick your mutation in the draft, and come back — it auto-fills here. Or paste your AI's plan line (e.g. thrift,forager,fecund,hardy).");
    const unknown = plan.filter((t) => !TRAIT_IDS.has(t));
    if (unknown.length) throw new Error(`Unknown mutation id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Plan entries must be ids from the 24-mutation table on the adopt page.`);
    if (!Number.isFinite(seed) || seed <= 0) throw new Error("Island number must be a positive integer (the number you played — find it on the seed input in the game).");
    if (xInput && !xHandle && !/^https?:\/\//i.test(xInput)) throw new Error("The X field takes your post link or your @handle — letters, digits and underscores.");

    // 1. connect + chain (the wallet pops up twice: once to connect/switch, once for the mint)
    status("Connect your wallet — approve the Robinhood Chain switch if it asks…");
    await ensureChain();
    const wallet = createWalletClient({ chain: CHAIN, transport: custom(window.ethereum) });
    const [account] = await wallet.requestAddresses();
    status(`Wallet connected: ${account.slice(0, 6)}…${account.slice(-4)}.`);

    // one-per-wallet pre-check: fail fast and clearly, before the ~60s seal,
    // if this wallet already holds a Genesis Fly. Fails soft if the RPC is
    // unreachable — the mint itself still surfaces the revert then.
    try {
      const pc = createPublicClient({ chain: CHAIN, transport: http() });
      const owned = await pc.readContract({
        address: CONTRACT, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
        functionName: "balanceOf", args: [account]
      });
      if (owned > 0n) throw new Error(`This wallet already owns a Genesis Fly — the free mint is one per wallet, soul-bound, forever. Nothing was charged. See your fly: <a href="${EXPLORER}/address/${getAddress(account)}" target="_blank" rel="noreferrer">explorer</a>. Use a different wallet if you want another.`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already owns")) throw error;
    }

    // 1.5 the X share gate — verified before any sealing work
    if (!(await ensureShare(account))) return;

    // 2. get the 2-generation claim records. If the game already pre-computed
    //    them (right after your survived run — see play/js ui.js), reuse them
    //    and skip the ~60s replay; otherwise compute them here, same engine,
    //    same plan, headless in YOUR browser.
    let gens = null;
    try {
      const cached = JSON.parse(localStorage.getItem("musefly_claim_v1") || "null");
      if (cached && cached.seed === seed && Array.isArray(cached.plan) &&
          cached.plan.join(",") === plan.join(",") && Array.isArray(cached.gens) &&
          cached.gens.length === 2) gens = cached.gens;
    } catch (_) {}
    if (gens) {
      status("Using the run this browser already sealed — asking the server to verify it…");
    } else {
      const world = await import("/play/js/world.js");
      const policy = (cards) => plan.find((t) => cards.includes(t)) ?? null;
      const run = await timedStatus(
        "Sealing your fly's lineage (2 generations, deterministic) — keep this page open…",
        world.runLineage({ seed, brain: "circuit", gens: 2, policy })
      );
      gens = run.map((g) => Object.fromEntries(CLAIM_FIELDS.map((f) => [f, g[f]])));
    }
    const fp = gens.map((g) => String(g.logHash).slice(0, 8)).join(" · ");
    const lived = gens.map((g) => (g.survived ? "survived" : "lost")).join(" → ");

    // 3. server re-runs the identical world and grades the claim
    try { localStorage.setItem("musefly_x_v1", xHandle); } catch (_) {}
    const res = await timedStatus(
      `Run sealed: gen fingerprints <b>${fp}</b> (${lived}). The server is re-running it to check…`,
      fetch("/api/musefly/voucher", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account, seed, brain: "circuit", gens: 2, plan, xHandle, claim: { gens } }) })
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const diffs = Array.isArray(data.diffs) ? "<br>" + data.diffs.join("<br>") : "";
      throw new Error(data.error || "verification failed" + diffs);
    }

    // 4. mint — free, soul-bound, one per wallet
    status("Run verified. Confirm the mint in your wallet (gas only, the fly is free)…");
    const voucher = { ...data.voucher, deadline: BigInt(data.voucher.deadline) };
    const hash = await wallet.writeContract({
      account, chain: CHAIN, address: data.contract || CONTRACT, abi: passportAbi,
      functionName: "mint", args: [voucher, data.signature], value: 0n
    });
    status(`Transaction sent: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noreferrer">${hash.slice(0, 10)}…</a>`);
    const publicClient = createPublicClient({ chain: CHAIN, transport: custom(window.ethereum) });
    const receipt = await timedStatus("Waiting for the chain to confirm…", publicClient.waitForTransactionReceipt({ hash }));
    if (receipt.status !== "success") throw new Error("The transaction failed on-chain — nothing was minted. Try again.");

    let token = "";
    try {
      const transfer = { type: "event", name: "Transfer", inputs: [{ type: "address", indexed: true, name: "from" }, { type: "address", indexed: true, name: "to" }, { type: "uint256", indexed: true, name: "tokenId" }] };
      const selector = toEventSelector(transfer);
      const log = receipt.logs.find((l) => l.topics[0] === selector && l.address.toLowerCase() === (data.contract || CONTRACT).toLowerCase());
      if (log) token = "#" + decodeEventLog({ abi: [transfer], data: log.data, topics: log.topics }).args.tokenId.toString();
    } catch (_) {}
    status(
      `Genesis Fly ${token || ""} is yours — free, soul-bound, one per wallet.` +
      ` <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noreferrer">receipt</a>` +
      ` · <a href="${EXPLORER}/address/${getAddress(account)}" target="_blank" rel="noreferrer">your fly</a>`,
      "ok"
    );
  } catch (error) {
    status(error instanceof Error ? error.message : "Claim failed.", "err");
  } finally {
    btn.disabled = false;
  }
}

// eligibility hint only (the game writes musefly_played_v1 on a survived gen).
// The mint itself is NOT gated on it anymore: the form below seals the run
// headless with the same engine, and the server re-verifies every byte anyway.
function playedOk() {
  try { return !!localStorage.getItem("musefly_played_v1"); } catch (_) { return false; }
}

// top-strip CTA (#gcCta, homepage mint line)
function renderStripCta() {
  const cta = $("gcCta");
  if (cta) {
    cta.innerHTML = playedOk()
      ? '<a class="btn" href="#genesis">Mint your free NFT →</a>'
      : '<a class="btn" href="#genesis">Mint your free NFT →</a> <span class="gc-hint">Paste your AI\'s plan line — or <a href="play/">play a run</a> first.</span>';
  }
}

export function initGenesisClaim() {
  const btn = $("gcClaim");
  if (btn) {
    btn.addEventListener("click", claim);
    const post = $("gcPost");
    if (post) post.addEventListener("click", postOnX);
    // the one-link handoff: an AI gives its owner
    // musefly.lol/?seed=256&plan=sitter,forager,…#genesis and everything
    // below is pre-filled. URL wins over anything remembered.
    const params = new URLSearchParams(location.search);
    const urlPlan = (params.get("plan") || "").split(",").map((s) => s.trim().toLowerCase()).filter((t) => TRAIT_IDS.has(t));
    const plan = urlPlan.length ? [...new Set(urlPlan)] : loadPlan();
    if (plan.length) $("gcPlan").value = plan.join(",");
    const urlSeed = Number(params.get("seed"));
    const seed = urlSeed > 0 ? urlSeed : Number(localStorage.getItem("musefly_last_seed_v1"));
    if (seed > 0) $("gcSeed").value = seed.toString();
    const lastX = localStorage.getItem("musefly_x_v1");
    if (lastX) $("gcX").value = "@" + lastX;
  }
  renderStripCta();
  window.__genesisClaimReady = true;
}

initGenesisClaim();
