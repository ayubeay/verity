// routes/traces.ts
import { getTraceStore } from "../store/traceStore.js";

/**
 * Mount trace read routes.
 *
 * app.use("/traces", traceRouter())
 *
 * Routes:
 *   GET /traces                     → list recent (default 20, max 100)
 *   GET /traces/:trace_id           → fetch single trace receipt
 *   GET /traces?skill=survivor&limit=10
 */
export function mountTraceRoutes(app: any) {
  /**
   * GET /traces
   * Query params: skill (prefix filter), limit (1-100)
   */
  app.get("/traces", async (req: any, res: any) => {
    const limit = Math.min(parseInt(req.query?.limit ?? "20", 10), 100);
    const skill = req.query?.skill as string | undefined;

    try {
      const store = getTraceStore();
      const traces = await store.list({ limit, skill });
      return res.json({
        count: traces.length,
        traces: traces.map((t) => ({
          trace_id: t.trace_id,
          skill: t.skill,
          ok: t.ok,
          endState: t.endState,
          steps: t.steps,
          ts: t.ts,
          ts_iso: new Date(t.ts).toISOString(),
        })),
      });
    } catch (e: any) {
      return res.status(500).json({ error: "trace list failed", detail: e?.message });
    }
  });

  /**
   * GET /traces/:trace_id
   * Full trace receipt including full ctx_summary + trace events.
   *
   * Add auth middleware upstream if you don't want this public.
   */
  app.get("/traces/:trace_id", async (req: any, res: any) => {
    const { trace_id } = req.params;

    // basic sanitize — only allow our format
    if (!/^[\w_]+\.[a-z0-9]+\.[a-f0-9]+$/.test(trace_id)) {
      return res.status(400).json({ error: "invalid trace_id format" });
    }

    try {
      const store = getTraceStore();
      const trace = await store.get(trace_id);
      if (!trace) return res.status(404).json({ error: "trace not found", trace_id });
      return res.json(trace);
    } catch (e: any) {
      return res.status(500).json({ error: "trace fetch failed", detail: e?.message });
    }
  });
}
