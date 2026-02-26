import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFileSync, watchFile } from "fs";
import { resolve } from "path";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator as cdpFacilitatorConfig } from "@coinbase/x402";

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
  process.env.FACILITATOR_URL || "https://api.cdp.coinbase.com/platform/v2/x402";

if (!RECEIVER_WALLET) throw new Error("PAYMENT_WALLET env var required");

const facilitator = new HTTPFacilitatorClient({
  url: cdpFacilitatorConfig.url,
  createAuthHeaders: cdpFacilitatorConfig.createAuthHeaders,
});
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
    x402Gate = paymentMiddleware(routes, resourceServer, undefined, undefined, false);
    console.log("[x402] Resource server initialized ✓");
  } catch (e: any) {
    console.warn("[x402] Facilitator init failed — gating disabled:", e.message);
  }
}

let x402Gate: express.RequestHandler | null = null;

const requireX402: express.RequestHandler = (req, res, next) => {
  if (!x402Gate) {
    return res.status(503).json({
      ok: false,
      error: "payment_gateway_unavailable",
      hint: "x402 facilitator not initialized"
    });
  }
  return x402Gate(req, res, next);
};

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
app.get("/agent/:wallet", requireX402, (req, res) => {
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
app.get("/leaderboard", requireX402, (req, res) => {
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

// --- Global error handler (never return HTML 500) ---


app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[uncaught]", err?.message || err);
  res.status(500).json({ ok: false, error: "internal_error", message: err?.message });
});


// --- Internal cron refresh ---
import { spawn } from "child_process";
import { existsSync, writeFileSync, unlinkSync } from "fs";

const ENABLE_INTERNAL_CRON = process.env.ENABLE_INTERNAL_CRON === "1";
const REFRESH_INTERVAL_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES || "360");
const LOCK_PATH = "/data/.refresh.lock";

function runCmd(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function refreshLoop() {
  const jitterMs = Math.floor(Math.random() * 5 * 60 * 1000);
  console.log(`[cron] enabled. first run in ${(jitterMs / 1000).toFixed(0)}s`);
  await new Promise((r) => setTimeout(r, jitterMs));
  while (true) {
    const startedAt = new Date().toISOString();
    if (existsSync(LOCK_PATH)) {
      console.log(`[cron] ${startedAt} lock exists, skipping`);
    } else {
      try {
        writeFileSync(LOCK_PATH, startedAt, { encoding: "utf8" });
        console.log(`[cron] ${startedAt} refresh start`);
        const idx = await runCmd("npm", ["run", "index"]);
        if (idx !== 0) throw new Error(`index failed code=${idx}`);
        const sc = await runCmd("npm", ["run", "score"]);
        if (sc !== 0) throw new Error(`score failed code=${sc}`);
        loadScores();
        console.log(`[cron] ${new Date().toISOString()} refresh OK`);
      } catch (e: any) {
        console.error(`[cron] refresh ERROR:`, e?.message || e);
      } finally {
        try { unlinkSync(LOCK_PATH); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, REFRESH_INTERVAL_MINUTES * 60 * 1000));
  }
}

if (ENABLE_INTERNAL_CRON) {
  refreshLoop().catch((e) => console.error("[cron] fatal:", e));
} else {
  console.log("[cron] disabled (set ENABLE_INTERNAL_CRON=1 to enable)");
}

// --- Boot ---
initX402().then(() => {
  app.listen(PORT, () => {
    console.log(`VERITY Oracle on :${PORT}`);
    console.log(`Pay-to: ${RECEIVER_WALLET}`);
    console.log(`Agents loaded: ${scoreMap.size}`);
  });
});
