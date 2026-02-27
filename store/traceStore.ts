// store/traceStore.ts
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { TraceEvent, RunResult } from "../engine/skillEngine.js";

export type TraceSummary = {
  trace_id: string;
  skill: string;
  version: string;
  ok: boolean;
  startState: string;
  endState: string;
  steps: number;
  ts: number;         // epoch ms when recorded
  ctx_summary: Record<string, any>;
  trace: TraceEvent[];
};

/**
 * Generate a compact, sortable trace ID.
 * Format: {skill_short}.{ts_base36}.{4hex}
 * e.g. "surv.lz3k1a.3f7c"
 */
export function generateTraceId(skillName: string): string {
  const short = skillName
    .split(".")
    .map((p) => p.slice(0, 4))
    .join("_");
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(2).toString("hex");
  return `${short}.${ts}.${rand}`;
}

/**
 * Extract a safe ctx_summary — only primitive fields, no adapters/fns.
 */
function summarizeCtx(ctx: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(ctx ?? {})) {
    if (k === "adapters") continue;
    if (typeof v === "function") continue;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      // shallow flatten simple objects
      try {
        const shallow = JSON.parse(JSON.stringify(v));
        out[k] = shallow;
      } catch {
        out[k] = "[non-serializable]";
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class TraceStore {
  private tracesDir: string;

  constructor(dataDir: string) {
    this.tracesDir = path.join(dataDir, "traces");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.tracesDir, { recursive: true });
  }

  async record<C>(result: RunResult<C>): Promise<string> {
    const trace_id = generateTraceId(result.skill.name);

    const summary: TraceSummary = {
      trace_id,
      skill: result.skill.name,
      version: result.skill.version,
      ok: result.ok,
      startState: result.startState,
      endState: result.endState,
      steps: result.steps,
      ts: Date.now(),
      ctx_summary: summarizeCtx(result.ctx),
      trace: result.trace,
    };

    const filename = `${trace_id}.json`;
    const filepath = path.join(this.tracesDir, filename);

    // Atomic write
    const tmp = `${filepath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(summary, null, 2), "utf8");
    await fs.rename(tmp, filepath);

    return trace_id;
  }

  async get(trace_id: string): Promise<TraceSummary | null> {
    try {
      const raw = await fs.readFile(path.join(this.tracesDir, `${trace_id}.json`), "utf8");
      return JSON.parse(raw) as TraceSummary;
    } catch {
      return null;
    }
  }

  /**
   * List recent traces, newest first.
   * Optionally filter by skill prefix (e.g. "survivor", "verity")
   */
  async list(opts?: { limit?: number; skill?: string }): Promise<TraceSummary[]> {
    const limit = opts?.limit ?? 50;
    try {
      let files = await fs.readdir(this.tracesDir);
      files = files
        .filter((f) => f.endsWith(".json"))
        .filter((f) => (opts?.skill ? f.includes(opts.skill) : true))
        .sort()
        .reverse()
        .slice(0, limit);

      const results = await Promise.all(
        files.map(async (f) => {
          try {
            const raw = await fs.readFile(path.join(this.tracesDir, f), "utf8");
            return JSON.parse(raw) as TraceSummary;
          } catch {
            return null;
          }
        })
      );
      return results.filter(Boolean) as TraceSummary[];
    } catch {
      return [];
    }
  }

  /**
   * Prune old traces. Keeps newest N per skill.
   */
  async prune(keepPerSkill = 200): Promise<{ deleted: number }> {
    let deleted = 0;
    try {
      const files = (await fs.readdir(this.tracesDir))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();

      const bySkill: Record<string, string[]> = {};
      for (const f of files) {
        // skill is everything before the second dot segment
        const skill = f.split(".").slice(0, 2).join(".");
        (bySkill[skill] ??= []).push(f);
      }

      for (const [, skillFiles] of Object.entries(bySkill)) {
        const toDelete = skillFiles.slice(keepPerSkill);
        for (const f of toDelete) {
          try {
            await fs.unlink(path.join(this.tracesDir, f));
            deleted++;
          } catch {}
        }
      }
    } catch {}
    return { deleted };
  }
}

// Singleton — initialized once on server boot
let _store: TraceStore | null = null;

export function initTraceStore(dataDir: string): TraceStore {
  _store = new TraceStore(dataDir);
  return _store;
}

export function getTraceStore(): TraceStore {
  if (!_store) throw new Error("TraceStore not initialized. Call initTraceStore(dataDir) first.");
  return _store;
}
