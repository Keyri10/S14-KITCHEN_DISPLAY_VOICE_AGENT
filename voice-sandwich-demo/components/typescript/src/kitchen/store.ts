import { v4 as uuidv4 } from "uuid";
import type { KitchenOrder, KitchenOrderStatus, OrderLine } from "./types";

const carts = new Map<string, OrderLine[]>();
const orders = new Map<string, KitchenOrder>();

let activeVoiceSessionId: string | null = null;

export function setActiveVoiceSessionId(sessionId: string | null): void {
  activeVoiceSessionId = sessionId;
}

export function getActiveVoiceSessionId(): string | null {
  return activeVoiceSessionId;
}

export function addToCart(sessionId: string, item: string, quantity: number): void {
  const lines = carts.get(sessionId) ?? [];
  const key = item.trim().toLowerCase();
  const existing = lines.find((l) => l.item.toLowerCase() === key);
  if (existing) {
    existing.quantity += quantity;
  } else {
    lines.push({ item: item.trim(), quantity });
  }
  carts.set(sessionId, lines);
}

export function getCart(sessionId: string): OrderLine[] {
  return [...(carts.get(sessionId) ?? [])];
}

export function confirmOrder(
  sessionId: string,
  orderSummary: string
): KitchenOrder | null {
  const items = getCart(sessionId);
  if (items.length === 0 && !orderSummary.trim()) {
    return null;
  }

  const id = uuidv4();
  const order: KitchenOrder = {
    id,
    shortId: id.slice(0, 8).toUpperCase(),
    sessionId,
    items: items.length > 0 ? items : [{ item: orderSummary.trim(), quantity: 1 }],
    summary: orderSummary.trim() || items.map((l) => `${l.quantity}x ${l.item}`).join(", "),
    status: "nuevo",
    createdAt: new Date().toISOString(),
  };

  orders.set(id, order);
  carts.delete(sessionId);
  return order;
}

export function listKitchenOrders(): KitchenOrder[] {
  return [...orders.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function listActiveKitchenOrders(): KitchenOrder[] {
  return listKitchenOrders().filter((o) => o.status !== "listo");
}

export function updateOrderStatus(
  orderId: string,
  status: KitchenOrderStatus
): KitchenOrder | null {
  const order = orders.get(orderId);
  if (!order) return null;
  order.status = status;
  orders.set(orderId, order);
  return order;
}

export function getOrder(orderId: string): KitchenOrder | undefined {
  return orders.get(orderId);
}
