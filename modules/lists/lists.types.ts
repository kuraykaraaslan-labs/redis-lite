import type { ValueOf } from '@/modules/database/database.types';

/**
 * The in-memory value of a list, as the database stores it. The lists module only uses the members `ListDeque` shares
 * with `Array` (`length`, `at`, `push`, `unshift`, `pop`, `shift`, `slice`, `splice`, `indexOf`, iteration), so it
 * works unchanged whichever of the two `RedisValue` holds.
 */
export type ListValue = ValueOf<'list'>;
