// skills/executionGovernor.ts
import type { SkillSpec } from "../engine/skillEngine.js";

export type Regime = "ACCUMULATION" | "EXPANSION" | "DISTRIBUTION" | "COLLAPSE" | "UNKNOWN";
export type GovernorDecision = "APPROVED" | "THROTTLED" | "DENIED";

export type ExecutionGovernorCtx = {
  action: string;
  regime: Regime;
  safety: number;
  conviction: number;
  regimeAlignment: number;
  riskBudget: number;
  executionAllowance: number;
  mode?: "PRIVATE" | "PUBLIC" | "INTERNAL";
  decision?: GovernorDecision;
  reason?: string;
  throttleMs?: number;
  debug?: Record<string, any>;
};

const clamp = (n: number) => Math.max(0, Math.min(100, n));

function compositeScore(ctx: ExecutionGovernorCtx) {
  return Math.round(
    0.30 * clamp(ctx.safety) +
    0.25 * clamp(ctx.regimeAlignment) +
    0.20 * clamp(ctx.conviction) +
    0.15 * clamp(ctx.riskBudget) +
    0.10 * clamp(ctx.executionAllowance)
  );
}

function baseThresholds(ctx: ExecutionGovernorCtx) {
  const mode = ctx.mode ?? "INTERNAL";
  const t =
    mode === "PUBLIC" ? { approve: 78, throttle: 62 } :
    mode === "PRIVATE" ? { approve: 72, throttle: 55 } :
    { approve: 68, throttle: 50 };
  if (ctx.regime === "COLLAPSE") return { approve: t.approve + 8, throttle: t.throttle + 6 };
  if (ctx.regime === "DISTRIBUTION") return { approve: t.approve + 4, throttle: t.throttle + 3 };
  return t;
}

export const executionGovernorSpec: SkillSpec<ExecutionGovernorCtx> = {
  name: "survivor.execution_governor",
  version: "0.1.0",
  start: "Start",
  terminal: ["Approved", "Throttled", "Denied"],
  fail: ["BadInput", "ActionError", "Stuck", "GuardsBlocked"],

  states: {
    Start: {
      onEnter: async (ctx, api) => {
        if (!ctx.action || typeof ctx.action !== "string") api.fail("BadInput", "missing action");
        if (!ctx.regime) api.fail("BadInput", "missing regime");
        ctx.safety = clamp(ctx.safety);
        ctx.conviction = clamp(ctx.conviction);
        ctx.regimeAlignment = clamp(ctx.regimeAlignment);
        ctx.riskBudget = clamp(ctx.riskBudget);
        ctx.executionAllowance = clamp(ctx.executionAllowance);
        api.set("debug", { ...(ctx.debug ?? {}), normalized: true });
      },
    },
    Guardrails: {
      onEnter: async (ctx, api) => {
        if (ctx.safety < 20) api.fail("BadInput", "safety too low to consider execution");
        if (ctx.executionAllowance <= 0) {
          ctx.decision = "DENIED";
          ctx.reason = "No execution allowance";
        }
      },
    },
    Score: {
      onEnter: async (ctx) => {
        if (ctx.decision === "DENIED") return;
        const score = compositeScore(ctx);
        ctx.debug = { ...(ctx.debug ?? {}), compositeScore: score };
      },
    },
    Decide: {
      onEnter: async (ctx) => {
        if (ctx.decision === "DENIED") return;
        const score = (ctx.debug?.compositeScore as number) ?? compositeScore(ctx);
        const th = baseThresholds(ctx);
        if (ctx.riskBudget < 15) { ctx.decision = "DENIED"; ctx.reason = "Risk budget too low"; return; }
        if (ctx.regimeAlignment < 25) { ctx.decision = "DENIED"; ctx.reason = "Regime misalignment"; return; }
        if (score >= th.approve) { ctx.decision = "APPROVED"; ctx.reason = `Score ${score} >= approve ${th.approve}`; return; }
        if (score >= th.throttle) {
          ctx.decision = "THROTTLED";
          ctx.reason = `Score ${score} >= throttle ${th.throttle}`;
          ctx.throttleMs = ctx.regime === "COLLAPSE" ? 30_000 : ctx.regime === "DISTRIBUTION" ? 15_000 : 5_000;
          return;
        }
        ctx.decision = "DENIED";
        ctx.reason = `Score ${score} < throttle ${th.throttle}`;
      },
    },
    Approved: {},
    Throttled: {},
    Denied: {},
    BadInput: {},
    ActionError: {},
    Stuck: {},
    GuardsBlocked: {},
  },

  transitions: [
    { from: "Start", to: "Guardrails", label: "validate" },
    { from: "Guardrails", to: "Score", label: "hard gates ok", guard: (ctx) => ctx.decision !== "DENIED" },
    { from: "Guardrails", to: "Denied", label: "hard gate denied", guard: (ctx) => ctx.decision === "DENIED" },
    { from: "Score", to: "Decide", label: "score computed" },
    { from: "Decide", to: "Approved", label: "approved", guard: (ctx) => ctx.decision === "APPROVED" },
    { from: "Decide", to: "Throttled", label: "throttled", guard: (ctx) => ctx.decision === "THROTTLED" },
    { from: "Decide", to: "Denied", label: "denied", guard: (ctx) => ctx.decision === "DENIED" },
  ],
};
