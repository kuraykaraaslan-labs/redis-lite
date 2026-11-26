import MemoryService, { MemoryTracker } from '@/modules/memory/memory.service';
import type { MemoryReport } from '@/modules/memory/memory.types';

import type { RedisLiteServer } from './server.core';

/** The server's used-memory model: incremental per-key accounting, Redis-style overheads and the memory peak. */
export class ServerMemoryModel {
  /** Incremental used-memory accounting. */
  readonly tracker: MemoryTracker;
  /** Standalone Redis allocates a db's dicts on first use and keeps them (MEMORY STATS db.N). */
  private readonly dbAllocated: boolean[];

  constructor(private readonly server: RedisLiteServer) {
    this.tracker = new MemoryTracker(server.databases, server.config);
    this.dbAllocated = server.databases.map(() => false);
  }

  /** A key was written in database `dbIndex`: its dicts exist from now on. */
  markAllocated(dbIndex: number): void {
    this.dbAllocated[dbIndex] = true;
  }

  /** used_memory and friends (getMemoryOverheadData over the whole dataset); also tracks used_memory_peak. */
  memoryReport(): MemoryReport {
    const server = this.server;
    const databases = this.tracker.snapshots((id, keys) => {
      if (keys) this.dbAllocated[id] = true;
      return this.dbAllocated[id];
    });
    let report = MemoryService.computeMemory({
      databases,
      clientsNormal: (server.clients.size - (server.replication?.replicas.size ?? 0)) * MemoryService.clientMemory(),
      clientsSlaves: (server.replication?.replicas.size ?? 0) * MemoryService.clientMemory(),
      replicationBacklog: server.replication?.backlog?.size ?? 0,
      sizes: {
        listMaxListpackSize: server.config.num('list-max-listpack-size'),
        streamNodeMaxEntries: server.config.num('stream-node-max-entries'),
        streamNodeMaxBytes: server.config.num('stream-node-max-bytes'),
      },
    });
    if (report.usedMemory > server.memoryPeak) {
      server.memoryPeak = report.usedMemory;
      server.memoryPeakTime = Math.floor(Date.now() / 1000);
    }
    // the report's own peak is max(previous peak, used) at computation time; refresh it with the tracked peak
    if (report.peak !== server.memoryPeak) {
      report = { ...report, peak: server.memoryPeak, peakPercentage: Math.fround((report.usedMemory * 100) / server.memoryPeak) };
    }
    return report;
  }

  /** used_memory as maxmemory sees it. */
  usedMemoryForEviction(): number {
    return MemoryService.memoryForEviction(this.memoryReport());
  }
}
