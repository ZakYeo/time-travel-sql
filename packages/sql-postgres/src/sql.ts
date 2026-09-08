import { HistoryError } from '@time-travel-sql/sdk';
import { quoteIdentifier } from './identifiers.js';

/** Immutable SQL for simple-protocol queries and inspectable setup scripts.
 * Interpolations must be constructed fragments; strings cannot become SQL syntax.
 * Ordinary data queries should continue to use driver-bound parameters.
 */
export class Sql {
  private constructor(readonly text: string) {
    Object.freeze(this);
  }

  static query(parts: TemplateStringsArray, ...values: readonly Sql[]): Sql {
    let text = parts[0] ?? '';
    for (const [index, value] of values.entries()) {
      if (!(value instanceof Sql))
        throw new HistoryError('INVALID_VALUE', 'Expected a SQL fragment.');
      text += value.text + (parts[index + 1] ?? '');
    }
    return new Sql(text);
  }

  static identifier(...names: readonly string[]): Sql {
    if (!names.length)
      throw new HistoryError('INVALID_SCHEMA', 'Expected a SQL identifier.');
    return new Sql(names.map(quoteIdentifier).join('.'));
  }

  static literal(value: string): Sql {
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      !value.isWellFormed()
    )
      throw new HistoryError('INVALID_VALUE', 'Expected valid SQL text.');
    return new Sql(
      `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`,
    );
  }

  static parameter(index: number): Sql {
    if (!Number.isSafeInteger(index) || index < 1 || index > 65535)
      throw new HistoryError(
        'INVALID_VALUE',
        'Expected a valid SQL parameter index.',
      );
    return new Sql(`$${index}`);
  }

  static integer(value: number): Sql {
    if (!Number.isSafeInteger(value))
      throw new HistoryError('INVALID_VALUE', 'Expected a safe SQL integer.');
    return new Sql(String(value));
  }

  static join(values: readonly Sql[], separator: Sql = Sql.query`, `): Sql {
    if (!values.length)
      throw new HistoryError('INVALID_VALUE', 'Expected a nonempty SQL list.');
    return values.reduce(
      (left, right) => Sql.query`${left}${separator}${right}`,
    );
  }
}
