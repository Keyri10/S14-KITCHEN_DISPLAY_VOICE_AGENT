import type { KitchenOrder, KitchenServerEvent } from "./types";
import { listActiveKitchenOrders } from "./store";

export interface KitchenSocket {
  send(data: string): void;
  readonly readyState: number;
}

class KitchenHub {
  private clients = new Set<KitchenSocket>();

  add(client: KitchenSocket): void {
    this.clients.add(client);
    this.send(client, {
      type: "snapshot",
      orders: listActiveKitchenOrders(),
    });
  }

  remove(client: KitchenSocket): void {
    this.clients.delete(client);
  }

  broadcast(event: KitchenServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  notifyNewOrder(order: KitchenOrder): void {
    this.broadcast({ type: "order_new", order });
  }

  notifyOrderUpdated(order: KitchenOrder): void {
    this.broadcast({ type: "order_updated", order });
  }

  private send(client: KitchenSocket, event: KitchenServerEvent): void {
    if (client.readyState === 1) {
      client.send(JSON.stringify(event));
    }
  }
}

export const kitchenHub = new KitchenHub();
