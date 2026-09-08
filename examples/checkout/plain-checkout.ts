import type pg from 'pg';
import { emitPostgresContext } from '@time-travel-sql/source-postgres';
import type { CheckoutRequest } from './request.js';

/** Equivalent domain writes on the caller's explicitly owned transaction connection. */
export async function plainCheckout(
  transaction: pg.Client,
  request: CheckoutRequest,
) {
  await emitPostgresContext(transaction, {
    version: 1,
    operation: 'checkout.create',
    requestId: request.requestId,
  });
  const inventory = await transaction.query<{ unitPrice: number }>(
    'SELECT "unitPrice" FROM inventory WHERE sku=$1',
    [request.sku],
  );
  const price = inventory.rows[0]?.unitPrice;
  if (price === undefined) throw new Error('Missing inventory');
  await transaction.query('INSERT INTO orders (id,total) VALUES ($1,$2)', [
    request.orderId,
    price,
  ]);
  await transaction.query(
    'INSERT INTO line_items (id,"orderId",sku,quantity,"unitPrice") VALUES ($1,$2,$3,$4,$5)',
    [
      request.orderId + '-line',
      request.orderId,
      request.sku,
      request.quantity,
      price,
    ],
  );
  await transaction.query('UPDATE inventory SET stock=stock-$1 WHERE sku=$2', [
    request.quantity,
    request.sku,
  ]);
  return { id: request.orderId, total: price };
}
