// Validates blackwall-eliza-guardrail against the REAL @elizaos/core
// (not our local mock). Uses Eliza's own isValidPluginShape() to confirm the
// plugin matches the framework's contract.

import { isValidPluginShape, EventType } from '@elizaos/core';
import { blackwallGuardrail } from 'blackwall-eliza-guardrail';

let pass = 0;
let fail = 0;
function check(cond, msg) {
  if (cond) { console.log('  ok —', msg); pass++; }
  else { console.error('  FAIL —', msg); fail++; }
}

// -----------------------------------------------------------------------
console.log('\n[1] Plugin matches Eliza isValidPluginShape()');
const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'observe' });
check(isValidPluginShape(plugin) === true, 'isValidPluginShape returns true');
check(plugin.name === 'blackwall-guardrail', 'name field set');
check(typeof plugin.init === 'function', 'init function present');
check(typeof plugin.description === 'string', 'description field set');

// -----------------------------------------------------------------------
console.log('\n[2] Default-exported pre-constructed plugin is also valid');
const defaultExport = (await import('blackwall-eliza-guardrail')).default;
check(isValidPluginShape(defaultExport) === true, 'default export passes isValidPluginShape');

// -----------------------------------------------------------------------
console.log('\n[3] Confirm only ACTION_STARTED/COMPLETED exist for action lifecycle (no HOOK_TOOL_BEFORE in public EventType)');
check(!('HOOK_TOOL_BEFORE' in EventType), 'HOOK_TOOL_BEFORE NOT in public EventType (1.7.2)');
check('ACTION_STARTED' in EventType, 'ACTION_STARTED enum entry exists');
check('ACTION_COMPLETED' in EventType, 'ACTION_COMPLETED enum entry exists');
// Handoff doc noted HOOK_TOOL_BEFORE was declared-but-never-emitted in older
// versions; in 1.7.2 it's gone from the public surface entirely. Either way,
// handler-wrap at init is the only gating path available today.

// -----------------------------------------------------------------------
console.log('\n[4] init() wraps actions against an Eliza-shaped runtime');
// Build a runtime object that matches the shape executePlannedToolCall expects.
// We don't construct AgentRuntime (heavy) — just enough surface for our plugin.
let observedFetchCalls = 0;
globalThis.fetch = async (url, init) => {
  observedFetchCalls++;
  return {
    ok: true,
    status: 200,
    json: async () => ({ id: 'fc_real_1', recommendation: 'GO', risk_score: 10, red_flags: [] }),
  };
};

let originalRan = false;
const action = {
  name: 'TEST_ACTION',
  description: 'A test action',
  similes: [],
  examples: [],
  validate: async () => true,
  handler: async (runtime, message, state, options, callback) => {
    originalRan = true;
    return { success: true, text: 'ran' };
  },
};

const fakeRuntime = {
  actions: [action],
  character: { name: 'TestAgent' },
  logger: {
    info: (m) => console.log('    [runtime.logger]', m),
    warn: (m) => console.warn('    [runtime.logger]', m),
    error: (m) => console.error('    [runtime.logger]', m),
  },
};

await plugin.init(fakeRuntime);
check(action.handler.name === 'blackwallWrappedHandler', 'handler was replaced with wrapped version');

// Invoke the wrapped handler with realistic args.
const result = await action.handler(
  fakeRuntime,
  { content: { text: 'do the thing' } },
  {},
  { parameters: { foo: 'bar' } },
  () => {},
  []
);
// Give the non-awaited observe() a tick.
await new Promise((r) => setTimeout(r, 50));

check(originalRan === true, 'original handler ran after the wrap');
check(result?.success === true, 'wrapper returned original handler result');
check(observedFetchCalls >= 1, 'at least one HTTP call made (forecast)');

// -----------------------------------------------------------------------
console.log(`\n${fail === 0 ? '✓ All real-Eliza tests passed' : '✗ Some tests failed'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
