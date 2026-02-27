// adapters/refreshAdaptersAtomic.ts
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { RefreshCtx, LastGoodPointer } from "../skills/refreshPipelineAtomic.js";
import {
  backupIfExists,
  atomicWriteJson,
  loadLastGoodPointer,
  commitLastGoodPointer,
  rollbackArtifacts,
} from "./atomicIO.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readJsonl<T>(filepath: string): Promise<T[]> {
  if (!existsSync(filepath)) return [];
  const rl = readline.createInterface({
    input: createReadStream(filepath),
    crlfDelay: Infinity,
  });
  const rows: T[] = [];
  for await (const line of rl) {
    if (line.trim()) {
      try { rows.push(JSON.parse(line) as T); } catch {}
    }
  }
  return rows;
}

const clamp  = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mean   = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const stddev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
};

function formatStake(wei: bigint): string {
  const e18 = BigInt("1000000000000000000");
  const whole = wei / e18;
  const frac = (wei % e18) * 100n / e18;
  return `${whole}.${frac.toString().padStart(2, "0")} ARGUE`;
}

// ─── Volume check ─────────────────────────────────────────────────────────────

export async function checkVolume(ctx: RefreshCtx) {
  try {
    const stat = await fs.stat(ctx.dataDir);
    if (!stat.isDirectory()) return { hasVolume: false, canWrite: false, note: `dataDir not a dir: ${ctx.dataDir}` };
    const probe = path.join(ctx.dataDir, ".probe");
    await fs.writeFile(probe, String(Date.now()));
    await fs.unlink(probe);
    return { hasVolume: true, canWrite: true, note: `volume ok: ${ctx.dataDir}` };
  } catch (e: any) {
    return { hasVolume: false, canWrite: false, note: `volume missing/unwritable: ${e?.message ?? e}` };
  }
}

// ─── Real indexer: reads argue_events.jsonl + agent_stats.jsonl ───────────────

export async function buildIndex(ctx: RefreshCtx) {
  const dataDir = ctx.dataDir;
  const events = await readJsonl<any>(path.join(dataDir, "argue_events.jsonl"));
  const stats  = await readJsonl<any>(path.join(dataDir, "agent_stats.jsonl"));

  const indexJson = {
    updatedAt: Date.now(),
    eventCount: events.length,
    statCount: stats.length,
    // pass through so scoreIndex can use them
    _events: events,
    _stats: stats,
  };

  return {
    indexJson,
    indexCount: events.length,
    note: `indexed ${events.length} events, ${stats.length} stat records`,
  };
}

// ─── Real scorer: mirrors score_ais.ts logic ─────────────────────────────────

const FLAG_HIGH_RISK          = 1 << 0;
const FLAG_STAKE_VOLATILITY   = 1 << 1;
const FLAG_CONCENTRATION_RISK = 1 << 2;
const FLAG_NARROW_WIN_FARMING = 1 << 3;
const FLAG_LOW_SAMPLE         = 1 << 4;
const FLAG_FIRST_LOSS         = 1 << 5;

const TIER_LABEL: Record<number, string> = { 0: "TRUSTED", 1: "STANDARD", 2: "FLAGGED", 3: "RESTRICTED" };

export async function scoreIndex(ctx: RefreshCtx) {
  const dataDir = ctx.dataDir;
  const events: any[]   = ctx.indexJson?._events ?? await readJsonl(path.join(dataDir, "argue_events.jsonl"));
  const statsRaw: any[] = ctx.indexJson?._stats  ?? await readJsonl(path.join(dataDir, "agent_stats.jsonl"));
  const debates: any[]  = await readJsonl(path.join(dataDir, "argue_debates.jsonl"));

  const statsMap = new Map<string, any>(statsRaw.map((s: any) => [s.wallet.toLowerCase(), s]));
  const profiles = new Map<string, any>();

  for (const ev of events) {
    const w = ev.author.toLowerCase();
    if (!profiles.has(w)) {
      profiles.set(w, {
        wallet: w, wins: 0, losses: 0, unresolved: 0,
        argumentsCount: 0,
        totalAmountStaked: 0n,
        amountsPerDebate: new Map(),
        winAmounts: [], lossAmounts: [], allAmounts: [],
        debatesParticipated: new Set(),
        contractWinRate: 0,
      });
    }
    const p = profiles.get(w)!;
    const amt = BigInt(ev.amount ?? "0");
    p.argumentsCount++;
    p.totalAmountStaked += amt;
    p.allAmounts.push(amt);
    p.debatesParticipated.add(ev.debateAddress);
    p.amountsPerDebate.set(ev.debateAddress, (p.amountsPerDebate.get(ev.debateAddress) ?? 0n) + amt);
    if      (ev.won === null)  p.unresolved++;
    else if (ev.won)           { p.wins++;   p.winAmounts.push(amt); }
    else                       { p.losses++; p.lossAmounts.push(amt); }
  }

  // merge contractWinRate from stats
  for (const [wallet, stats] of statsMap) {
    if (profiles.has(wallet)) {
      profiles.get(wallet)!.contractWinRate = stats.contractWinRate ?? 0;
    }
  }

  const scores: any[] = [];

  for (const [, p] of profiles) {
    const resolved = p.wins + p.losses;
    if (resolved === 0 && p.argumentsCount === 0) continue;

    const winRate = resolved > 0 ? p.wins / resolved : 0;
    const participatedDebates = p.debatesParticipated.size;

    // confidence
    const sampleFactor = clamp(resolved / 10, 0, 1);
    const diversityFactor = clamp(participatedDebates / 5, 0, 1);
    const confidence = (sampleFactor * 0.7 + diversityFactor * 0.3);

    // stake analysis
    const allAmtsNum = p.allAmounts.map((x: bigint) => Number(x));
    const stakeVolatility = allAmtsNum.length > 1
      ? clamp(stddev(allAmtsNum) / (mean(allAmtsNum) || 1), 0, 1)
      : 0;

    const debateAmts = [...p.amountsPerDebate.values()].map((x: bigint) => Number(x));
    const totalNum = Number(p.totalAmountStaked);
    const concentrationRisk = debateAmts.length > 0 && totalNum > 0
      ? clamp(Math.max(...debateAmts) / totalNum, 0, 1)
      : 0;

    const avgStake = p.argumentsCount > 0
      ? p.totalAmountStaked / BigInt(p.argumentsCount)
      : 0n;

    const avgWin  = p.winAmounts.length  ? mean(p.winAmounts.map((x: bigint)  => Number(x))) : 0;
    const avgLoss = p.lossAmounts.length ? mean(p.lossAmounts.map((x: bigint) => Number(x))) : 0;

    // AIS scoring
    let ais = 50;
    ais += Math.round(winRate * 30);
    ais += Math.round(confidence * 15);
    ais -= Math.round(stakeVolatility * 10);
    ais -= Math.round(concentrationRisk * 10);
    if (p.contractWinRate > 0) ais += Math.round(p.contractWinRate * 5);
    ais = clamp(ais, 0, 100);

    // flags
    let flags = 0;
    const flagReasons: string[] = [];
    if (ais < 35)                       { flags |= FLAG_HIGH_RISK;          flagReasons.push("HIGH_RISK"); }
    if (stakeVolatility > 0.7)          { flags |= FLAG_STAKE_VOLATILITY;   flagReasons.push("STAKE_VOLATILITY"); }
    if (concentrationRisk > 0.8)        { flags |= FLAG_CONCENTRATION_RISK; flagReasons.push("CONCENTRATION_RISK"); }
    if (resolved < 5)                   { flags |= FLAG_LOW_SAMPLE;         flagReasons.push("LOW_SAMPLE"); }
    if (p.losses > 0 && p.wins === 0)   { flags |= FLAG_FIRST_LOSS;         flagReasons.push("FIRST_LOSS"); }
    if (avgLoss > avgWin * 2 && avgWin > 0) { flags |= FLAG_NARROW_WIN_FARMING; flagReasons.push("NARROW_WIN_FARMING"); }

    // tier
    const tier = ais >= 75 ? 0 : ais >= 55 ? 1 : ais >= 35 ? 2 : 3;

    scores.push({
      wallet: p.wallet, ais, tier, flags,
      winRate, resolvedDebates: resolved, confidence,
      participatedDebates, argumentsCount: p.argumentsCount,
      totalStaked: p.totalAmountStaked.toString(),
      avgStake: avgStake.toString(),
      stakeVolatility, concentrationRisk,
      contractWinRate: p.contractWinRate, flagReasons,
    });
  }

  scores.sort((a, b) =>
    b.ais !== a.ais               ? b.ais - a.ais :
    b.confidence !== a.confidence ? b.confidence - a.confidence :
    b.resolvedDebates !== a.resolvedDebates ? b.resolvedDebates - a.resolvedDebates :
    BigInt(b.totalStaked) > BigInt(a.totalStaked) ? 1 : -1
  );

  const resolvedDebates = debates.filter((d: any) => d.isResolved);

  const scoresJson = {
    updatedAt: Date.now(),
    totalAgents: scores.length,
    scores,
    leaderboard: {
      generatedAt: new Date().toISOString(),
      totalAgents: scores.length,
      totalDebates: debates.length,
      totalArguments: events.length,
      resolvedDebatesCount: resolvedDebates.length,
      distribution: {
        trusted:    scores.filter(s => s.tier === 0).length,
        standard:   scores.filter(s => s.tier === 1).length,
        flagged:    scores.filter(s => s.tier === 2).length,
        restricted: scores.filter(s => s.tier === 3).length,
      },
      top20: scores.slice(0, 20).map(s => ({
        wallet: s.wallet, ais: s.ais, tier: TIER_LABEL[s.tier],
        confidence: `${Math.round(s.confidence * 100)}%`,
        winRate: `${(s.winRate * 100).toFixed(1)}%`,
        resolvedDebates: s.resolvedDebates,
        participatedDebates: s.participatedDebates,
        argumentsCount: s.argumentsCount,
        totalStaked: formatStake(BigInt(s.totalStaked)),
        flags: s.flagReasons,
      })),
    },
  };

  return {
    scoresJson,
    scoredCount: scores.length,
    note: `scored ${scores.length} agents`,
  };
}

// ─── Atomic write: scores.json + ais_scores.jsonl (compat) ───────────────────

export async function writeAtomic(ctx: RefreshCtx) {
  if (ctx.indexJson === undefined) throw new Error("missing indexJson");
  if (ctx.scoresJson === undefined) throw new Error("missing scoresJson");

  const idxBak = await backupIfExists(ctx.indexPath);
  const scrBak = await backupIfExists(ctx.scoresPath);

  // Write canonical scores.json
  await atomicWriteJson(ctx.indexPath, ctx.indexJson);
  await atomicWriteJson(ctx.scoresPath, ctx.scoresJson);

  // Write compat ais_scores.jsonl (so old loader still works)
  const jsonlPath = path.join(ctx.dataDir, "ais_scores.jsonl");
  const scoresArr: any[] = Array.isArray(ctx.scoresJson)
    ? ctx.scoresJson
    : (ctx.scoresJson?.scores ?? []);

  const jsonlTmp = `${jsonlPath}.tmp.${process.pid}.${Date.now()}`;
  const stream = createWriteStream(jsonlTmp);
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
    for (const s of scoresArr) stream.write(JSON.stringify(s) + "\n");
    stream.end();
  });
  await fs.rename(jsonlTmp, jsonlPath);

  return {
    wrote: [ctx.indexPath, ctx.scoresPath, jsonlPath],
    backups: { indexBak: idxBak.backupPath, scoresBak: scrBak.backupPath },
    note: `atomic write ok — ${scoresArr.length} agents`,
  };
}

// ─── Last good pointer ────────────────────────────────────────────────────────

export async function loadLastGood(ctx: RefreshCtx) {
  const lastGood = (await loadLastGoodPointer(ctx.lastGoodPath)) as LastGoodPointer | null;
  return { lastGood, note: lastGood ? "last_good loaded" : "no last_good yet" };
}

export async function commitLastGood(ctx: RefreshCtx) {
  const pointer: LastGoodPointer = {
    updatedAt: Date.now(),
    indexPath: ctx.indexPath,
    scoresPath: ctx.scoresPath,
    indexBackupPath: ctx.pendingBackups?.indexBak,
    scoresBackupPath: ctx.pendingBackups?.scoresBak,
  };
  await commitLastGoodPointer(ctx.lastGoodPath, pointer);
  return { lastGood: pointer, note: "last_good committed" };
}

export async function rollback(ctx: RefreshCtx) {
  const res = await rollbackArtifacts({
    indexPath: ctx.indexPath,
    scoresPath: ctx.scoresPath,
    indexBak: ctx.pendingBackups?.indexBak ?? ctx.lastGood?.indexBackupPath,
    scoresBak: ctx.pendingBackups?.scoresBak ?? ctx.lastGood?.scoresBackupPath,
    lastGood: ctx.lastGood
      ? { indexPath: ctx.lastGood.indexPath, scoresPath: ctx.lastGood.scoresPath }
      : null,
  });
  return { rolledBack: true, note: res.note };
}

export async function publish(_ctx: RefreshCtx) {
  return { published: false, note: "publish not configured" };
}
