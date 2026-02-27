// jobs/startInternalRefreshTimer.ts
import { runSkill } from "../engine/skillEngine.js";
import { refreshPipelineAtomicSpec, type RefreshCtx } from "../skills/refreshPipelineAtomic.js";
import * as adapters from "../adapters/refreshAdaptersAtomic.js";
import { getTraceStore } from "../store/traceStore.js";

export interface RefreshTimerOpts {
  everyMs: number;
  baseDir: string;
  dataDir: string;
  indexPath: string;
  scoresPath: string;
  lastGoodPath?: string;
  mode?: "LOCAL_ONLY" | "PUBLISH_IF_AVAILABLE";
  intervalTag?: string;
  onRun?: (res: any, trace_id: string) => void;
}

export function startInternalRefreshTimer(opts: RefreshTimerOpts): () => void {
  const dataDir = opts.dataDir;
  const mode = opts.mode ?? "LOCAL_ONLY";
  const lastGoodPath = opts.lastGoodPath ?? `${dataDir}/.last_good.json`;

  async function tick() {
    const ctx: RefreshCtx = {
      mode,
      intervalTag: opts.intervalTag ?? "timer",
      baseDir: opts.baseDir,
      dataDir,
      indexPath: opts.indexPath,
      scoresPath: opts.scoresPath,
      lastGoodPath,
      adapters: {
        checkVolume: adapters.checkVolume,
        loadLastGood: adapters.loadLastGood,
        buildIndex: adapters.buildIndex,
        scoreIndex: adapters.scoreIndex,
        writeAtomic: adapters.writeAtomic,
        commitLastGood: adapters.commitLastGood,
        rollback: adapters.rollback,
        publish: adapters.publish,
      },
    };

    const res = await runSkill(refreshPipelineAtomicSpec, ctx, { maxSteps: 80 });

    // Record trace
    let trace_id = "unrecorded";
    try {
      trace_id = await getTraceStore().record(res);
    } catch (e) {
      console.error("[refresh] trace record failed:", e);
    }

    if (opts.onRun) {
      opts.onRun(res, trace_id);
    } else {
      const status = res.ok ? "✓" : "✗";
      console.log(
        `[refresh-atomic] ${status} ok=${res.ok} end=${res.endState}`,
        `index=${res.ctx.indexCount ?? "-"} scored=${res.ctx.scoredCount ?? "-"}`,
        `trace=${trace_id}`,
        res.ctx.note ? `| ${res.ctx.note}` : ""
      );
      if (!res.ok) {
        console.error("[refresh-atomic] trace tail:");
        console.dir(res.trace.slice(-8), { depth: null });
      }
    }

    return { res, trace_id };
  }

  // Run immediately at boot
  tick().catch((e) => console.error("[refresh] boot tick error:", e));

  // Repeat on interval
  const id = setInterval(() => tick().catch((e) => console.error("[refresh] tick error:", e)), opts.everyMs);

  // Return stop function
  return () => clearInterval(id);
}
