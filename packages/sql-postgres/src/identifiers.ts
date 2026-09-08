import { HistoryError } from '@time-travel-sql/sdk';

export function quoteIdentifier(name: unknown): string {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\0') ||
    Buffer.byteLength(name, 'utf8') > 63 ||
    [...name].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0xd800 && code <= 0xdfff;
    })
  ) {
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Expected a nonempty PostgreSQL identifier of at most 63 bytes.',
    );
  }
  return `"${name.replaceAll('"', '""')}"`;
}
