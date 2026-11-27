import { s } from './differential.harness';
import type { Scenario, ScenarioOptions, Step } from './differential.harness';

/**
 * Integer-argument probes: values around the JS safe-integer limit (±(2^53+1)), the int64 bounds, one past int64 and one
 * past each int32 bound. Redis reads integer arguments as int64 and then checks the range each argument allows, so every
 * value lands on a different path: exact int64 arithmetic, the int range checks, or the not-an-integer error.
 */
export const INT_PROBES = [
  '9007199254740993',
  '-9007199254740993',
  '9223372036854775807',
  '-9223372036854775808',
  '9223372036854775808',
  '2147483648',
  '-2147483649',
] as const;

/**
 * The probes without the large negative counts: a random-element command (SRANDMEMBER, ZRANDMEMBER, HRANDFIELD) given
 * one tries to build a reply of that many elements.
 */
export const INT_PROBES_NO_NEGATIVE_COUNT = INT_PROBES.filter((n) => !n.startsWith('-') || n === '-9223372036854775808');

/**
 * One scenario per probe value: every `$N` in `steps` is replaced by the probe (the setup and the state checks that
 * follow the probed command are part of `steps`).
 */
export function intProbes(name: string, steps: Step[], options: ScenarioOptions = {}, values: readonly string[] = INT_PROBES): Scenario[] {
  return values.map((n) => s(`${name} <${n}>`, steps.map((step) => fill(step, n)), options));
}

function fill(step: Step, n: string): Step {
  if (typeof step === 'string') return step.replaceAll('$N', n);
  if (typeof step.cmd === 'string') return { ...step, cmd: step.cmd.replaceAll('$N', n) };
  if (Array.isArray(step.cmd)) return { ...step, cmd: step.cmd.map((arg) => (arg === '$N' ? n : arg)) };
  return step;
}
