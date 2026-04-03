export {};

declare global {
  interface FreeGift {
    enabled: boolean;
    threshold: number;
    variantId: string;
  }
}