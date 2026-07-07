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
| `enforce` | Score every action; **abort STOP / hard-block / unapproved-confirmation** verdicts. Eliza catches the throw and converts it to a failureResult. |

Start in `observe` for a few days to see what the verdicts look like on your traffic. Switch to `enforce` once you trust the scoring.

## Human-in-the-loop: the confirmation flow (v0.3.0)

A risky-but-not-forbidden action (e.g. a large `send_money`) often comes back from BLACK_WALL not as a flat `STOP` but as a verdict that carries a **confirmation handle** — the server has opened a human-approval request and handed you a `poll_url`:

```jsonc
{ "recommendation": "CAUTION", "gate": "CONFIRM",
  "confirmation": { "id": "conf_…", "status": "pending", "poll_url": "https://…" },
  "hard_blocks": [] }
```

Before v0.3.0 the plugin ignored the handle: in enforce it just ran (CAUTION ≠ STOP), and there was no way to route the action to a human. v0.3.0 makes the plugin **confirmation-aware**.

How a confirmation verdict is handled, in precedence order (strictest-wins):

1. **`hard_blocks` present** → treated as a hard STOP. Enforce throws; observe runs. The confirmation path is **not** entered.
2. **confirmation requirement present** (a `confirmation` object on the verdict — detected by **presence**, not by `poll_url`):
   - **observe mode** → the action **still runs** (observe never alters behavior). The plugin emits a `confirmation_required` event and calls your `onConfirmationRequired` callback so you have visibility.
   - **enforce mode, no pollable `poll_url`** (missing / empty / non-string, or an **off-origin** URL we can never authenticate against) → there is no way to obtain an explicit approval, so the action **fails closed and aborts** (throws `… requires human confirmation but no pollable approval URL was provided`). A malformed/partial server response can never silently run the action ungated.
   - **enforce mode, usable same-origin `poll_url`** → the plugin **polls** `poll_url` (`GET`, `Authorization: Bearer <apiKey>`) every `confirmationPollMs` up to a total `confirmationWaitMs` budget:
     - poll returns `status: "approved"` → action **runs**.
     - poll returns `status: "rejected"` → action **aborts** (throws `… was REJECTED by human confirmation`).
     - still pending when the budget elapses, **or any poll error / non-2xx / unparseable body / network failure** → action **aborts** (throws `… requires human confirmation (pending) — approve at <poll_url>`).
3. **legacy `STOP`** (no confirmation) → unchanged: enforce throws, observe runs.
4. **GO / CAUTION** (no confirmation) → unchanged: runs.

### `confirmationWaitMs` defaults to `0` — abort and surface

**The default (`confirmationWaitMs: 0`) means: check once, do not wait. A still-pending confirmation aborts immediately**, and the thrown error carries the `poll_url` so your operator can approve out of band. This is the safe default — your agent never silently blocks for minutes, and there is **zero safety regression vs v0.2.x**: in enforce mode an action with a confirmation handle **never runs unless a poll explicitly returned `approved`**.

Set `confirmationWaitMs` to a positive value (e.g. `30000`) only if you want the handler to block in-process waiting for a fast human approval.

```ts
blackwallGuardrail({
  mode: 'enforce',
  confirmationWaitMs: 0,        // default — abort-and-surface; raise to wait in-process
  confirmationPollMs: 2000,     // poll interval (floor 250ms)
  onConfirmationRequired: (handle, { actionName }) => {
    // fired in BOTH modes — route a human-approval prompt anywhere you like
    notifyOperator(`approve "${actionName}": ${handle.poll_url}`);
  },
});
```

Failure is **closed**: an unverifiable approval (timeout, network error, garbage body) is treated as *not approved*. The action does not run.

## Gate outage: fail-open (default) vs fail-closed (opt-in)

When `forecast()` **throws** — BLACK_WALL is down, the network times out, or the server returns a 2xx body with no usable verdict — the plugin has to decide whether to run the action *without* a gate decision. This is a **security-vs-availability tradeoff**, and it is distinct from the confirmation poll above (which fails closed only *after* a successful forecast returns a confirmation requirement).

- **Default — fail-OPEN.** A BLACK_WALL outage must never break your agent, so the wrapped handler **runs ungated**, logs a warning, and emits a `forecast_error` event. This is the v0.2.x/v0.3.x availability doctrine and is **unchanged** — drop-in upgrades keep failing open.
- **Opt-in — fail-CLOSED.** For high-stakes actions (payments, transfers, irreversible writes), running ungated on an outage is a hole: an attacker who can *induce* a gate outage gets every action run unprotected. Set `failClosed` and, **in enforce mode**, a forecast error on a configured action **aborts** instead of running — the plugin emits a `fail_closed` event and throws `BLACK_WALL: gate unavailable — failing closed for action "<name>" (forecast error: <msg>)`.

`failClosed` accepts:

| Value | Effect on a forecast error (enforce mode) |
|---|---|
| `false` (**default**) | Fail open — run ungated (backward-compatible). |
| `true` | Fail closed for **all** actions. |
| `string[]` | Fail closed **only** for actions whose name is in the list. |
| `(actionName) => boolean` | Fail closed when the predicate returns `true`. |

Env fallback **`BLACKWALL_FAIL_CLOSED`**: `'true'` / `'false'`, or a comma-separated action list (`PAY_NEW_PAYEE,TRANSFER`). A `failClosed` config value **always wins over** the env var. A **string** config value is parsed with the same rules as the env var (so `failClosed: 'false'` means *none* — it never silently inverts to fail-closed-for-all); any other off-contract type falls back to the safe default (fail-open).

```ts
blackwallGuardrail({
  mode: 'enforce',
  // Only payments fail closed on an outage; everything else stays fail-open.
  failClosed: ['PAY_NEW_PAYEE', 'TRANSFER'],
  // or: failClosed: true                       // all actions
  // or: failClosed: (name) => name.startsWith('PAY')
});
```

**Scope — this can only make enforce *more* restrictive.** `failClosed` changes behavior **only** on the forecast-error path, and **only** in enforce mode:

- **observe mode is never affected** — observe never aborts (its contract), so `failClosed` is a no-op there; the action always runs on a forecast error.
- The **verdict paths are untouched** — a successful `GO` still runs, a `STOP` still aborts with its normal error, and a confirmation verdict still polls. `failClosed` never fires on any of these.
- For a configured action, the only change is **abort instead of run** on an outage. It is structurally impossible for `failClosed` to cause an action to *run* that previously aborted: the fail-open branch is byte-for-byte the prior behavior, and the new branch only ever throws.

`gateCall()` honors `failClosed` identically (the posture decision is shared between the action wrap and `gateCall()`), so per-call steps inside a multi-step handler also fail closed on an outage when configured.

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
  maxInputBytes: 8 * 1024,                // hard cap on the forecast payload size
  sendUserIntent: false,                  // do NOT send the user's message text (see Data & privacy)
  failClosed: ['PAY_NEW_PAYEE'],          // abort (don't run) on a gate OUTAGE — enforce only. Default false = fail-open. Env BLACKWALL_FAIL_CLOSED
  onEvent: (event) => myTelemetry(event), // optional telemetry hook

  // Human-in-the-loop confirmation flow (v0.3.0):
  confirmationWaitMs: 0,                   // enforce-mode wait budget; 0 = abort-and-surface (default). Env BLACKWALL_CONFIRMATION_WAIT_MS
  confirmationPollMs: 2000,                // poll interval, floor 250ms. Env BLACKWALL_CONFIRMATION_POLL_MS
  onConfirmationRequired: (handle, meta) => routeApproval(handle, meta), // optional, fires in both modes
});
```

### Telemetry events

`onEvent` fires for: `decision`, `init`, `wrapped`, `skipped`, `forecast_error`, `fail_closed`, `stop`, `observe_error`, and the confirmation events `confirmation_required`, `confirmation_approved`, `confirmation_rejected`, `confirmation_pending`. Useful for piping guardrail decisions into your own observability stack. (`forecast_error` fires when a gate outage is handled fail-open; `fail_closed` fires when it is handled fail-closed — see [fail-closed](#gate-outage-fail-open-default-vs-fail-closed-opt-in).)

### Verifiable decision receipts (`decision` event)

A `decision` event fires **once per gated decision, in both modes**, carrying a
`receipt` — the gate's **independently verifiable** record of what it decided.
BLACK_WALL signs every verdict with Ed25519 and anchors it in a transparency log,
so you can prove what the gate told you **without trusting this plugin or
re-calling the API**:

- Fetch the issuer's public keys: [`https://blackwalltier.com/.well-known/blackwall-signing-keys.json`](https://blackwalltier.com/.well-known/blackwall-signing-keys.json) (rotating; `active_key_id` + retired keys for grace-period verification).
- Verify a receipt yourself with any Ed25519 (RFC 8032) library, or via the hosted verify endpoint `https://blackwalltier.com/api/v1/receipts/verify`.
- Check transparency-log inclusion at `https://blackwalltier.com/api/v1/receipts/:id/inclusion` (receipts are batched and anchored on-chain).

Capture them straight off the event:

```js
blackwallGuardrail({
  onEvent: (e) => { if (e.type === 'decision') myAuditStore.append(e.receipt); },
});
```

The receipt is a neutral, portable proof of every allow/stop your agent made —
the audit trail regulated or high-stakes agents need, that you can hand to a
third party and they can check for themselves.

## How it works

1. At plugin `init`, walks `runtime.actions[]` and replaces each `handler` with a wrapper.
2. Before each call, the wrapper sends `{action, inputs, context}` to BLACK_WALL `/api/v1/forecast`.
3. In `enforce` mode, a `STOP` verdict throws — Eliza's dispatcher catches it and the action does not run.
4. After the action runs (or after a STOP), the wrapper calls `/api/v1/forecast/:id/outcome` so BLACK_WALL can learn from real-world divergence.

Fail-open (default): if BLACK_WALL is unreachable, the wrapper logs a warning and lets the action proceed. Network glitches at BLACK_WALL won't take down your agent. For high-stakes actions you can opt into [fail-closed](#gate-outage-fail-open-default-vs-fail-closed-opt-in) so an outage aborts instead.

## Data & privacy

The guardrail sends data to the BLACK_WALL API (`baseUrl`, default `https://blackwalltier.com`) on **every gated action** so it can score risk. Be aware of exactly what leaves your machine:

| Field | Contents | Sent by default |
|---|---|---|
| `action` | The action name (e.g. `send_email`) | yes |
| `inputs` | The action's parameters, truncated to `maxInputBytes` (default 8 KB) — may include recipients, amounts, addresses, etc. | yes |
| `context.agent_role` | Your character's `name` | yes |
| `context.user_intent` | **The raw inbound user message text** | yes — set `sendUserIntent: false` (or `BLACKWALL_SEND_USER_INTENT=false`) to omit |

If your agent handles sensitive or regulated content, review this before enabling `enforce` (or `observe`) in production:

- **`sendUserIntent: false`** stops the raw user message from being transmitted; the gate still scores the action + inputs.
- **`maxInputBytes`** is a *hard* cap — payloads over it (including wide objects) are replaced with a compact shape summary, never shipped whole.
- **`shouldGate`** lets you exclude specific actions from gating (and therefore from any transmission) entirely.
- Point **`baseUrl`** at a self-hosted BLACK_WALL deployment if you don't want data going to the hosted service.

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

## Design partners wanted

Building an ElizaOS agent that takes **real irreversible actions** (on-chain transactions, payments, destructive tool calls)? I'm onboarding a handful of **design partners**:

- **You get:** free Black_Wall access + hands-on integration support, and signed, verifiable decision receipts.
- **You give:** run the gate in `observe` mode (it never blocks your agent) and flag, on a sample of actions, whether a decision was right or wrong. That feedback is what makes the gate learn your real risk surface.

Nothing custodial — no funds, keys, or private data leave your side. ~10 minutes a week.

**→ Apply as a design partner** (2-min form): https://docs.google.com/forms/d/e/1FAIpQLScw4TxRhMn-qrg91jDyvP0U2-yzcEmKxdwqINbNhoka4hUkXA/viewform — or [open an issue](https://github.com/bluetieroperations-create/blackwall-eliza-guardrail/issues/new).

## Changelog

### 0.5.0

- **Verifiable decision receipts surfaced.** New telemetry event `decision`, fired **once per gated decision in both modes**, carries the gate's `receipt` — the Ed25519-signed, transparency-anchored record of what BLACK_WALL decided. Capture it off `onEvent` to keep an **independently verifiable** audit trail you can hand to a third party (verify against the issuer's [published signing keys](https://blackwalltier.com/.well-known/blackwall-signing-keys.json) / verify endpoint / inclusion proof — no need to trust this plugin). See [Verifiable decision receipts](#verifiable-decision-receipts-decision-event).
- Backward-compatible: purely additive. No `decision` event is emitted when the gate returns no receipt (no phantom events); all existing events and behavior are unchanged.

### 0.4.0

- **Opt-in fail-closed on gate outage.** New config `failClosed` (env fallback `BLACKWALL_FAIL_CLOSED`). When `forecast()` throws (gate down / network / timeout / verdict-less body) in **enforce** mode, a configured action now **aborts** instead of running ungated. Accepts `false` (default — fail-open, backward-compatible), `true` (all actions), a `string[]` of action names, or a `(actionName) => boolean` predicate. Config wins over env. See [Gate outage: fail-open vs fail-closed](#gate-outage-fail-open-default-vs-fail-closed-opt-in).
- **Default is unchanged (fail-OPEN).** Existing installs upgrade with zero behavior change. This release can only make enforce *more* restrictive for explicitly-configured actions, and **only** on the forecast-error path — verdict paths (GO/STOP/confirmation) and observe mode are untouched. It is structurally impossible for `failClosed` to make an action run that previously aborted.
- New telemetry event: `fail_closed` (emitted instead of `forecast_error` when an outage is handled fail-closed).
- `gateCall()` honors `failClosed` via the same shared `onForecastError` path as the action wrap.

### 0.3.0

- **Confirmation-aware enforcement.** The plugin now honors the verdict's `hard_blocks` and `confirmation` handle, not just `recommendation === 'STOP'`. In enforce mode a confirmation verdict is routed to a human-approval poll instead of being silently run (CAUTION) or hard-aborted. See [the confirmation flow](#human-in-the-loop-the-confirmation-flow-v030).
- New optional config (all env-backed, backward-compatible): `confirmationWaitMs` (default **0** = abort-and-surface), `confirmationPollMs` (default 2000, floor 250), `onConfirmationRequired` callback.
- New telemetry events: `confirmation_required`, `confirmation_approved`, `confirmation_rejected`, `confirmation_pending`.
- **Fail-closed safety invariant:** in enforce mode an action carrying a confirmation requirement never runs unless a same-origin poll explicitly returns `status: 'approved'`. Timeout, rejection, poll error, non-2xx, garbage body, **and a missing/empty/off-origin (non-pollable) `poll_url`** all abort. The requirement is detected by the **presence** of the `confirmation` object (not by `poll_url`), so a malformed/partial server response cannot make a confirmation-bearing action run ungated. No safety regression vs 0.2.x; pure default-additive behavior change is gated behind enforce mode + a present confirmation requirement, which the server only began returning alongside this release.
- Shared verdict-handling path now used by both the action-handler wrap and `gateCall()`.

## License

MIT
