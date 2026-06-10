import { DeltaAlert } from "./alerts.js";
import {
  EPISODE_CLOSE_BPS,
  EPISODE_OPEN_BPS,
  EVM_CHAINS,
  PAIRS,
  POLL_INTERVAL_MS,
  SIZES_USD,
  SOLANA_TOKENS,
} from "./config.js";
import { EpisodeDetector } from "./derive/episodes.js";
import { computeBoard } from "./derive/spreads.js";
import { UniV3Quoter } from "./quoters/evm.js";
import { JupiterQuoter } from "./quoters/solana.js";
import type { Store } from "./store.js";
import type { Quote, Quoter } from "./types.js";

// Both directions of every configured pair.
const DIRECTIONS: [string, string][] = PAIRS.flatMap((p) => [
  [p.base, p.quote] as [string, string],
  [p.quote, p.base] as [string, string],
]);

function chainLists(quoter: Quoter): boolean {
  const symbols =
    quoter.chain === "solana"
      ? Object.keys(SOLANA_TOKENS)
      : Object.keys(
          EVM_CHAINS.find((c) => c.name === quoter.chain)?.tokens ?? {},
        );
  return PAIRS.every(
    (p) => symbols.includes(p.base) && symbols.includes(p.quote),
  );
}

async function collectChain(quoter: Quoter): Promise<Quote[]> {
  const quotes: Quote[] = [];
  // Sequential within a chain to stay polite to public RPCs and Jupiter's
  // free tier; chains run in parallel.
  for (const [tokenIn, tokenOut] of DIRECTIONS) {
    for (const size of SIZES_USD) {
      try {
        const q = await quoter.quote(tokenIn, tokenOut, size);
        if (q) quotes.push(q);
      } catch (err) {
        console.error(
          `[${quoter.chain}] ${tokenIn}->${tokenOut} $${size}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
  return quotes;
}

export function startCollector(store: Store): void {
  const quoters: Quoter[] = [
    ...EVM_CHAINS.map((c) => new UniV3Quoter(c)),
    new JupiterQuoter(),
  ].filter(chainLists);
  const chains = quoters.map((q) => q.chain);

  const alert = new DeltaAlert();
  console.log(`[delta] telegram alerts: ${alert.enabled ? "armed" : "off"}`);
  const detector = new EpisodeDetector(
    store,
    EPISODE_OPEN_BPS,
    EPISODE_CLOSE_BPS,
    {
      onOpen: (ep) => void alert.alertOpen(ep),
      onClose: (ep, ts) => void alert.alertClose(ep, ts),
    },
  );

  let running = false;
  const tick = async () => {
    if (running) return; // skip if previous tick still in flight
    running = true;
    try {
      const results = await Promise.all(quoters.map(collectChain));
      const quotes = results.flat();
      store.insert(quotes);
      detector.update(computeBoard(quotes, chains, SIZES_USD), Date.now());
      const summary = quotes
        .filter((q) => q.amountIn === 100_000 && q.tokenIn === "USDC")
        .map((q) => `${q.chain} ${q.bps.toFixed(2)}bps`)
        .join("  ");
      console.log(
        `[tick] ${quotes.length} quotes  USDC->USDT @100k: ${summary}`,
      );
    } finally {
      running = false;
    }
  };

  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
