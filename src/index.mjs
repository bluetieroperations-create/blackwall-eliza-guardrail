/**
 * blackwall-eliza-guardrail
 * -------------------------
 * ElizaOS plugin that puts BLACK_WALL in front of every action the agent can
 * take. At init time we walk `runtime.actions[]` and replace each handler with
 * a wrapper that:
 *
 *   1. calls forecast() with the action name + args
 *   2. in `enforce` mode, throws if the verdict is STOP (Eliza's dispatcher
 *      catches the throw and converts it to a failureResult — clean abort)
 *   3. runs the original handler
 *   4. calls observe() with the actual outcome (matched / diverged / aborted)
 *
 * The HOOK_TOOL_BEFORE event Eliza declares in its EventType enum is NEVER
 * emitted in the runtime (verified 2026-05-28). Handler-wrap at init is the
 * only path that actually gates execution today.
 *
 * Load order matters: list this plugin LAST so it wraps every action other
 * plugins contributed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { forecast, observe } from 'blackwall-mcp/lib';

// Threads the current action's forecast id into its running handler so gateCall()
// can link each per-call forecast to one chain (the partial-execution fix). ALS
// keeps concurrent actions isolated — no runtime mutation, no cross-action bleed.
const actionForecastContext = new AsyncLocalStorage();

// Cap how big a parameter blob we ship to forecast(). Large prompts / file
// payloads can balloon a single observe call; the verdict only needs enough
// signal to reason about the action, not the full attachment.
const DEFAULT_MAX_INPUT_BYTES = 8 * 1024;

/**
 * @typedef {'enforce' | 'observe'} GuardrailMode
 */

/**
 * @typedef {Object} BlackwallGuardrailConfig
 * @property {string} [apiKey]      BLACK_WALL API key. Defaults to env BLACKWALL_API_KEY.
 * @property {string} [baseUrl]     Defaults to env BLACKWALL_BASE_URL or https://blackwalltier.com.
 * @property {GuardrailMode} [mode] 'observe' (default — log only, never abort) or 'enforce' (throw on STOP).
 * @property {(actionName: string) => boolean} [shouldGate] Per-action opt-out. Return false to skip wrapping.
 * @property {number} [maxInputBytes] Hard cap on the forecast() inputs payload size. Default 8KB.
 * @property {boolean} [sendUserIntent] Send the raw inbound user message as context.user_intent. Default true; set false (or BLACKWALL_SEND_USER_INTENT=false) to keep user message text on-box.
 * @property {(event: GuardrailEvent) => void} [onEvent] Telemetry hook (logged on STOP, error, observe failure, etc.).
 */

/**
 * @typedef {Object} GuardrailEvent
 * @property {'wrapped'|'forecast_error'|'stop'|'observe_error'|'skipped'|'init'} type
 * @property {string} [actionName]
 * @property {string} [forecastId]
 * @property {string} [recommendation]
 * @property {unknown} [error]
 * @property {Record<string, any>} [extra]
 */

/**
 * Resolve config at plugin construction time. Each field falls back to env so
 * the simplest install is `plugins: [blackwallGuardrail()]` with env set.
 *
 * @param {BlackwallGuardrailConfig} [config]
 */
function resolveConfig(config = {}) {
  const mode = (config.mode ?? process.env.BLACKWALL_MODE ?? 'observe').toLowerCase();
  return {
    apiKey: config.apiKey ?? process.env.BLACKWALL_API_KEY,
    baseUrl: config.baseUrl ?? process.env.BLACKWALL_BASE_URL,
    mode: mode === 'enforce' ? 'enforce' : 'observe',
    shouldGate: typeof config.shouldGate === 'function' ? config.shouldGate : () => true,
    maxInputBytes: typeof config.maxInputBytes === 'number' ? config.maxInputBytes : DEFAULT_MAX_INPUT_BYTES,
    // Egress consent (audit M-1): the wrapper sends the raw inbound user message as
    // `context.user_intent` so forecast() can reason about intent. Operators who do
    // not want user message text leaving the box can opt out (config or
    // BLACKWALL_SEND_USER_INTENT=false). Defaults to true (current behavior).
    sendUserIntent:
      config.sendUserIntent !== undefined
        ? config.sendUserIntent !== false
        : process.env.BLACKWALL_SEND_USER_INTENT !== 'false',
    onEvent: typeof config.onEvent === 'function' ? config.onEvent : null,
  };
}

/**
 * Best-effort extraction of structured args from Eliza's variable handler
 * signature. Across versions Eliza has passed parameters via options.parameters,
 * options.args, or by reaching into the inbound message. Try them all; fall
 * back to {} rather than failing the whole wrap.
 */
function extractActionInputs(actionName, message, opts) {
  const fromOpts =
    opts && typeof opts === 'object'
      ? opts.parameters ?? opts.args ?? opts.input ?? null
      : null;
  if (fromOpts && typeof fromOpts === 'object') return fromOpts;

  const fromMessage = message?.content?.metadata?.parameters;
  if (fromMessage && typeof fromMessage === 'object') return fromMessage;

  return {};
}

/**
 * Trim a payload if its serialized form exceeds `maxBytes`. We keep the
 * top-level keys but replace overly-long string values with a marker so the
 * forecast still sees the *shape* of the action.
 */
function truncateInputs(inputs, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(inputs);
  } catch {
    return { _truncated: true, _reason: 'unserializable' };
  }
  if (serialized.length <= maxBytes) return inputs;

  if (Array.isArray(inputs)) {
    return { _truncated: true, _length: inputs.length, _byteSize: serialized.length };
  }
  if (typeof inputs !== 'object' || inputs === null) {
    return { _truncated: true, _byteSize: serialized.length };
  }
  const trimmed = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string' && v.length > 200) {
      trimmed[k] = `${v.slice(0, 200)}…<truncated ${v.length} chars>`;
    } else {
      trimmed[k] = v;
    }
  }
  trimmed._truncated = true;
  trimmed._original_bytes = serialized.length;

  // HARD CAP (audit L-1): per-string trimming alone does NOT bound a WIDE object
  // (many short-valued keys) or a non-string-heavy payload — such a payload stays
  // over `maxBytes` and would ship unbounded to forecast(). If the trimmed form is
  // still over the cap, return a compact SHAPE summary instead so the bytes that
  // leave the box are always bounded regardless of input width.
  let trimmedSize;
  try {
    trimmedSize = JSON.stringify(trimmed).length;
  } catch {
    trimmedSize = Infinity;
  }
  if (trimmedSize > maxBytes) {
    // The summary must itself be BOUNDED, or the "hard cap" is a lie: sample key
    // *names* are caller-controlled and can each be arbitrarily long, so 20 of them
    // shipped verbatim can dwarf maxBytes (a wide object of long keys defeats the
    // cap exactly the way a wide object of short keys was supposed to be blocked).
    // Bound each sampled key name in length, then bound the count to whatever still
    // fits under the cap — dropping _sample_keys entirely if even one won't fit.
    const summary = {
      _truncated: true,
      _reason: 'oversize',
      _original_bytes: serialized.length,
      _keys: Object.keys(inputs).length,
    };
    const KEY_MAX = 64;
    const boundedKeys = Object.keys(inputs)
      .slice(0, 20)
      .map((k) => (k.length > KEY_MAX ? `${k.slice(0, KEY_MAX)}…` : k));
    // Fit as many sample keys as the remaining cap budget allows; if none fit,
    // omit _sample_keys so the summary can never exceed maxBytes.
    for (let n = boundedKeys.length; n >= 0; n--) {
      const candidate = n > 0 ? { ...summary, _sample_keys: boundedKeys.slice(0, n) } : summary;
      if (JSON.stringify(candidate).length <= maxBytes) return candidate;
    }
    return summary;
  }
  return trimmed;
}

/**
 * Normalize a verdict's recommendation to a canonical upper-case token before
 * comparison. The BLACK_WALL API contract does not guarantee exact casing or the
 * absence of surrounding whitespace (the sibling `blackwall-mcp/lib/gate.mjs`
 * already .toUpperCase()s it everywhere). Comparing the raw field with
 * `=== 'STOP'` would let a non-canonical "stop" / " STOP " silently BYPASS
 * enforce mode and run a STOP-rated action — defeating the entire control.
 */
function isStop(verdict) {
  const rec = verdict?.recommendation;
  return typeof rec === 'string' && rec.trim().toUpperCase() === 'STOP';
}

function emit(onEvent, event) {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    /* never let a broken telemetry hook take down the wrap */
  }
}

/**
 * Per-call gate for MULTI-STEP handlers (the partial-execution fix).
 *
 * A GO on the action as a whole does NOT cover each tool call inside the handler:
 * call #1 can land an irreversible on-chain write before a constraint trips on
 * call #2. Eliza 1.7.x has no per-tool-call hook (handler-wrap is the only abort
 * surface), so per-call gating must be opt-in: wrap each irreversible step inside
 * your handler with gateCall(). It forecasts that step THREADED to the action's
 * forecast id (so all per-call checks share one chain), enforces STOP in enforce
 * mode, runs the step, and observes the outcome.
 *
 *   import { gateCall } from 'blackwall-eliza-guardrail';
 *   // inside a multi-step action handler:
 *   await gateCall('approve_erc20', { spender, amount_usd }, () => approve(...));
 *   await gateCall('swap',          { pool, amount_usd },    () => swap(...));
 *
 * Must run inside a wrapped action handler to inherit the parent id + mode from
 * AsyncLocalStorage. Called outside one, it still gates (forecasts with no parent,
 * env-resolved config) so it's safe to use defensively.
 *
 * @template T
 * @param {string} action
 * @param {Record<string, any>} inputs
 * @param {() => Promise<T> | T} run   the actual irreversible call
 * @param {{ context?: Record<string, any>, apiKey?: string, baseUrl?: string }} [opts]
 * @returns {Promise<T>}
 * @throws when enforce mode + STOP — the step does NOT run.
 */
export async function gateCall(action, inputs, run, opts = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('gateCall(action, inputs, run): `run` must be a function (the step to guard).');
  }
  const store = actionForecastContext.getStore();
  const cfg = store?.cfg ?? resolveConfig(opts);
  const parent_forecast_id = store?.parentForecastId;

  let verdict;
  try {
    verdict = await forecast(
      {
        action,
        inputs: truncateInputs(inputs ?? {}, cfg.maxInputBytes),
        context: opts.context,
        parent_forecast_id, // thread this per-call check to the action's chain
      },
      { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }
    );
  } catch (err) {
    // Fail-open, same doctrine as the action wrap: a BLACK_WALL outage must never
    // break the agent. Run the step ungated.
    emit(cfg.onEvent, { type: 'forecast_error', actionName: action, error: err });
    return run();
  }

  const reportedVia = 'eliza_guardrail';
  if (cfg.mode === 'enforce' && isStop(verdict)) {
    emit(cfg.onEvent, { type: 'stop', actionName: action, forecastId: verdict?.id, recommendation: 'STOP' });
    if (verdict?.id) {
      observe(verdict.id, { outcome_class: 'aborted', divergence_severity: 'none', details: 'blocked by enforce-mode gateCall' },
        { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia }).catch(() => {});
    }
    const flagCodes = Array.isArray(verdict?.red_flags)
      ? verdict.red_flags.map((f) => f?.code).filter(Boolean).join(', ')
      : '';
    throw new Error(`BLACK_WALL blocked call "${action}": STOP${flagCodes ? ` (${flagCodes})` : ''}`);
  }

  try {
    const result = await run();
    if (verdict?.id) {
      observe(verdict.id, { outcome_class: 'matched' },
        { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia }).catch(() => {});
    }
    return result;
  } catch (err) {
    if (verdict?.id) {
      observe(verdict.id, { outcome_class: 'diverged', divergence_severity: 'medium', details: String(err?.message ?? err).slice(0, 500) },
        { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Wrap a single action's `.handler` with a forecast/observe envelope.
 * Returns the patched action object (mutated in place; returned for clarity).
 */
function wrapActionHandler(action, cfg, logger) {
  const original = action.handler;
  if (typeof original !== 'function') {
    emit(cfg.onEvent, { type: 'skipped', actionName: action?.name, extra: { reason: 'no-handler' } });
    return action;
  }
  if (!cfg.shouldGate(action.name)) {
    emit(cfg.onEvent, { type: 'skipped', actionName: action.name, extra: { reason: 'opt-out' } });
    return action;
  }

  action.handler = async function blackwallWrappedHandler(runtime, message, state, opts, callback, responses) {
    const inputs = truncateInputs(extractActionInputs(action.name, message, opts), cfg.maxInputBytes);
    const context = {
      ...(runtime?.character?.name ? { agent_role: runtime.character.name } : {}),
      ...(cfg.sendUserIntent && message?.content?.text ? { user_intent: message.content.text } : {}),
      source: 'elizaos',
    };

    let verdict;
    try {
      verdict = await forecast(
        { action: action.name, inputs, context },
        { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }
      );
    } catch (err) {
      // Fail-open: never let a BLACK_WALL outage break the agent. Log and let
      // the action proceed. Operators can switch to enforce-strict in a future
      // version if they want fail-closed semantics.
      logger?.warn?.(`[blackwall-guardrail] forecast() failed for action "${action.name}" — proceeding without gate: ${err?.message ?? err}`);
      emit(cfg.onEvent, { type: 'forecast_error', actionName: action.name, error: err });
      return original.call(this, runtime, message, state, opts, callback, responses);
    }

    if (cfg.mode === 'enforce' && isStop(verdict)) {
      emit(cfg.onEvent, {
        type: 'stop',
        actionName: action.name,
        forecastId: verdict?.id,
        recommendation: verdict.recommendation,
      });

      // Best-effort observation that we obeyed the STOP. Don't await — the
      // throw must hit Eliza's dispatcher promptly.
      if (verdict?.id) {
        observe(
          verdict.id,
          { outcome_class: 'aborted', divergence_severity: 'none', details: 'blocked by enforce-mode guardrail' },
          { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia: 'eliza_guardrail' }
        ).catch((err) => {
          logger?.warn?.(`[blackwall-guardrail] observe(aborted) failed: ${err?.message ?? err}`);
          emit(cfg.onEvent, { type: 'observe_error', actionName: action.name, forecastId: verdict.id, error: err });
        });
      }

      const flagCodes = Array.isArray(verdict?.red_flags)
        ? verdict.red_flags.map((f) => f?.code).filter(Boolean).join(', ')
        : '';
      throw new Error(
        `BLACK_WALL blocked action "${action.name}": ${verdict?.recommendation}${flagCodes ? ` (${flagCodes})` : ''}`
      );
    }

    // observe mode (or non-STOP verdict): run the action, observe the outcome.
    let outcome = 'matched';
    let observeDetails;
    let actionError;
    // Run the original handler inside the ALS context carrying THIS action's
    // forecast id, so any gateCall() the handler makes threads to this parent.
    const callStore = { parentForecastId: verdict?.id, cfg };
    try {
      const result = await actionForecastContext.run(callStore, () =>
        original.call(this, runtime, message, state, opts, callback, responses)
      );
      if (verdict?.id) {
        observe(
          verdict.id,
          { outcome_class: outcome },
          { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia: 'eliza_guardrail' }
        ).catch((err) => {
          logger?.warn?.(`[blackwall-guardrail] observe(${outcome}) failed: ${err?.message ?? err}`);
          emit(cfg.onEvent, { type: 'observe_error', actionName: action.name, forecastId: verdict.id, error: err });
        });
      }
      return result;
    } catch (err) {
      outcome = 'diverged';
      observeDetails = String(err?.message ?? err).slice(0, 500);
      actionError = err;
      if (verdict?.id) {
        observe(
          verdict.id,
          { outcome_class: outcome, divergence_severity: 'medium', details: observeDetails },
          { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia: 'eliza_guardrail' }
        ).catch((obErr) => {
          logger?.warn?.(`[blackwall-guardrail] observe(diverged) failed: ${obErr?.message ?? obErr}`);
          emit(cfg.onEvent, { type: 'observe_error', actionName: action.name, forecastId: verdict.id, error: obErr });
        });
      }
      throw actionError;
    }
  };

  emit(cfg.onEvent, { type: 'wrapped', actionName: action.name });
  return action;
}

/**
 * Plugin factory. Returns an object matching the Eliza Plugin contract
 * (`isValidPluginShape`): `name` + at least one of init/actions/services/etc.
 *
 *   import { blackwallGuardrail } from 'blackwall-eliza-guardrail';
 *   export const character = {
 *     plugins: [
 *       ...otherPlugins,
 *       blackwallGuardrail({ mode: 'enforce' }),  // <-- LAST
 *     ],
 *   };
 *
 * @param {BlackwallGuardrailConfig} [config]
 */
export function blackwallGuardrail(config = {}) {
  const cfg = resolveConfig(config);

  return {
    name: 'blackwall-guardrail',
    description:
      'BLACK_WALL pre-action guardrail — wraps every registered action handler with a ' +
      'forecast() check and (in enforce mode) aborts STOP-rated actions before they run.',
    init: async (runtime) => {
      const logger = runtime?.logger ?? console;
      if (!cfg.apiKey) {
        logger.warn?.(
          '[blackwall-guardrail] No apiKey configured (set BLACKWALL_API_KEY or pass { apiKey } to blackwallGuardrail()). ' +
            'Plugin will load but every forecast() call will fail and fall through.'
        );
      }
      const actions = runtime?.actions;
      if (!Array.isArray(actions) || actions.length === 0) {
        logger.warn?.(
          '[blackwall-guardrail] runtime.actions is empty at init time. ' +
            'List blackwall-eliza-guardrail LAST in your plugins array so other action-contributing plugins register first.'
        );
        emit(cfg.onEvent, { type: 'init', extra: { wrapped: 0, mode: cfg.mode } });
        return;
      }

      let wrapped = 0;
      for (const action of actions) {
        if (action && typeof action === 'object') {
          wrapActionHandler(action, cfg, logger);
          wrapped += 1;
        }
      }
      logger.info?.(`[blackwall-guardrail] wrapped ${wrapped} action handler(s) · mode=${cfg.mode}`);
      emit(cfg.onEvent, { type: 'init', extra: { wrapped, mode: cfg.mode } });
    },
  };
}

// Default export as a pre-constructed plugin for the most common case: env-based
// config, observe mode. `import blackwallGuardrail from 'blackwall-eliza-guardrail'`
// works as a drop-in plugin instance.
export default blackwallGuardrail();
