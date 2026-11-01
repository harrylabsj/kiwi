/** Reserved namespace for cryptographic session ownership, not business identity. */
export const OPEN_INQUIRY_IDENTITY_PREFIX = "kiwi-inquiry-session-v1:";
export function isOpenInquiryIdentity(identity: string): boolean {
  return identity.startsWith(OPEN_INQUIRY_IDENTITY_PREFIX);
}
