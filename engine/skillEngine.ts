// engine/skillEngine.ts
export type GuardFn<C> = (ctx: C) => boolean | Promise<boolean>;
export type ActionFn<C> = (ctx: C, api: EngineApi<C>) => void | Promise<void>;

export type Transition<C> = {
  from: string;
  to: string;
  guard?: GuardFn<C>;
  label?: string;
};

export type SkillSpec<C> = {
  name: string;
  version: string;
  start: string;
  terminal: string[];
  fail: string[];
  states: Record<string, {
    onEnter?: ActionFn<C>;
    onExit?: ActionFn<C>;
    meta?: Record<string, any>;
  }>;
  transitions: Transition<C>[];
};

export type TraceEvent = {
  t: number;
  type: "enter" | "exit" | "guard" | "transition" | "error" | "done";
  state?: string;
  from?: string;
  to?: string;
  label?: string;
  guardResult?: boolean;
  note?: string;
  error?: { name: string; message: string };
};

export type RunResult<C> = {
  ok: boolean;
  skill: { name: string; version: string };
  startState: string;
  endState: string;
  steps: number;
  trace: TraceEvent[];
  ctx: C;
};

export type EngineApi<C> = {
  trace: (ev: Omit<TraceEvent, "t">) => void;
  fail: (failState: string, note?: string) => never;
  set: <K extends keyof C>(k: K, v: C[K]) => void;
  get: <K extends keyof C>(k: K) => C[K];
};

export async function runSkill<C>(
  spec: SkillSpec<C>,
  ctx: C,
  opts?: { maxSteps?: number; allowedStates?: string[] }
): Promise<RunResult<C>> {
  const trace: TraceEvent[] = [];
  const now = () => Date.now();
  const push = (ev: Omit<TraceEvent, "t">) => trace.push({ t: now(), ...ev });

  const api: EngineApi<C> = {
    trace: push,
    fail: (failState: string, note?: string): never => {
      push({ type: "transition", from: current, to: failState, label: "FAIL" });
      current = failState;
      if (note) push({ type: "error", state: failState, note, error: { name: "Fail", message: note } });
      throw new SkillFail(failState, note ?? "failed");
    },
    set: (k, v) => ((ctx as any)[k] = v),
    get: (k) => (ctx as any)[k],
  };

  const maxSteps = opts?.maxSteps ?? 200;
  const allowed = opts?.allowedStates;
  let current = spec.start;
  let steps = 0;
  const isTerminal = (s: string) => spec.terminal.includes(s) || spec.fail.includes(s);

  try {
    while (!isTerminal(current)) {
      if (++steps > maxSteps) api.fail("EngineTimeout" as any, `Exceeded maxSteps=${maxSteps}`);
      if (allowed && !allowed.includes(current)) api.fail("ForbiddenState" as any, `State not allowed: ${current}`);

      const stateDef = spec.states[current];
      if (!stateDef) api.fail("MissingState" as any, `No state definition for: ${current}`);

      push({ type: "enter", state: current });

      if (stateDef.onEnter) {
        try {
          await stateDef.onEnter(ctx, api);
        } catch (e: any) {
          if (e instanceof SkillFail) throw e;
          push({ type: "error", state: current, error: { name: e?.name ?? "Error", message: e?.message ?? String(e) } });
          api.fail("ActionError" as any, `onEnter failed in ${current}`);
        }
      }

      const outgoing = spec.transitions.filter((t) => t.from === current);
      if (!outgoing.length) api.fail("Stuck" as any, `No outgoing transitions from: ${current}`);

      let moved = false;
      for (const t of outgoing) {
        let ok = true;
        if (t.guard) {
          try { ok = !!(await t.guard(ctx)); } catch { ok = false; }
          push({ type: "guard", state: current, to: t.to, label: t.label, guardResult: ok });
        }

        if (ok) {
          if (stateDef.onExit) {
            try {
              push({ type: "exit", state: current });
              await stateDef.onExit(ctx, api);
            } catch (e: any) {
              if (e instanceof SkillFail) throw e;
              push({ type: "error", state: current, error: { name: e?.name ?? "Error", message: e?.message ?? String(e) } });
              api.fail("ActionError" as any, `onExit failed in ${current}`);
            }
          }
          push({ type: "transition", from: current, to: t.to, label: t.label });
          current = t.to;
          moved = true;
          break;
        }
      }

      if (!moved) api.fail("GuardsBlocked" as any, `All guards blocked transitions from: ${current}`);
    }

    push({ type: "done", state: current, note: spec.fail.includes(current) ? "failed" : "ok" });
    return { ok: spec.terminal.includes(current), skill: { name: spec.name, version: spec.version }, startState: spec.start, endState: current, steps, trace, ctx };
  } catch (e: any) {
    const failState = e instanceof SkillFail ? e.failState : current;
    if (!spec.fail.includes(failState) && !spec.terminal.includes(failState)) {
      push({ type: "error", state: failState, error: { name: e?.name ?? "Error", message: e?.message ?? String(e) } });
    }
    return { ok: false, skill: { name: spec.name, version: spec.version }, startState: spec.start, endState: failState, steps, trace, ctx };
  }
}

class SkillFail extends Error {
  constructor(public failState: string, msg: string) {
    super(msg);
    this.name = "SkillFail";
  }
}
