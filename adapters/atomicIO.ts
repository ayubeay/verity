// adapters/atomicIO.ts
import fs from "node:fs/promises";
import path from "node:path";

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function fileExists(p: string) {
  try { await fs.stat(p); return true; } catch { return false; }
}

export async function atomicWriteJson(targetPath: string, obj: any) {
  const dir = path.dirname(targetPath);
  await ensureDir(dir);
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  const data = JSON.stringify(obj, null, 2);
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, targetPath);
  return { targetPath, tmpWritten: tmp };
}

export async function backupIfExists(targetPath: string) {
  if (!(await fileExists(targetPath))) return { backupPath: undefined as string | undefined };
  const bak = `${targetPath}.bak.${Date.now()}`;
  await fs.copyFile(targetPath, bak);
  return { backupPath: bak };
}

export async function loadLastGoodPointer(pointerPath: string) {
  try {
    const raw = await fs.readFile(pointerPath, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

export async function commitLastGoodPointer(pointerPath: string, pointerObj: any) {
  await atomicWriteJson(pointerPath, pointerObj);
}

export async function rollbackArtifacts(opts: {
  indexPath: string;
  scoresPath: string;
  indexBak?: string;
  scoresBak?: string;
  lastGood?: { indexPath: string; scoresPath: string } | null;
}) {
  const notes: string[] = [];
  if (opts.indexBak && (await fileExists(opts.indexBak))) {
    await fs.copyFile(opts.indexBak, opts.indexPath);
    notes.push("restored index from backup");
  } else {
    notes.push("index rollback: no backup found");
  }
  if (opts.scoresBak && (await fileExists(opts.scoresBak))) {
    await fs.copyFile(opts.scoresBak, opts.scoresPath);
    notes.push("restored scores from backup");
  } else {
    notes.push("scores rollback: no backup found");
  }
  return { rolledBack: true, note: notes.join(" | ") };
}
