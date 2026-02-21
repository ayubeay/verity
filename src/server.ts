import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFileSync, watchFile } from "fs";
import { resolve } from "path";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

// --- Types (matching your actual JSONL shape) ---
type AISRecord = {
  wallet: string;
  ais: number;
  tier: number;
  flags: number;
  winRate: number;
  resolvedDebates: number;
  confidence: number;
  participatedDebates: number;
  argumentsCount: number;
  totalStaked: string;
  avgStake: string;
  stakeVolatility: number;
  concentrationRisk: number;
  contractWinRate: number;
  flagReasons: string[];
};

// --- Score cache (in-memory, rebuilt from JSONL) ---
let scoreMap = new Map<string, AISRecord>();
let leaderboardCache: AISRecord[] = [];
let lastLoaded = new Date();

const SCORES_PATH = resolve(process.env.AIS_DATA_PATH || "data/ais_scores.jsonl");

function buildCache(map: Map<string, AISRecord>) {
  return [...map.values()]
    .sort((a, b) => {
      if (b.ais !== a.ais) return b.ais - a.ais;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.resolvedDebates - a.resolvedDebates;
    });
}

function loadScores() {
  try {
    const raw = readFileSync(SCORES_PATH, "utf-8");
    const map = new Map<string, AISRecord>();
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const r: AISRecord = JSON.parse(line);
        // last occurrence wins (append-only file = latest is last)
        map.set(r.wallet.toLowerCase(), r);
      } catch {}
    }
    scoreMap = map;
    leaderboardCache = buildCache(map);
    lastLoaded = new Date();
    console.log(`[cache] Loaded ${scoreMap.size} agents from JSONL`);
  } catch (e: any) {
    console.warn("[cache] Failed to load ais_scores.jsonl:", e.message);
  }
}

// Load on startup
loadScores();

// Reload when file changes (scorer writes new entries)
watchFile(SCORES_PATH, { interval: 30_000 }, () => {
  console.log("[cache] File changed, reloading scores...");
  loadScores();
});

// --- x402 setup (mirrors SURVIVOR exactly) ---
const RECEIVER_WALLET = process.env.PAYMENT_WALLET || "";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://facilitator.cdp.coinbase.com";

if (!RECEIVER_WALLET) throw new Error("PAYMENT_WALLET env var required");

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitator).register(
  "eip155:8453",
  new ExactEvmScheme()
);

const routes = {
  "GET /agent/*": {
    accepts: {
      scheme: "exact",
      price: "$0.01",
      network: "eip155:8453",
      payTo: RECEIVER_WALLET,
      maxTimeoutSeconds: 60,
    },
    description: "VERITY agent integrity score — $0.01 USDC on Base",
  },
  "GET /leaderboard": {
    accepts: {
      scheme: "exact",
      price: "$0.05",
      network: "eip155:8453",
      payTo: RECEIVER_WALLET,
      maxTimeoutSeconds: 60,
    },
    description: "VERITY AIS leaderboard — $0.05 USDC on Base",
  },
};

async function initX402() {
  try {
    await resourceServer.initialize();
    console.log("[x402] Resource server initialized ✓");
  } catch (e: any) {
    console.warn("[x402] Facilitator init failed:", e.message);
  }
}

const x402Gate = paymentMiddleware(routes, resourceServer, undefined, undefined, true);

function paymentLogger(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const originalJson = res.json.bind(res);
  res.json = function (data) {
    if (res.statusCode === 200) {
      const hasX402 = !!(
        req.headers["x-payment"] ||
        req.headers["x-payment-response"] ||
        req.headers["x402-payment"] ||
        req.headers["x402-payment-response"]
      );
      if (hasX402) {
        console.log(
          "[PAYMENT_SUCCESS]",
          new Date().toISOString(),
          req.method,
          req.originalUrl,
          "ip:",
          req.ip
        );
      }
    }
    return originalJson(data);
  };
  next();
}

// --- App ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(x402Gate);
app.use(paymentLogger);

const PORT = Number(process.env.PORT || 3001);

// Free
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "VERITY Agent Integrity Oracle",
    agents_indexed: scoreMap.size,
    last_loaded: lastLoaded.toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

app.get("/version", (_req, res) => {
  res.json({ version: "0.1.0", network: "base-mainnet", chain_id: 8453 });
});

// Gated: single agent
app.get("/agent/:wallet", (req, res) => {
  const wallet = req.params.wallet.toLowerCase();
  const record = scoreMap.get(wallet);

  if (!record) {
    return res.status(404).json({
      ok: false,
      error: "not_found",
      wallet,
      hint: "Wallet has no indexed argue.fun activity yet",
    });
  }

  return res.json({
    ok: true,
    wallet: record.wallet,
    ais: record.ais,
    tier: record.tier,
    confidence: record.confidence,
    win_rate: record.winRate,
    resolved_debates: record.resolvedDebates,
    participated_debates: record.participatedDebates,
    arguments_count: record.argumentsCount,
    total_staked: record.totalStaked,
    stake_volatility: record.stakeVolatility,
    concentration_risk: record.concentrationRisk,
    flag_reasons: record.flagReasons,
    oracle: "VERITY v0.1.0",
  });
});

// Gated: leaderboard
app.get("/leaderboard", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = leaderboardCache.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    wallet: r.wallet,
    ais: r.ais,
    tier: r.tier,
    confidence: r.confidence,
    win_rate: r.winRate,
    resolved_debates: r.resolvedDebates,
    flag_reasons: r.flagReasons,
  }));

  return res.json({
    ok: true,
    total: scoreMap.size,
    returned: page.length,
    updated: lastLoaded.toISOString(),
    leaderboard: page,
    oracle: "VERITY v0.1.0",
  });
});

// --- Boot ---
initX402().then(() => {
  app.listen(PORT, () => {
    console.log(`VERITY Oracle on :${PORT}`);
    console.log(`Pay-to: ${RECEIVER_WALLET}`);
    console.log(`Agents loaded: ${scoreMap.size}`);
  });
});
