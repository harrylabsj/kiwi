export function packRecord(
  value: unknown,
  expected: { name: string; version: string },
): {
  name: string;
  version: string;
  filename: string;
  integrity: string;
  size: number;
  unpackedSize: number;
  files: Array<{ path: string; size: number }>;
};
