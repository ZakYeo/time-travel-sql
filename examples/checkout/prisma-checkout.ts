import type {
  PrismaClient,
  Prisma,
} from '../../artifacts/prisma/client/client.js';
import { emitPrismaContext } from '@time-travel-sql/integration-prisma';

import type { CheckoutRequest } from './request.js';

/** Deliberately faulty sample: total omits quantity, exposing a reproducible invariant violation. */
export async function prismaCheckout(
  client: PrismaClient,
  request: CheckoutRequest,
) {
  return client.$transaction(
    async (transaction: Prisma.TransactionClient) => {
      await emitPrismaContext(transaction, {
        version: 1,
        operation: 'checkout.create',
        requestId: request.requestId,
      });
      const inventory = await transaction.inventory.findUniqueOrThrow({
        where: { sku: request.sku },
      });
      const order = await transaction.order.create({
        data: {
          id: request.orderId,
          total: inventory.unitPrice,
          lines: {
            create: {
              id: request.orderId + '-line',
              sku: request.sku,
              quantity: request.quantity,
              unitPrice: inventory.unitPrice,
            },
          },
        },
        include: { lines: true },
      });
      await transaction.inventory.update({
        where: { sku: request.sku },
        data: { stock: { decrement: request.quantity } },
      });
      return order;
    },
    { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 },
  );
}
