import type { DictTables, InfoMemoryExtras, MemoryReport, MemoryStatValue } from './memory.types';

/** How memory figures are shown: MEMORY STATS (reply order and value kinds) and the INFO memory section. */
export default class MemoryInfoService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** DICT_STATS_VECTLEN: chain lengths counted one by one up to this. */
  private static readonly STATS_VECTLEN = 50;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** One table's block of dictGetStats: sizes, then the chain lengths of `elements` spread at random. */
  private static tableStats(title: string, size: number, elements: number): string {
    if (!size || !elements) return `${title}\nNo stats available for empty dictionaries\n`;
    const chains = new Uint32Array(size);
    for (let i = 0; i < elements; i++) chains[Math.floor(Math.random() * size)]++;
    const vector = new Array<number>(MemoryInfoService.STATS_VECTLEN).fill(0);
    let slots = 0;
    let max = 0;
    for (const len of chains) {
      vector[Math.min(len, MemoryInfoService.STATS_VECTLEN - 1)]++;
      if (len) slots++;
      max = Math.max(max, len);
    }
    const avg = (elements / slots).toFixed(2);
    let out =
      `${title}\n table size: ${size}\n number of elements: ${elements}\n different slots: ${slots}\n max chain length: ${max}\n` +
      ` avg chain length (counted): ${avg}\n avg chain length (computed): ${avg}\n Chain length distribution:\n`;
    vector.forEach((n, len) => {
      if (n) out += `   ${len}: ${n} (${((n / size) * 100).toFixed(2)}%)\n`;
    });
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** bytesToHuman: B, then K/M/G/T/P/E with two decimals. */
  static bytesToHuman(n: number): string {
    if (n < 1024) return `${n}B`;
    const units = ['K', 'M', 'G', 'T', 'P', 'E'];
    let d = n / 1024;
    let i = 0;
    while (i < units.length - 1 && d >= 1024) {
      d /= 1024;
      i++;
    }
    return `${d.toFixed(2)}${units[i]}`;
  }

  /** DEBUG HTSTATS(-KEY) text of a dict: the main table, and the rehash target while rehashing. */
  static htStats(t: DictTables & { rehashed: number }, used: number): string {
    const S = MemoryInfoService;
    let out = S.tableStats('Hash table 0 stats (main hash table):', t.size0, used - t.rehashed);
    if (t.size1) out += S.tableStats('Hash table 1 stats (rehashing target):', t.size1, t.rehashed);
    return out;
  }

  /** MEMORY STATS, in Redis's reply order. */
  static memoryStats(r: MemoryReport): Array<[string, MemoryStatValue]> {
    const d = (v: number): { double: number } => ({ double: v });
    const out: Array<[string, MemoryStatValue]> = [
      ['peak.allocated', r.peak],
      ['total.allocated', r.usedMemory],
      ['startup.allocated', r.startup],
      ['replication.backlog', r.replicationBacklog],
      ['clients.slaves', r.clientsSlaves],
      ['clients.normal', r.clientsNormal],
      ['cluster.links', r.clusterLinks],
      ['aof.buffer', r.aofBuffer],
      ['lua.caches', r.luaCaches],
      ['functions.caches', r.functionsCaches],
    ];
    for (const db of r.dbs) {
      out.push([
        `db.${db.id}`,
        [
          ['overhead.hashtable.main', db.main],
          ['overhead.hashtable.expires', db.expiresOverhead],
          ['overhead.hashtable.slot-to-keys', 0],
        ],
      ]);
    }
    out.push(
      ['overhead.total', r.overheadTotal],
      ['keys.count', r.keysCount],
      ['keys.bytes-per-key', r.bytesPerKey],
      ['dataset.bytes', r.dataset],
      ['dataset.percentage', d(r.datasetPercentage)],
      ['peak.percentage', d(r.peakPercentage)],
      ['allocator.allocated', r.allocatorAllocated],
      ['allocator.active', r.allocatorActive],
      ['allocator.resident', r.allocatorResident],
      ['allocator-fragmentation.ratio', d(r.allocatorFragRatio)],
      ['allocator-fragmentation.bytes', r.allocatorFragBytes],
      ['allocator-rss.ratio', d(r.allocatorRssRatio)],
      ['allocator-rss.bytes', r.allocatorRssBytes],
      ['rss-overhead.ratio', d(r.rssOverheadRatio)],
      ['rss-overhead.bytes', r.rssOverheadBytes],
      ['fragmentation', d(r.fragmentation)],
      ['fragmentation.bytes', r.fragmentationBytes],
    );
    return out;
  }

  /** The INFO memory section (field, value) pairs in Redis order; values are rendered as Redis prints them. */
  static infoMemory(r: MemoryReport, x: InfoMemoryExtras = {}): Array<[string, string | number]> {
    const pct = (v: number): string => `${v.toFixed(2)}%`;
    const ratio = (v: number): string => v.toFixed(2);
    const luaVm = x.luaVmMemory ?? 31744;
    const fnVm = x.functionsVmMemory ?? 32768;
    const scripts = r.luaCaches + r.functionsCaches;
    const sys = x.totalSystemMemory ?? 0;
    const maxmemory = x.maxmemory ?? 0;
    return [
      ['used_memory', r.usedMemory],
      ['used_memory_human', MemoryInfoService.bytesToHuman(r.usedMemory)],
      ['used_memory_rss', r.rss],
      ['used_memory_rss_human', MemoryInfoService.bytesToHuman(r.rss)],
      ['used_memory_peak', r.peak],
      ['used_memory_peak_human', MemoryInfoService.bytesToHuman(r.peak)],
      ['used_memory_peak_perc', pct(r.peakPercentage)],
      ['used_memory_overhead', r.overheadTotal],
      ['used_memory_startup', r.startup],
      ['used_memory_dataset', r.dataset],
      ['used_memory_dataset_perc', pct(r.datasetPercentage)],
      ['allocator_allocated', r.allocatorAllocated],
      ['allocator_active', r.allocatorActive],
      ['allocator_resident', r.allocatorResident],
      ['total_system_memory', sys],
      ['total_system_memory_human', MemoryInfoService.bytesToHuman(sys)],
      ['used_memory_lua', luaVm],
      ['used_memory_vm_eval', luaVm],
      ['used_memory_lua_human', MemoryInfoService.bytesToHuman(luaVm)],
      ['used_memory_scripts_eval', r.luaCaches],
      ['number_of_cached_scripts', x.cachedScripts ?? 0],
      ['number_of_functions', x.functions ?? 0],
      ['number_of_libraries', x.libraries ?? 0],
      ['used_memory_vm_functions', fnVm],
      ['used_memory_vm_total', luaVm + fnVm],
      ['used_memory_vm_total_human', MemoryInfoService.bytesToHuman(luaVm + fnVm)],
      ['used_memory_functions', r.functionsCaches],
      ['used_memory_scripts', scripts],
      ['used_memory_scripts_human', MemoryInfoService.bytesToHuman(scripts)],
      ['maxmemory', maxmemory],
      ['maxmemory_human', MemoryInfoService.bytesToHuman(maxmemory)],
      ['maxmemory_policy', x.maxmemoryPolicy ?? 'noeviction'],
      ['allocator_frag_ratio', ratio(r.allocatorFragRatio)],
      ['allocator_frag_bytes', r.allocatorFragBytes],
      ['allocator_rss_ratio', ratio(r.allocatorRssRatio)],
      ['allocator_rss_bytes', r.allocatorRssBytes],
      ['rss_overhead_ratio', ratio(r.rssOverheadRatio)],
      ['rss_overhead_bytes', r.rssOverheadBytes],
      ['mem_fragmentation_ratio', ratio(r.fragmentation)],
      ['mem_fragmentation_bytes', r.fragmentationBytes],
      ['mem_not_counted_for_evict', r.notCountedForEvict],
      ['mem_replication_backlog', r.replicationBacklog],
      ['mem_total_replication_buffers', x.replicationBuffers ?? 0],
      ['mem_clients_slaves', r.clientsSlaves],
      ['mem_clients_normal', r.clientsNormal],
      ['mem_cluster_links', r.clusterLinks],
      ['mem_aof_buffer', r.aofBuffer],
      ['mem_allocator', x.allocator ?? 'jemalloc-5.3.0'],
      ['active_defrag_running', x.activeDefragRunning ?? 0],
      ['lazyfree_pending_objects', x.lazyfreePendingObjects ?? 0],
      ['lazyfreed_objects', x.lazyfreedObjects ?? 0],
    ];
  }
}
