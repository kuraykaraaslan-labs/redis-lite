/** Values for the `{name}` placeholders of a message template. */
export type MessageValues = Record<string, string | number>;

const PLACEHOLDER_RE = /\{(\w+)\}/g;

/**
 * Fills the `{name}` placeholders of a message template, e.g.
 * `formatMessage(RespMessages.WRONG_ARITY, { command: 'mset' })` → `ERR wrong number of arguments for 'mset' command`.
 * A placeholder without a value is left as is, so a missing value shows up in the reply instead of vanishing.
 */
export function formatMessage(template: string, values: MessageValues): string {
  return template.replace(PLACEHOLDER_RE, (placeholder, name: string) => (name in values ? String(values[name]) : placeholder));
}
