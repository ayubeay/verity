// skills/survivorScan.ts
import type { SkillSpec } from "../engine/skillEngine.js";

export type SurvivorScanCtx = {
  mint: string;
  mintValid?: boolean;
  chainData?: any;
  signals?: {
    mintAuthorityOpen?: boolean;
    freezeAuthorityOpen?: boolean;
    lpLocked?: boolean;
    topHolderPct?: number;
    tokenProgram?: string;
  };
  score?: number;
  label?: "SAFE" | "RISKY" | "VERY_HIGH" | "UNKNOWN";
  note?: string;
};

function isValidMint(mint: string): boolean {
  return typeof mint === "string" && mint.length >= 20 && mint.length <= 60;
}

export const survivorScanSpec: SkillSpec<SurvivorScanCtx> = {
  name: "survivor.scan_mint",
  version: "0.1.0",
  start: "Start",
  terminal: ["Return"],
  fail: ["BadInput", "NoData", "ActionError", "Stuck", "GuardsBlocked"],

  states: {
    Start: {
      onEnter: async (ctx, api) => {
        api.set("mintValid", isValidMint(ctx.mint));
      },
    },
    ValidateInput: {},
    FetchOnchain: {
      onEnter: async (ctx, api) => {
        // TODO: replace with real fetch
        const data = { ok: true, tokenProgram: "spl-token", mock: true };
        api.set("chainData", data);
      },
    },
    DeriveSignals: {
      onEnter: async (ctx, api) => {
        const d = ctx.chainData;
        if (!d) api.fail("NoData", "missing chainData");
        api.set("signals", {
          mintAuthorityOpen: true,
          freezeAuthorityOpen: true,
          lpLocked: false,
          topHolderPct: 28,
          tokenProgram: d.tokenProgram,
        });
      },
    },
    Score: {
      onEnter: async (ctx, api) => {
        const s = ctx.signals;
        if (!s) api.fail("NoData", "missing signals");
        let score = 50;
        if (s!.mintAuthorityOpen) score += 20;
        if (s!.freezeAuthorityOpen) score += 10;
        if (s!.lpLocked === false) score += 20;
        if ((s!.topHolderPct ?? 0) > 20) score += 10;
        api.set("score", Math.min(100, Math.max(0, score)));
      },
    },
    Classify: {
      onEnter: async (ctx, api) => {
        const score = ctx.score ?? 0;
        const label =
          score >= 80 ? "VERY_HIGH" :
          score >= 55 ? "RISKY" :
          score > 0 ? "SAFE" : "UNKNOWN";
        api.set("label", label);
      },
    },
    Return: {},
    BadInput: {},
    NoData: {},
    ActionError: {},
    Stuck: {},
    GuardsBlocked: {},
  },

  transitions: [
    { from: "Start", to: "ValidateInput", label: "begin" },
    { from: "ValidateInput", to: "BadInput", label: "mint invalid", guard: (ctx) => !ctx.mintValid },
    { from: "ValidateInput", to: "FetchOnchain", label: "mint ok", guard: (ctx) => !!ctx.mintValid },
    { from: "FetchOnchain", to: "NoData", label: "no chain data", guard: (ctx) => !ctx.chainData },
    { from: "FetchOnchain", to: "DeriveSignals", label: "have chain data", guard: (ctx) => !!ctx.chainData },
    { from: "DeriveSignals", to: "Score", label: "signals ready", guard: (ctx) => !!ctx.signals },
    { from: "Score", to: "Classify", label: "scored", guard: (ctx) => typeof ctx.score === "number" },
    { from: "Classify", to: "Return", label: "done", guard: (ctx) => !!ctx.label },
  ],
};
