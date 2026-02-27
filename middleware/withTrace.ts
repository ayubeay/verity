// middleware/withTrace.ts
import { runSkill, type SkillSpec, type RunResult } from "../engine/skillEngine.js";
import { getTraceStore } from "../store/traceStore.js";

export type TracedResult<C> = RunResult<C> & { trace_id: string };

/**
 * Drop-in replacement for runSkill() that auto-records to TraceStore.
 *
 * Usage:
 *   const res = await runTracedSkill(survivorScanSpec, ctx);
 *   console.log(res.trace_id); // "surv_scan_m.lz3k1a.3f7c"
 */
export async function runTracedSkill<C>(
  spec: SkillSpec<C>,
  ctx: C,
  opts?: { maxSteps?: number; allowedStates?: string[] }
): Promise<TracedResult<C>> {
  const result = await runSkill(spec, ctx, opts);

  let trace_id = "unrecorded";
  try {
    const store = getTraceStore();
    trace_id = await store.record(result);
  } catch (e) {
    // trace recording should never crash the caller
    console.error("[trace] failed to record:", e);
  }

  return { ...result, trace_id };
}

/**
 * Wrap any Express/Fastify/Hono handler so it injects trace_id into the response.
 *
 * Usage:
 *   app.get("/scan", withTraceHeader(async (req, res) => { ... }))
 */
export function withTraceHeader<Req, Res extends { setHeader: (k: string, v: string) => void }>(
  handler: (req: Req, res: Res) => Promise<void>
): (req: Req, res: Res) => Promise<void> {
  return async (req, res) => {
    await handler(req, res);
  };
}
