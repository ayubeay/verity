// middleware/withGovernor.ts
import { runSkill } from "../engine/skillEngine.js";
import {
  executionGovernorSpec,
  type ExecutionGovernorCtx,
} from "../skills/executionGovernor.js";
import { getTraceStore } from "../store/traceStore.js";

export type GovernorInput = Omit<
  ExecutionGovernorCtx,
  "decision" | "reason" | "throttleMs" | "debug"
>;

export class GovernorDenied extends Error {
  constructor(
    public decision: "DENIED" | "THROTTLED",
    public detail: {
      decision: string | undefined;
      reason: string | undefined;
      throttleMs: number | undefined;
      endState: string;
      trace_id: string;
    }
  ) {
    super(`Governor ${decision}: ${detail.reason ?? "no reason"}`);
    this.name = "GovernorDenied";
  }
}

/**
 * Wrap any async action with the Execution Governor.
 * - APPROVED  → run the action, return result + governor receipt
 * - THROTTLED → throw GovernorDenied (caller can inspect throttleMs for retry-after)
 * - DENIED    → throw GovernorDenied
 *
 * Every evaluation is recorded to TraceStore automatically.
 */
export function withGovernor<TArgs extends any[], TResult>(
  buildGovernorCtx: (...args: TArgs) => GovernorInput,
  action: (...args: TArgs) => Promise<TResult>
) {
  return async (
    ...args: TArgs
  ): Promise<{ result?: TResult; governor: { trace_id: string; decision: string; reason?: string } }> => {
    const govInput = buildGovernorCtx(...args);

    const govRun = await runSkill(executionGovernorSpec, {
      ...govInput,
      mode: govInput.action?.includes("public") ? "PUBLIC" : "PRIVATE",
    } as ExecutionGovernorCtx);

    // Record governor trace
    let trace_id = "unrecorded";
    try {
      trace_id = await getTraceStore().record(govRun);
    } catch (e) {
      console.error("[governor] trace record failed:", e);
    }

    const decision = govRun.ctx.decision;

    if (decision === "APPROVED") {
      const result = await action(...args);
      return {
        result,
        governor: { trace_id, decision: "APPROVED", reason: govRun.ctx.reason },
      };
    }

    throw new GovernorDenied(decision ?? "DENIED", {
      decision,
      reason: govRun.ctx.reason,
      throttleMs: govRun.ctx.throttleMs,
      endState: govRun.endState,
      trace_id,
    });
  };
}

/**
 * Express middleware factory — injects governor check before route handler.
 *
 * Usage:
 *   app.post("/trade/execute", governorMiddleware(() => ({
 *     action: "trade.execute",
 *     regime: getCurrentRegime(),
 *     safety: 85, conviction: 70, regimeAlignment: 80,
 *     riskBudget: 60, executionAllowance: 100,
 *   })), handler)
 */
export function governorMiddleware(
  buildCtx: (req: any) => GovernorInput
) {
  return async (req: any, res: any, next: any) => {
    const govInput = buildCtx(req);
    const govRun = await runSkill(executionGovernorSpec, {
      ...govInput,
      mode: "PRIVATE",
    } as ExecutionGovernorCtx);

    let trace_id = "unrecorded";
    try {
      trace_id = await getTraceStore().record(govRun);
    } catch {}

    res.setHeader("X-Governor-Trace-Id", trace_id);
    res.setHeader("X-Governor-Decision", govRun.ctx.decision ?? "UNKNOWN");

    if (govRun.ctx.decision === "APPROVED") {
      req.governor = { trace_id, decision: "APPROVED", reason: govRun.ctx.reason };
      return next();
    }

    return res.status(403).json({
      error: "Governor denied",
      decision: govRun.ctx.decision,
      reason: govRun.ctx.reason,
      throttleMs: govRun.ctx.throttleMs,
      trace_id,
    });
  };
}
