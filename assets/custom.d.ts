export {};

declare global {
  interface Theme {
    freeGift: {
      enabled: boolean;
      threshold: number;
      variantId: string;
    }
  }
}