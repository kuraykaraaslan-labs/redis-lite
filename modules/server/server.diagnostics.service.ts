import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { OK, RespMap, RespVerbatim } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';

import type { LatencyEventInput, LatencyHistogramInput, SlowlogGetInput } from './server.dto';
import ServerMessages from './server.messages';

/** Diagnostics: SLOWLOG and LATENCY (the latency monitor's events, the per-command histograms). */
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

  /** LATENCY LATEST: per event, the time and duration of its newest sample and its all-time maximum. */
  static latencyLatest(ctx: CommandContext): Reply {
    return [...ctx.server.observer.latencyEvents].map(([name, e]) => {
      const [time, ms] = e.samples[e.samples.length - 1];
      return [name, time, ms, e.max];
    });
  }

  /** LATENCY HISTORY event: its samples, oldest first (empty for an unknown event). */
  static latencyHistory(ctx: CommandContext, { event }: LatencyEventInput): Reply {
    return (ctx.server.observer.latencyEvents.get(event)?.samples ?? []).map(([time, ms]) => [time, ms]);
  }

  /** LATENCY RESET [event …]: forgets the named events (every event without names); the number of events reset. */
  static latencyReset(ctx: CommandContext, { names }: LatencyHistogramInput): Reply {
    const events = ctx.server.observer.latencyEvents;
    if (!names.length) {
      const n = events.size;
      events.clear();
      return n;
    }
    let n = 0;
    for (const name of names) if (events.delete(name)) n++;
    return n;
  }

  /** LATENCY GRAPH event: a text chart of the samples (4 rows high), each column labelled with the sample's age. */
  static latencyGraph(ctx: CommandContext, { event }: LatencyEventInput): Reply {
    const e = ctx.server.observer.latencyEvents.get(event);
    if (!e || !e.samples.length) throw new AppError(formatMessage(ServerMessages.LATENCY_NO_SAMPLES, { event }));
    const values = e.samples.map(([, ms]) => ms);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 5 }, () => '');
    const labels: string[] = [];
    for (const [time, ms] of e.samples) {
      const level = max === min ? 0 : Math.round(((ms - min) / (max - min)) * 3);
      for (let r = 0; r < 4; r++) rows[r] += r === 3 - level ? '_' : r > 3 - level ? '|' : ' ';
      rows[4] += ' ';
      const age = now - time;
      labels.push(age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`);
    }
    const height = Math.max(...labels.map((l) => l.length));
    for (let i = 0; i < height; i++) rows.push(labels.map((l) => l[i] ?? ' ').join(''));
    const head = `${event} - high ${max} ms, low ${min} ms (all time high ${e.max} ms)\n${'-'.repeat(80)}\n`;
    return new RespVerbatim(`${head}${rows.map((r) => `${r}\n`).join('')}`);
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

  /** LATENCY DOCTOR: a report on the recorded events (or why there is nothing to report). */
  static latencyDoctor(ctx: CommandContext): Reply {
    if (ctx.server.config.num('latency-monitor-threshold') === 0) return new RespVerbatim(ServerMessages.LATENCY_DOCTOR_DISABLED);
    const events = [...ctx.server.observer.latencyEvents];
    if (!events.length) return new RespVerbatim(ServerMessages.LATENCY_DOCTOR_OK);
    let report = ServerMessages.LATENCY_DOCTOR_SPIKES;
    events.forEach(([event, e], i) => {
      const values = e.samples.map(([, ms]) => ms);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const mad = values.reduce((a, b) => a + Math.abs(b - avg), 0) / values.length;
      const span = e.samples[e.samples.length - 1][0] - e.samples[0][0];
      const period = Math.max(1, span) / Math.max(1, values.length - 1);
      report += formatMessage(ServerMessages.LATENCY_DOCTOR_EVENT, {
        n: i + 1, event, count: values.length, avg: Math.floor(avg), mad: Math.floor(mad), period: period.toFixed(2), max: e.max,
      });
    });
    report += ServerMessages.LATENCY_DOCTOR_ADVICE;
    const usec = ctx.server.config.num('latency-monitor-threshold') * 1000;
    if (ctx.server.config.num('slowlog-log-slower-than') > usec) report += formatMessage(ServerMessages.LATENCY_ADVICE_SLOWLOG_THRESHOLD, { usec });
    report += ServerMessages.LATENCY_ADVICE_SLOWLOG + ServerMessages.LATENCY_ADVICE_BIG_OBJECTS;
    return new RespVerbatim(report);
  }

  static latencyHelp(): Reply {
    return CommandService.helpReply('latency');
  }
}
