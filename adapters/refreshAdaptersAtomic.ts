// adapters/refreshAdaptersAtomic.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { RefreshCtx, LastGoodPointer } from "../skills/refreshPipelineAtomic.js";
import { backupIfExists, atomicWriteJson, loadLastGoodPointer, commitLastGoodPointer, rollbackArtifacts } from "./atomicIO.js";

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

export async function buildIndex(_ctx: RefreshCtx) {
  // TODO: replace with real indexer
  const indexJson = { updatedAt: Date.now(), items: [] as any[] };
  return { indexJson, indexCount: indexJson.items.length, note: "index built (mock)" };
}

export async function scoreIndex(_ctx: RefreshCtx) {
  // TODO: replace with real scorer
  const scoresJson = { updatedAt: Date.now(), scores: [] as any[] };
  return { scoresJson, scoredCount: scoresJson.scores.length, note: "scores computed (mock)" };
}

export async function writeAtomic(ctx: RefreshCtx) {
  if (ctx.indexJson === undefined) throw new Error("missing indexJson");
  if (ctx.scoresJson === undefined) throw new Error("missing scoresJson");
  const idxBak = await backupIfExists(ctx.indexPath);
  const scrBak = await backupIfExists(ctx.scoresPath);
  await atomicWriteJson(ctx.indexPath, ctx.indexJson);
  await atomicWriteJson(ctx.scoresPath, ctx.scoresJson);
  return {
    wrote: [ctx.indexPath, ctx.scoresPath],
    backups: { indexBak: idxBak.backupPath, scoresBak: scrBak.backupPath },
    note: "atomic write ok",
  };
}

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
    lastGood: ctx.lastGood ? { indexPath: ctx.lastGood.indexPath, scoresPath: ctx.lastGood.scoresPath } : null,
  });
  return { rolledBack: true, note: res.note };
}

export async function publish(_ctx: RefreshCtx) {
  return { published: false, note: "publish not configured" };
}
