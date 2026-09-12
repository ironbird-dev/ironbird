export type ReaderEvent = { type: 'connected' } | { type: 'disconnected' } | { type: 'cardPresented' } | { type: 'declined' };

export interface ReaderPort {
  collectPayment(amountCents: number): Promise<{ token: string }>;
  onEvent(listener: (event: ReaderEvent) => void): () => void;
}

export type ServerEvent =
  | { type: 'order.confirmed'; orderId: string; totalCents: number }
  | { type: 'payment.succeeded'; paymentId: string }
  | { type: 'payment.failed'; reason: string };

export interface ApiPort {
  submitPayment(input: { token: string; amountCents: number }): Promise<{ paymentId: string }>;
  onEvent(listener: (event: ServerEvent) => void): () => void;
}

export interface AnalyticsPort {
  track(name: string, properties?: Record<string, unknown>): void;
}
