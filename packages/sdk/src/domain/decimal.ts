import { HistoryError } from './errors.js';

/** Exact equality key: coefficient and decimal exponent, never floating point. */
export function decimalParts(value: string): {
  negative: boolean;
  coefficient: string;
  power: bigint;
  scale: bigint;
} {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(
    value,
  );
  if (!match) throw new HistoryError('INVALID_VALUE', 'Invalid decimal.');
  const fraction = match[3] ?? '';
  const exponentText = (match[4] ?? '0').replace(/^([+-]?)0+/, '$1') || '0';
  if (exponentText.length > 8)
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Decimal exponent exceeds the supported bound.',
    );
  const exponent = BigInt(
    exponentText === '+' || exponentText === '-' ? '0' : exponentText,
  );
  if (exponent < -1000000n || exponent > 1000000n)
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Decimal exponent exceeds the supported bound.',
    );
  const digits = `${match[2]}${fraction}`.replace(/^0+/, '');
  const scale = BigInt(fraction.length) - exponent;
  if (!digits) return { negative: false, coefficient: '0', power: 0n, scale };
  const coefficient = digits.replace(/0+$/, '');
  const power =
    exponent -
    BigInt(fraction.length) +
    BigInt(digits.length - coefficient.length);
  return { negative: match[1] === '-', coefficient, power, scale };
}

export function validateNumeric(value: string): void {
  const parts = decimalParts(value);
  if (
    parts.scale > 16383n ||
    BigInt(parts.coefficient.length) + parts.power > 131072n
  )
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Number exceeds PostgreSQL numeric digit bounds.',
    );
}

export function decimalIdentity(value: string): string {
  const parts = decimalParts(value);
  return parts.coefficient === '0'
    ? '0'
    : `${parts.negative ? '-' : ''}${parts.coefficient}e${parts.power}`;
}
