import { decodePosition, HistoryError } from '@time-travel-sql/sdk';
import type { Position } from '@time-travel-sql/sdk';

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

export function validateSlotName(name: unknown): string {
  if (typeof name !== 'string' || !/^tts_[a-z0-9_]{1,59}$/.test(name)) {
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Owned slot names must start with tts_ and contain at most 63 lowercase letters, digits or underscores.',
    );
  }
  return name;
}

export function decodeLsn(input: unknown): Position {
  if (
    typeof input !== 'string' ||
    !/^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/.test(input)
  ) {
    throw new HistoryError(
      'INVALID_POSITION',
      'Invalid PostgreSQL WAL position.',
    );
  }
  const [high, low] = input.split('/');
  return decodePosition(
    ((BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`)).toString(),
  );
}

export function encodeLsn(position: Position): string {
  const value = BigInt(decodePosition(position));
  if (value > 0xffffffffffffffffn)
    throw new HistoryError(
      'INVALID_POSITION',
      'PostgreSQL WAL position exceeds 64 bits.',
    );
  return `${(value >> 32n).toString(16).toUpperCase()}/${(value & 0xffffffffn).toString(16).toUpperCase()}`;
}
