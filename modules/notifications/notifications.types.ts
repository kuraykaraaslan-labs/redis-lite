import type { Reply } from '@/libs/resp';

export interface KeyEvent {
  /** Event class character. */
  cls: string;
  event: string;
  key: string;
  /** Database the event belongs to when it is not the command's own (MOVE / COPY … DB). */
  db?: number;
}

/** What the server knows about one execution, for deriving events. */
export interface Execution {
  name: string;
  args: string[];
  reply: Reply;
  /** Keys that existed before the command, by name. */
  existedBefore: (key: string) => boolean;
  /** Keys that exist after the command. */
  existsAfter: (key: string) => boolean;
  /** Keys whose TTL was set by the command (EX/PX/… options), for the extra `expire` event. */
  hadTtlOption?: boolean;
  /** Number of elements of a key before / after the command (streams: entries), when known. */
  sizeBefore?: (key: string) => number;
  sizeAfter?: (key: string) => number;
}

/** Derives the events of one command. */
export type Emitter = (x: Execution) => KeyEvent[];

/** Parsed notify-keyspace-events flags. */
export interface NotifyFlags {
  keyspace: boolean;
  keyevent: boolean;
  classes: Set<string>;
}
