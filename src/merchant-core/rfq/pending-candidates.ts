/** Internal, process-local capability for the two RFQ pending commands. No wire API. */
export interface RfqPendingCandidates {
  release(args: { releaseId: string }): string;
  handoff(args: { handoffId: string; packetJson: string; packetDigest: string }): string;
}
const localPorts = new WeakSet<object>();
/** Called only by MerchantCommandLog's fixed-tool factory in trusted assembly. */
export function createLocalRfqPendingCandidates(port: RfqPendingCandidates): RfqPendingCandidates {
  const local = Object.freeze({ ...port });
  localPorts.add(local);
  return local;
}
export function isLocalRfqPendingCandidates(value: unknown): value is RfqPendingCandidates {
  return typeof value === "object" && value !== null && localPorts.has(value);
}
