/** Host-private rolling-window buckets. Keys come only from the accepted socket peer. */
export class BoundedIpLimiter {
  private readonly peers = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000, private readonly maxPeers = 512) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(windowMs) || windowMs <= 0
      || !Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > 512) throw new RangeError("invalid bounded rate limit");
  }
  take(peer: string | undefined, now = Date.now()): boolean {
    for (const [key, hits] of this.peers) {
      while (hits.length && now - hits[0]! >= this.windowMs) hits.shift();
      if (!hits.length) this.peers.delete(key);
    }
    const key = peer ?? "unknown-socket-peer";
    let hits = this.peers.get(key);
    if (!hits) {
      if (this.peers.size >= this.maxPeers) {
        // 审查 P2：表满时此前无条件拒绝**所有新来源**——一个扫描全网段的
        // 攻击者即可让正常客户端全部 429（管理面 DoS）。改为淘汰最久未活动
        // 的桶（LRU），新来源仍可获得自己的预算。
        let oldestKey: string | undefined;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [candidate, candidateHits] of this.peers) {
          const last = candidateHits[candidateHits.length - 1] ?? 0;
          if (last < oldestAt) {
            oldestAt = last;
            oldestKey = candidate;
          }
        }
        if (oldestKey !== undefined) this.peers.delete(oldestKey);
      }
      hits = [];
      this.peers.set(key, hits);
    }
    if (hits.length >= this.limit) return false;
    hits.push(now);
    return true;
  }
  get size(): number { return this.peers.size; }
}
