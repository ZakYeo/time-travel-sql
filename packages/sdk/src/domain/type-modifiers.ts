import { HistoryError } from './errors.js';
import { decimalParts } from './decimal.js';
import type { ScalarType, ScalarValue } from './values.js';

function numericModifier(modifier: number): {
  precision: number;
  scale: number;
} {
  const encoded = modifier - 4;
  const precision = encoded >>> 16;
  const scaleBits = encoded & 2047;
  return { precision, scale: scaleBits >= 1024 ? scaleBits - 2048 : scaleBits };
}

export function validateTypeModifier(type: ScalarType, modifier: number): void {
  if (modifier === -1) return;
  if (type === 'varchar' && modifier >= 5 && modifier <= 10485764) return;
  if (
    (type === 'timestamp' || type === 'timestamptz') &&
    modifier >= 0 &&
    modifier <= 6
  )
    return;
  if (type === 'numeric' && modifier >= 4) {
    const { precision, scale } = numericModifier(modifier);
    if (
      precision >= 1 &&
      precision <= 1000 &&
      scale >= -1000 &&
      scale <= 1000 &&
      ((modifier - 4) & 63488) === 0
    )
      return;
  }
  throw new HistoryError(
    'INVALID_SCHEMA',
    'Unsupported or invalid scalar type modifier.',
  );
}

export function validateModifiedValue(
  value: ScalarValue,
  modifier: number,
): void {
  if (modifier === -1) return;
  if (value.type === 'varchar' && [...value.value].length > modifier - 4)
    throw new HistoryError(
      'INVALID_VALUE',
      'Text exceeds the declared character limit.',
    );
  if (value.type === 'timestamp' || value.type === 'timestamptz') {
    const fraction = value.value.split('.')[1]?.replace('Z', '') ?? '';
    if (/[^0]/.test(fraction.slice(modifier)))
      throw new HistoryError(
        'INVALID_VALUE',
        'Timestamp would round under its declared precision.',
      );
  }
  if (value.type === 'numeric') {
    const parts = decimalParts(value.value);
    if (parts.coefficient === '0') return;
    const { precision, scale } = numericModifier(modifier);
    const power = parts.power + BigInt(scale);
    if (
      power < 0n ||
      BigInt(parts.coefficient.length) + power > BigInt(precision)
    )
      throw new HistoryError(
        'INVALID_VALUE',
        'Numeric would round or overflow its declared precision/scale.',
      );
  }
}
