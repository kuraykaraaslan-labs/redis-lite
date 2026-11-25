/** The filters of CLIENT KILL's option form (null = not given). */
export type ClientKillFilters = {
  id: number | null;
  type: string | null;
  addr: string | null;
  laddr: string | null;
  /** USER values in command order: each must name an existing user, the last one filters. */
  users: string[];
  maxAge: number | null;
  skipMe: boolean;
};
