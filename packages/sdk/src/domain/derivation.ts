import { HistoryError } from './errors.js';
import { objectFields, boundedArray } from './validation.js';

export const DERIVED_CAPABILITIES = Object.freeze([
  'committed-replay',
  'row-history',
  'available-column-sql',
] as const);

export interface RecordingDerivation {
  readonly kind: 'column-policy';
  readonly parentConfigurationFingerprint: string;
  readonly capabilities: typeof DERIVED_CAPABILITIES;
  readonly liveResume: false;
}

export function decodeRecordingDerivation(input: unknown): RecordingDerivation {
  const data = objectFields(input, [
    'kind',
    'parentConfigurationFingerprint',
    'capabilities',
    'liveResume',
  ]);
  const capabilities = boundedArray(
    data.capabilities,
    DERIVED_CAPABILITIES.length,
  );
  if (
    data.kind !== 'column-policy' ||
    typeof data.parentConfigurationFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.parentConfigurationFingerprint) ||
    capabilities.length !== DERIVED_CAPABILITIES.length ||
    capabilities.some(
      (value, index) => value !== DERIVED_CAPABILITIES[index],
    ) ||
    data.liveResume !== false
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid derived recording capabilities.',
    );
  return Object.freeze({
    kind: 'column-policy',
    parentConfigurationFingerprint: data.parentConfigurationFingerprint,
    capabilities: DERIVED_CAPABILITIES,
    liveResume: false,
  });
}
