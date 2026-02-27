// adapters/refreshAdaptersAtomic.ts
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { RefreshCtx, LastGoodPointer } from "../skills/refreshPipelineAtomic.js";
import { backupIfExists, atomicWriteJson, loadLastGoodPointer, commitLastGoodPointer, rollbackArtifacts } from "./atomicIO.js";

async function readJsonl<T>(filepath: string): Promise<T[]> {
  if (!existsSync(filepath)) return [];
  const rl = readline.createInterface({ input: createReadStream(filepath), crlfDelay: Infinity });
  const rows: T[] = [];
  for await (const line of rl) { if (line.trim()) { try { rows.push(JSON.parse(line) as T); } catch {} } }
  return rows;
}

function runScript(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", script], { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`${script} exited with code ${code}`)); });
    child.on("error", reject);
  });
}

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

export async function buildIndex(ctx: RefreshCtx) {
  const dataDir = ctx.dataDir;
  await runScript("src/index_argue.ts", {
    OUT_DIR: dataDir,
    BASE_RPC: process.env.BASE_RPC ?? "https://mainnet.base.org",
    FACTORY_ADDRESS: process.env.FACTORY_ADDRESS ?? "0x0692eC85325472Db274082165620829930f2c1F9",
  });
  const events = await readJsonl<any>(path.join(dataDir, "argue_events.jsonl"));
  const stats  = await readJsonl<any>(path.join(dataDir, "agent_stats.jsonl"));
  const indexJson = { updatedAt: Date.now(), eventCount: events.length, statCount: stats.length, _events: events, _stats: stats };
  return { indexJson, indexCount: events.length, note: `indexed ${events.length} events, ${stats.length} stat records` };
}

export async function scoreIndex(ctx: RefreshCtx) {
  const dataDir = ctx.dataDir;
  await runScript("src/score_ais.ts", {
    IN_EVENTS:  path.join(dataDir, "argue_events.jsonl"),
    IN_STATS:   path.join(dataDir, "agent_stats.jsonl"),
    IN_DEBATES: path.join(dataDir, "argue_debates.jsonl"),
    OUT_SCORES: path.join(dataDir, "ais_scores.jsonl"),
    OUT_LB:     path.join(dataDir, "leaderboard.json"),
  });
  const scores = await readJsonl<any>(path.join(dataDir, "ais_scores.jsonl"));
  const scoresJson = { updatedAt: Date.now(), totalAgents: scores.length, scores };
  return { scoresJson, scoredCount: scores.length, note: `scored ${scores.length} agents` };
}

export async function writeAtomic(ctx: RefreshCtx) {
  if (ctx.indexJson === undefined) throw new Error("missing indexJson");
  if (ctx.scoresJson === undefined) throw new Error("missing scoresJson");
  const idxBak = await backupIfExists(ctx.indexPath);
  const scrBak = await backupIfExists(ctx.scoresPath);
  await atomicWriteJson(ctx.scoresPath, ctx.scoresJson);
  const jsonlPath = path.join(ctx.dataDir, "ais_scores.jsonl");
  return { wrote: [ctx.scoresPath, jsonlPath], backups: { indexBak: idxBak.backupPath, scoresBak: scrBak.backupPath }, note: `atomic write ok — ${ctx.scoresJson?.totalAgents ?? 0} agents` };
}

export async function loadLastGood(ctx: RefreshCtx) {
  const lastGood = (await loadLastGoodPointer(ctx.lastGoodPath)) as LastGoodPointer | null;
  return { lastGood, note: lastGood ? "last_good loaded" : "no last_good yet" };
}

export async function commitLastGood(ctx: RefreshCtx) {
  const pointer: LastGoodPointer = { updatedAt: Date.now(), indexPath: ctx.indexPath, scoresPath: ctx.scoresPath, indexBackupPath: ctx.pendingBackups?.indexBak, scoresBackupPath: ctx.pendingBackups?.scoresBak };
  await commitLastGoodPointer(ctx.lastGoodPath, pointer);
  return { lastGood: pointer, note: "last_good committed" };
}

export async function rollback(ctx: RefreshCtx) {
  const res = await rollbackArtifacts({ indexPath: ctx.indexPath, scoresPath: ctx.scoresPath, indexBak: ctx.pendingBackups?.indexBak ?? ctx.lastGood?.indexBackupPath, scoresBak: ctx.pendingBackups?.scoresBak ?? ctx.lastGood?.scoresBackupPath, lastGood: ctx.lastGood ? { indexPath: ctx.lastGood.indexPath, scoresPath: ctx.lastGood.scoresPath } : null });
  return { rolledBack: true, note: res.note };
}

export async function publish(_ctx: RefreshCtx) {
  return { published: false, note: "publish not configured" };
}
