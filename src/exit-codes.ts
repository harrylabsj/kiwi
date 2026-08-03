/**
 * Exit codes (design §12.4).
 */
export const EXIT = {
  OK: 0,
  CONFIG: 2,
  AUTH: 3,
  MODEL: 4,
  HUMAN: 5,
  TRANSIENT: 10,
} as const;
