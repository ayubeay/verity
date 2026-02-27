// routes/health.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { LastGoodPointer } from "../skills/refreshPipelineAtomic.js";

/**
 * Mount these on your Express/Fastify/Hono app.
 *
 * app.use("/health", healthRouter(process.env.DATA_DIR ?? "/app/data"))
 */
export function mountHealthRoutes(app: any, dataDir: string) {
  /**
   * GET /health/volume
   * Checks that DATA_DIR exists and is writable.
   * Returns: { ok, dataDir, writable, note }
   */
  app.get("/health/volume", async (_req: any, res: any) => {
    try {
      const probe = path.join(dataDir, ".healthprobe");
      await fs.writeFile(probe, String(Date.now()));
      await fs.unlink(probe);
      return res.json({ ok: true, dataDir, writable: true, note: "volume mounted and writable" });
    } catch (e: any) {
      return res.status(503).json({
        ok: false,
        dataDir,
        writable: false,
        note: e?.message ?? String(e),
      });
    }
  });

  /**
   * GET /health/refresh
   * Reads .last_good.json and returns last refresh metadata.
   * Returns: { ok, lastRefresh: { updatedAt, age_s, indexPath, scoresPath } | null }
   */
  app.get("/health/refresh", async (_req: any, res: any) => {
    const lastGoodPath = path.join(dataDir, ".last_good.json");
    try {
      const raw = await fs.readFile(lastGoodPath, "utf8");
      const pointer = JSON.parse(raw) as LastGoodPointer;
      const age_s = Math.floor((Date.now() - pointer.updatedAt) / 1000);

      // Try to get artifact sizes for extra info
      const artifacts: Record<string, any> = {};
      for (const [k, p] of [
        ["index", pointer.indexPath],
        ["scores", pointer.scoresPath],
      ] as [string, string][]) {
        try {
          const stat = await fs.stat(p);
          artifacts[k] = { path: p, size_bytes: stat.size, modified: stat.mtime };
        } catch {
          artifacts[k] = { path: p, error: "not found" };
        }
      }

      return res.json({
        ok: true,
        lastRefresh: {
          updatedAt: pointer.updatedAt,
          updatedAt_iso: new Date(pointer.updatedAt).toISOString(),
          age_s,
          age_human: formatAge(age_s),
          indexPath: pointer.indexPath,
          scoresPath: pointer.scoresPath,
          artifacts,
        },
      });
    } catch {
      return res.status(200).json({
        ok: false,
        lastRefresh: null,
        note: "No refresh has completed yet or .last_good.json missing",
      });
    }
  });

  /**
   * GET /health
   * Combined liveness check.
   */
  app.get("/health", async (_req: any, res: any) => {
    const lastGoodPath = path.join(dataDir, ".last_good.json");
    let volumeOk = false;
    let refreshOk = false;
    let lastRefreshAge: number | null = null;

    try {
      const probe = path.join(dataDir, ".healthprobe");
      await fs.writeFile(probe, String(Date.now()));
      await fs.unlink(probe);
      volumeOk = true;
    } catch {}

    try {
      const raw = await fs.readFile(lastGoodPath, "utf8");
      const p = JSON.parse(raw) as LastGoodPointer;
      lastRefreshAge = Math.floor((Date.now() - p.updatedAt) / 1000);
      refreshOk = true;
    } catch {}

    const status = volumeOk ? 200 : 503;
    return res.status(status).json({
      ok: volumeOk,
      volume: volumeOk,
      refresh: refreshOk,
      lastRefreshAge_s: lastRefreshAge,
      lastRefreshAge_human: lastRefreshAge !== null ? formatAge(lastRefreshAge) : null,
      ts: new Date().toISOString(),
    });
  });
}

function formatAge(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
