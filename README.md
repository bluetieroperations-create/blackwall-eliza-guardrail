# blackwall-eliza-guardrail

Pre-action risk check for [ElizaOS](https://github.com/elizaOS/eliza) agents. Wraps every registered action handler so STOP-rated actions can abort *before* they run — without modifying your character or your other plugins.

Powered by [BLACK_WALL](https://blackwalltier.com). Get a free key at [blackwalltier.com/dashboard/keys](https://blackwalltier.com/dashboard/keys).

## Install

```bash
npm i blackwall-eliza-guardrail
```

```ts
// character.ts
import { blackwallGuardrail } from 'blackwall-eliza-guardrail';

export const character = {
  // ...
  plugins: [
    ...otherPlugins,
    blackwallGuardrail(), // <-- list LAST (defaults to observe mode)
  ],
};
```

```bash
# env
BLACKWALL_API_KEY=bw_live_xxx
```

That's it. Every action your agent invokes is now scored by BLACK_WALL before it runs.

## Modes

| Mode | Behavior |
|---|---|
| `observe` (default) | Score every action and log to BLACK_WALL; never abort. Zero behavior change — safe to drop in. |
| `enforce` | Score every action; **throw on STOP** verdicts. Eliza catches the throw and converts it to a failureResult. |

Start in `observe` for a few days to see what the verdicts look like on your traffic. Switch to `enforce` once you trust the scoring.

## Why list it LAST

The plugin wraps `runtime.actions[*].handler` at `init()` time. Actions registered *after* this plugin's init won't be wrapped. Listing it last guarantees every action other plugins contribute is gated.

If an action is registered after init (rare), it bypasses the guardrail. Open an issue if this matters for your setup — a `Proxy`-based variant is on the roadmap.

## Configuration

```ts
blackwallGuardrail({
  apiKey: process.env.BLACKWALL_API_KEY,  // or set env BLACKWALL_API_KEY
  baseUrl: 'https://blackwalltier.com',   // override for self-hosted / staging
  mode: 'enforce',                        // 'observe' | 'enforce'
  shouldGate: (actionName) => actionName !== 'IGNORE',  // per-action opt-out
  maxInputBytes: 8 * 1024,                // cap forecast payload size
  onEvent: (event) => myTelemetry(event), // optional telemetry hook
});
```

### Telemetry events

`onEvent` fires for: `init`, `wrapped`, `skipped`, `forecast_error`, `stop`, `observe_error`. Useful for piping guardrail decisions into your own observability stack.

## How it works

1. At plugin `init`, walks `runtime.actions[]` and replaces each `handler` with a wrapper.
2. Before each call, the wrapper sends `{action, inputs, context}` to BLACK_WALL `/api/v1/forecast`.
3. In `enforce` mode, a `STOP` verdict throws — Eliza's dispatcher catches it and the action does not run.
4. After the action runs (or after a STOP), the wrapper calls `/api/v1/forecast/:id/outcome` so BLACK_WALL can learn from real-world divergence.

Fail-open: if BLACK_WALL is unreachable, the wrapper logs a warning and lets the action proceed. Network glitches at BLACK_WALL won't take down your agent.

## Multi-step handlers — per-call gating with `gateCall()`

The action wrap forecasts the action **as a whole**. That's the right default — but a `GO` on the action does **not** cover each tool call *inside* a multi-step handler. The dangerous case: call #1 lands an irreversible on-chain write before a constraint trips on call #2. For irreversible writes, you want a check **per call**.

Eliza 1.7.x has no per-tool-call hook (see below), so per-call gating is **opt-in**: wrap each irreversible step inside your handler with `gateCall()`. It forecasts that step **threaded to the action's forecast id** — so every per-call check shares one chain — enforces `STOP` (in enforce mode), runs the step, and observes the outcome.

```ts
import { gateCall } from 'blackwall-eliza-guardrail';

// inside a multi-step action handler:
async function handler(runtime, message, state) {
  // each irreversible step is checked individually, all linked to this action's chain
  await gateCall('approve_erc20', { spender, token, amount_usd }, () => approve(spender, amount));
  await gateCall('swap',          { pool, amount_usd },           () => swap(pool, amount));
  return { ok: true };
}
```

- Runs inside a wrapped action handler → inherits the parent forecast id + mode automatically (via `AsyncLocalStorage`; no plumbing).
- Each `gateCall` forecast carries `parent_forecast_id`, so BLACK_WALL can reconstruct the whole chain and you can measure per-call STOP rates.
- In `enforce` mode, a `STOP` on any step throws **before that step runs** — the prior steps already committed are visible in the chain.
- Fail-open and observe semantics match the action wrap.

Per-action forecasting stays the default; reach for `gateCall()` only where a handler is itself multi-step and the steps are irreversible.

## Why handler-wrap?

The only events `@elizaos/core@1.7.x` emits around action execution are `ACTION_STARTED` / `ACTION_COMPLETED`. Listener errors on those are caught and logged by `executePlannedToolCall` — they don't abort the action. There is no pre-tool-call hook with abort semantics in the public surface today (earlier versions declared `HOOK_TOOL_BEFORE` in the enum, but it was never wired up; in 1.7.x it's gone entirely).

Wrapping `runtime.actions[*].handler` at init time is the only path that actually gates execution. The wrap throws on STOP, Eliza's dispatcher catches the throw, the action does not run, and a `failureResult` is recorded — exactly the desired behavior.

If upstream adds a pre-action hook with proper abort semantics in a future release, this plugin will migrate to it and the load-order caveat goes away.

## License

MIT
