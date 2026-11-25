import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { IntegerSchema, reject } from '@/libs/schemas';

import AclMessages from './acl.messages';

/**
 * Stateless grammar of the ACL engine's inputs: user names, the '(…)' selector arguments of a rule list and the GENPASS
 * bit count. Whether a rule names a known command or category needs the command table and stays in the rules service.
 */

// ============================================================================
// Shared Shapes
// ============================================================================

/** ACLStringHasSpaces(): whitespace or NUL. */
const SPACE_OR_NUL_RE = /[ \t\n\v\f\r\0]/;

/**
 * ACLMergeSelectorArguments(): joins '(a' 'b' 'c)' into '(a b c)'. Returns the index of an unclosed '(' as a number.
 */
function mergeSelectorArgs(args: string[]): string[] | number {
  const out: string[] = [];
  let openAt = -1;
  let selector = '';
  for (let j = 0; j < args.length; j++) {
    const op = args[j];
    if (openAt === -1 && op.startsWith('(') && !op.endsWith(')')) {
      selector = op;
      openAt = j;
      continue;
    }
    if (openAt !== -1) {
      selector += ` ${op}`;
      if (op.endsWith(')')) {
        openAt = -1;
        out.push(selector);
      }
      continue;
    }
    out.push(op);
  }
  return openAt !== -1 ? openAt : out;
}

/** A user name: no whitespace and no NUL. */
export const AclUserNameSchema = z.string().refine((name) => !SPACE_OR_NUL_RE.test(name), { error: AclMessages.USERNAME_SPACES });

// ============================================================================
// User DTOs: ACL SETUSER, users.acl lines
// ============================================================================

/** ACL SETUSER username [rule …]: the name first, then the '(…)' selectors must all be closed. */
export const SetUserDTO = z.tuple([AclUserNameSchema], z.string()).transform(([name, ...rules], ctx) => {
  const merged = mergeSelectorArgs(rules);
  if (typeof merged === 'number') return reject(ctx, formatMessage(AclMessages.UNMATCHED_PAREN, { arg: rules[merged] }));
  return { name, rules: merged };
});

/**
 * The rules of a users.acl line with their '(…)' selectors merged. Never fails: an unclosed '(' is reported as
 * `unclosed`, because the file loader collects the errors of all lines before failing.
 */
export const SelectorRulesDTO = z.array(z.string()).transform((args) => {
  const merged = mergeSelectorArgs(args);
  return typeof merged === 'number' ? { rules: [], unclosed: true } : { rules: merged, unclosed: false };
});

// ============================================================================
// GENPASS DTOs
// ============================================================================

/** ACL GENPASS's bit count, already a number: 1 to 4096. */
export const GenPassBitsDTO = z.custom<number>().refine((bits) => !(bits <= 0 || bits > 4096), { error: AclMessages.GENPASS_RANGE });

/** ACL GENPASS's bit count as an argument: an integer, then the range. */
export const GenPassArgDTO = IntegerSchema.pipe(GenPassBitsDTO);

// ============================================================================
// Type Exports
// ============================================================================

export type SetUserInput = z.infer<typeof SetUserDTO>;
export type SelectorRulesInput = z.infer<typeof SelectorRulesDTO>;
