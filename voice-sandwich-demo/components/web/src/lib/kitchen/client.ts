import type { KitchenOrder, KitchenOrderStatus, KitchenServerEvent } from "./types";

export function formatOrderTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const statusLabels: Record<KitchenOrderStatus, string> = {
  nuevo: "Nuevo",
  en_preparacion: "En preparación",
  listo: "Listo",
};

export const statusStyles: Record<KitchenOrderStatus, string> = {
  nuevo: "bg-amber-100 text-amber-900 border-amber-300",
  en_preparacion: "bg-blue-100 text-blue-900 border-blue-300",
  listo: "bg-emerald-100 text-emerald-900 border-emerald-300",
};

export function connectKitchen(
  onEvent: (event: KitchenServerEvent) => void,
  onStatus?: (connected: boolean) => void
): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/kitchen`);

  ws.onopen = () => onStatus?.(true);
  ws.onclose = () => onStatus?.(false);
  ws.onerror = () => onStatus?.(false);
  ws.onmessage = (msg) => {
    onEvent(JSON.parse(msg.data) as KitchenServerEvent);
  };

  return () => ws.close();
}

export async function patchOrderStatus(
  orderId: string,
  status: KitchenOrderStatus
): Promise<KitchenOrder> {
  const res = await fetch(`/api/kitchen/orders/${orderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    throw new Error("No se pudo actualizar el pedido");
  }
  return res.json() as Promise<KitchenOrder>;
}

export function mergeOrders(
  current: KitchenOrder[],
  event: KitchenServerEvent
): KitchenOrder[] {
  switch (event.type) {
    case "snapshot":
      return sortOrders(event.orders);
    case "order_new": {
      const without = current.filter((o) => o.id !== event.order.id);
      return sortOrders([event.order, ...without]);
    }
    case "order_updated": {
      const next = current.map((o) => (o.id === event.order.id ? event.order : o));
      if (!next.some((o) => o.id === event.order.id)) {
        next.unshift(event.order);
      }
      return sortOrders(next);
    }
    default:
      return current;
  }
}

function sortOrders(orders: KitchenOrder[]): KitchenOrder[] {
  return [...orders].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function playNewOrderSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // ignore if audio blocked
  }
}
