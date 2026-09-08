export interface CheckoutRequest {
  readonly orderId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly requestId: string;
}
