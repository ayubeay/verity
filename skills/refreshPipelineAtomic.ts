// skills/refreshPipelineAtomic.ts
import type { SkillSpec } from "../engine/skillEngine.js";

export type RefreshMode = "LOCAL_ONLY" | "PUBLISH_IF_AVAILABLE";

export type LastGoodPointer = {
  updatedAt: number;
  indexPath: string;
  scoresPath: string;
  indexBackupPath?: string;
  scoresBackupPath?: string;
};

export type RefreshCtx = {
  mode: RefreshMode;
  intervalTag?: string;
  now?: number;
  baseDir: string;
  dataDir: string;
  indexPath: string;
  scoresPath: string;
  lastGoodPath: string;
  hasVolume?: boolean;
  canWrite?: boolean;
  indexJson?: any;
  scoresJson?: any;
  indexCount?: number;
  scoredCount?: number;
  wrote?: string[];
  published?: boolean;
  lastGood?: LastGoodPointer | null;
  pendingBackups?: { indexBak?: string; scoresBak?: string };
  note?: string;
  errorCode?: string;
  adapters?: {
    checkVolume: (ctx: RefreshCtx) => Promise<{ hasVolume: boolean; canWrite: boolean; note?: string }>;
    buildIndex: (ctx: RefreshCtx) => Promise<{ indexJson: any; indexCount: number; note?: string }>;
    scoreIndex: (ctx: RefreshCtx) => Promise<{ scoresJson: any; scoredCount: number; note?: string }>;
    writeAtomic: (ctx: RefreshCtx) => Promise<{ wrote: string[]; backups: { indexBak?: string; scoresBak?: string }; note?: string }>;
    loadLastGood: (ctx: RefreshCtx) => Promise<{ lastGood: LastGoodPointer | null; note?: string }>;
    commitLastGood: (ctx: RefreshCtx) => Promise<{ lastGood: LastGoodPointer; note?: string }>;
    rollback: (ctx: RefreshCtx) => Promise<{ rolledBack: boolean; note?: string }>;
    publish?: (ctx: RefreshCtx) => Promise<{ published: boolean; note?: string }>;
  };
};

export const refreshPipelineAtomicSpec: SkillSpec<RefreshCtx> = {
  name: "verity.refresh_pipeline_atomic",
  version: "0.2.0",
  start: "Start",
  terminal: ["Done"],
  fail: ["BadConfig", "NoVolume", "ReadOnlyVolume", "IndexFailed", "ScoreFailed", "PartialWrite", "WriteFailed", "CommitFailed", "RollbackFailed", "PublishFailed", "ActionError", "Stuck", "GuardsBlocked"],

  states: {
    Start: {
      onEnter: async (ctx, api) => {
        ctx.now = ctx.now ?? Date.now();
        if (!ctx.baseDir) api.fail("BadConfig", "missing baseDir");
        if (!ctx.dataDir) api.fail("BadConfig", "missing dataDir");
        if (!ctx.indexPath) api.fail("BadConfig", "missing indexPath");
        if (!ctx.scoresPath) api.fail("BadConfig", "missing scoresPath");
        if (!ctx.lastGoodPath) api.fail("BadConfig", "missing lastGoodPath");
        const a = ctx.adapters;
        if (!a?.checkVolume) api.fail("BadConfig", "missing adapters.checkVolume");
        if (!a?.loadLastGood) api.fail("BadConfig", "missing adapters.loadLastGood");
        if (!a?.buildIndex) api.fail("BadConfig", "missing adapters.buildIndex");
        if (!a?.scoreIndex) api.fail("BadConfig", "missing adapters.scoreIndex");
        if (!a?.writeAtomic) api.fail("BadConfig", "missing adapters.writeAtomic");
        if (!a?.commitLastGood) api.fail("BadConfig", "missing adapters.commitLastGood");
        if (!a?.rollback) api.fail("BadConfig", "missing adapters.rollback");
        ctx.note = `refresh atomic start ${ctx.intervalTag ?? ""}`.trim();
      },
    },
    DetectStorage: {
      onEnter: async (ctx) => {
        const res = await ctx.adapters!.checkVolume(ctx);
        ctx.hasVolume = res.hasVolume;
        ctx.canWrite = res.canWrite;
        ctx.note = [ctx.note, res.note].filter(Boolean).join(" | ");
      },
    },
    LoadLastGood: {
      onEnter: async (ctx) => {
        const res = await ctx.adapters!.loadLastGood(ctx);
        ctx.lastGood = res.lastGood;
        ctx.note = [ctx.note, res.note].filter(Boolean).join(" | ");
      },
    },
    EnsureWritable: {},
    BuildIndex: {
      onEnter: async (ctx, api) => {
        try {
          const res = await ctx.adapters!.buildIndex(ctx);
          ctx.indexJson = res.indexJson;
          ctx.indexCount = res.indexCount;
          ctx.note = [ctx.note, res.note].filter(Boolean).join(" | ");
        } catch (e: any) {
          ctx.errorCode = "INDEX_EXCEPTION";
          api.fail("IndexFailed", e?.message ?? "buildIndex failed");
        }
      },
    },
    Score: {
      onEnter: async (ctx, api) => {
        try {
          const res = await ctx.adapters!.scoreIndex(ctx);
          ctx.scoresJson = res.scoresJson;
          ctx.scoredCount = res.scoredCount;
          ctx.note = [ctx.note, res.note].filter(Boolean).join(" | ");
        } catch (e: any) {
          ctx.errorCode = "SCORE_EXCEPTION";
          api.fail("ScoreFailed", e?.message ?? "scoreIndex failed");
        }
      },
    },
    WriteAtomic: {
      onEnter: async (ctx, api) => {
        try {
          const res = await ctx.adapters!.writeAtomic(ctx);
          ctx.wrote = res.wrote;
          ctx.pendingBackups = res.backups;
          ctx.note = [ctx.note, res.note].filter(Boolean).join(" | ");
        } catch (e: any) {
          ctx.errorCode = "WRITE_ATOMIC_EXCEPTION";
          api.fail("PartialWrite", e?.message ?? "writeAtomic failed");
        }
      },
    },
    CommitPointer: {
      onEnter: async (ctx, api) => {
        try {
          const res = await ctx.adapters!.commitLastGood(ctx);
          ctx.lastGood = res.lastGood;
          ctx.note = [ctx.note, res.note].filter(Boolean).join(" | ");
        } catch (e: any) {
          ctx.errorCode = "COMMIT_LAST_GOOD_EXCEPTION";
          api.fail("CommitFailed" as any, e?.message ?? "commitLastGood failed");
        }
      },
    },
    Publish: {
      onEnter: async (ctx, api) => {
        if (ctx.mode === "LOCAL_ONLY") { ctx.published = false; return; }
        if (!ctx.adapters?.publish) { ctx.published = false; return; }
        try {
          const res = await ctx.adapters.publish(ctx);
          ctx.published = res.published;
        } catch (e: any) {
          ctx.errorCode = "PUBLISH_EXCEPTION";
          api.fail("PublishFailed", e?.message ?? "publish failed");
        }
      },
    },
    Rollback: {
      onEnter: async (ctx, api) => {
        try {
          const res = await ctx.adapters!.rollback(ctx);
          ctx.note = [ctx.note, res.note].filter(Boolean).join(" | ");
        } catch (e: any) {
          ctx.errorCode = "ROLLBACK_EXCEPTION";
          api.fail("RollbackFailed", e?.message ?? "rollback failed");
        }
      },
    },
    Done: {},
    BadConfig: {}, NoVolume: {}, ReadOnlyVolume: {}, IndexFailed: {}, ScoreFailed: {},
    PartialWrite: {}, WriteFailed: {}, CommitFailed: {}, RollbackFailed: {}, PublishFailed: {},
    ActionError: {}, Stuck: {}, GuardsBlocked: {},
  },

  transitions: [
    { from: "Start", to: "DetectStorage", label: "init ok" },
    { from: "DetectStorage", to: "NoVolume", label: "no volume", guard: (ctx) => !ctx.hasVolume },
    { from: "DetectStorage", to: "ReadOnlyVolume", label: "read-only", guard: (ctx) => !!ctx.hasVolume && !ctx.canWrite },
    { from: "DetectStorage", to: "LoadLastGood", label: "ok", guard: (ctx) => !!ctx.hasVolume && !!ctx.canWrite },
    { from: "LoadLastGood", to: "EnsureWritable", label: "loaded pointer" },
    { from: "EnsureWritable", to: "BuildIndex", label: "go index" },
    { from: "BuildIndex", to: "Score", label: "go score", guard: (ctx) => ctx.indexJson !== undefined },
    { from: "Score", to: "WriteAtomic", label: "go write", guard: (ctx) => ctx.scoresJson !== undefined },
    { from: "WriteAtomic", to: "CommitPointer", label: "commit pointer" },
    { from: "CommitPointer", to: "Publish", label: "optional publish" },
    { from: "Publish", to: "Done", label: "done" },
    { from: "PartialWrite", to: "Rollback", label: "rollback after partial" },
    { from: "CommitFailed", to: "Rollback", label: "rollback after commit failed" },
    { from: "Rollback", to: "Done", label: "done after rollback" },
  ],
};
