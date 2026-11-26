import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { OK, RespMap, RespVerbatim } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';

import type { LatencyEventInput, LatencyHistogramInput, SlowlogGetInput } from './server.dto';
import ServerMessages from './server.messages';

/** Diagnostics: SLOWLOG and LATENCY (latency monitoring keeps no samples, so its reports are empty). */
export default class ServerDiagnosticsService {
  // ──────────────────────────────────────────────
  // Public Methods: SLOWLOG
  // ──────────────────────────────────────────────

  /** SLOWLOG GET [count]: newest first; -1 = every entry. */
  static slowlogGet(ctx: CommandContext, { count }: SlowlogGetInput): Reply {
    const slowlog = ctx.server.slowlog;
    const n = count === -1 ? slowlog.length : count;
    return slowlog.slice(0, n).map((e) => [e.id, e.time, e.usec, e.argv, e.addr, e.name]);
  }

  static slowlogLen(ctx: CommandContext): Reply {
    return ctx.server.slowlog.length;
  }

  static slowlogReset(ctx: CommandContext): Reply {
    ctx.server.slowlogReset();
    return OK;
  }

  static slowlogHelp(): Reply {
    return CommandService.helpReply('slowlog');
  }

  // ──────────────────────────────────────────────
  // Public Methods: LATENCY
  // ──────────────────────────────────────────────

  /** LATENCY LATEST / HISTORY: no samples. */
  static latencySamples(): Reply {
    return [];
  }

  /** LATENCY RESET: no event was reset. */
  static latencyReset(): Reply {
    return 0;
  }

  static latencyGraph(_ctx: CommandContext, { event }: LatencyEventInput): Reply {
    throw new AppError(formatMessage(ServerMessages.LATENCY_NO_SAMPLES, { event }));
  }

  /**
   * LATENCY HISTOGRAM [command …]: per command, its calls and the cumulative call count per power-of-two µs bucket. A
   * container name stands for its subcommands; unknown and never-called commands are left out, repeated names repeat.
   */
  static latencyHistogram(ctx: CommandContext, { names }: LatencyHistogramInput): Reply {
    const stats = ctx.server.commandStats;
    let selected: string[];
    if (!names.length) selected = [...stats.keys()];
    else {
      selected = names.flatMap((n) => {
        const meta = CommandService.getCommandMeta(n);
        if (!meta) return [];
        return meta.subcommands.size ? [...meta.subcommands.values()].map((m) => m.fullname) : [meta.fullname];
      });
    }
    const entries: Array<[string, Reply]> = [];
    for (const name of selected) {
      const histogram = stats.get(name)?.histogram;
      if (!histogram) continue;
      const buckets = new RespMap(histogram.cumulativeBuckets());
      entries.push([name, RespMap.from(['calls', histogram.calls, 'histogram_usec', buckets])]);
    }
    return new RespMap(entries);
  }

  static latencyDoctor(ctx: CommandContext): Reply {
    const disabled = ctx.server.config.num('latency-monitor-threshold') === 0;
    return new RespVerbatim(disabled ? ServerMessages.LATENCY_DOCTOR_DISABLED : ServerMessages.LATENCY_DOCTOR_OK);
  }

  static latencyHelp(): Reply {
    return CommandService.helpReply('latency');
  }
}
