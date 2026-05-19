export type KitchenOrderStatus = "nuevo" | "en_preparacion" | "listo";

export interface OrderLine {
  item: string;
  quantity: number;
}

export interface KitchenOrder {
  id: string;
  shortId: string;
  sessionId: string;
  items: OrderLine[];
  summary: string;
  status: KitchenOrderStatus;
  createdAt: string;
}

export type KitchenServerEvent =
  | { type: "snapshot"; orders: KitchenOrder[] }
  | { type: "order_new"; order: KitchenOrder }
  | { type: "order_updated"; order: KitchenOrder };
