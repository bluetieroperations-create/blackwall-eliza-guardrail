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

import { forecast, observe } from 'blackwall-mcp/lib';

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
 * @property {number} [maxInputBytes] Truncate forecast() inputs payload over this size. Default 8KB.
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
  return trimmed;
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
      ...(message?.content?.text ? { user_intent: message.content.text } : {}),
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

    if (cfg.mode === 'enforce' && verdict?.recommendation === 'STOP') {
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
    try {
      const result = await original.call(this, runtime, message, state, opts, callback, responses);
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
