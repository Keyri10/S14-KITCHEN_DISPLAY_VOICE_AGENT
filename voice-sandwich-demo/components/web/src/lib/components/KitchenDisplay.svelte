<script lang="ts">
  import { onMount } from "svelte";
  import type { KitchenOrder, KitchenOrderStatus } from "../kitchen/types";
  import {
    connectKitchen,
    formatOrderTime,
    mergeOrders,
    patchOrderStatus,
    playNewOrderSound,
    statusLabels,
    statusStyles,
  } from "../kitchen/client";

  let orders = $state<KitchenOrder[]>([]);
  let connected = $state(false);
  let showCompleted = $state(false);

  const visibleOrders = $derived(
    showCompleted ? orders : orders.filter((o) => o.status !== "listo")
  );

  const columns: { key: KitchenOrderStatus; title: string }[] = [
    { key: "nuevo", title: "Nuevos" },
    { key: "en_preparacion", title: "En preparación" },
    { key: "listo", title: "Listos" },
  ];

  onMount(() => {
    return connectKitchen(
      (event) => {
        if (event.type === "order_new") {
          playNewOrderSound();
        }
        orders = mergeOrders(orders, event);
      },
      (isConnected) => {
        connected = isConnected;
      }
    );
  });

  async function setStatus(order: KitchenOrder, status: KitchenOrderStatus): Promise<void> {
    if (order.status === status) return;
    try {
      const updated = await patchOrderStatus(order.id, status);
      orders = orders.map((o) => (o.id === updated.id ? updated : o));
    } catch (err) {
      console.error(err);
    }
  }

  function ordersInColumn(status: KitchenOrderStatus): KitchenOrder[] {
    return visibleOrders.filter((o) => o.status === status);
  }
</script>

<div class="min-h-screen bg-stone-900 text-stone-100">
  <header
    class="sticky top-0 z-10 border-b border-stone-700 bg-stone-900/95 backdrop-blur px-6 py-4 flex items-center justify-between"
  >
    <div>
      <h1 class="text-2xl font-bold tracking-tight">🍳 Cocina</h1>
      <p class="text-sm text-stone-400">Pedidos en tiempo real</p>
    </div>
    <div class="flex items-center gap-4 text-sm">
      <label class="flex items-center gap-2 text-stone-300 cursor-pointer">
        <input type="checkbox" bind:checked={showCompleted} class="rounded" />
        Mostrar listos
      </label>
      <span
        class="inline-flex items-center gap-2 px-3 py-1 rounded-full border {connected
          ? 'border-emerald-500/50 text-emerald-400'
          : 'border-red-500/50 text-red-400'}"
      >
        <span
          class="w-2 h-2 rounded-full {connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}"
        ></span>
        {connected ? "Conectado" : "Desconectado"}
      </span>
      <a href="/" class="text-stone-400 hover:text-white underline underline-offset-2">Voz</a>
    </div>
  </header>

  <main class="p-6">
    {#if visibleOrders.length === 0}
      <div
        class="rounded-2xl border border-dashed border-stone-600 p-16 text-center text-stone-400"
      >
        <p class="text-lg">Esperando pedidos…</p>
        <p class="text-sm mt-2">Confirma un pedido desde la experiencia de voz.</p>
      </div>
    {:else}
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {#each columns as col (col.key)}
          <section class="flex flex-col min-h-[420px]">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-stone-400 mb-3">
              {col.title}
              <span class="ml-2 text-stone-500">({ordersInColumn(col.key).length})</span>
            </h2>
            <div class="flex flex-col gap-3 flex-1">
              {#each ordersInColumn(col.key) as order (order.id)}
                <article
                  class="rounded-xl border border-stone-700 bg-stone-800 p-4 shadow-lg animate-in"
                >
                  <div class="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <p class="font-mono text-lg font-bold text-amber-400">#{order.shortId}</p>
                      <p class="text-xs text-stone-400">{formatOrderTime(order.createdAt)}</p>
                    </div>
                    <span
                      class="text-[10px] font-semibold uppercase px-2 py-1 rounded border {statusStyles[
                        order.status
                      ]}"
                    >
                      {statusLabels[order.status]}
                    </span>
                  </div>

                  <p class="text-sm text-stone-300 mb-3 leading-relaxed">{order.summary}</p>

                  <ul class="space-y-1.5 mb-4">
                    {#each order.items as line}
                      <li
                        class="flex justify-between text-sm bg-stone-900/60 rounded-lg px-3 py-2"
                      >
                        <span class="capitalize">{line.item}</span>
                        <span class="font-mono text-amber-300">×{line.quantity}</span>
                      </li>
                    {/each}
                  </ul>

                  <div class="flex flex-wrap gap-2">
                    {#if order.status === "nuevo"}
                      <button
                        type="button"
                        onclick={() => setStatus(order, "en_preparacion")}
                        class="flex-1 text-xs font-medium py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors"
                      >
                        Preparar
                      </button>
                    {/if}
                    {#if order.status === "en_preparacion"}
                      <button
                        type="button"
                        onclick={() => setStatus(order, "listo")}
                        class="flex-1 text-xs font-medium py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 transition-colors"
                      >
                        Marcar listo
                      </button>
                    {/if}
                    {#if order.status === "nuevo"}
                      <button
                        type="button"
                        onclick={() => setStatus(order, "listo")}
                        class="text-xs py-2 px-3 rounded-lg border border-stone-600 hover:bg-stone-700 transition-colors"
                      >
                        Listo directo
                      </button>
                    {/if}
                  </div>
                </article>
              {:else}
                <p class="text-sm text-stone-500 text-center py-8 border border-dashed border-stone-700 rounded-xl">
                  Sin pedidos
                </p>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </main>
</div>

<style>
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .animate-in {
    animation: fadeIn 0.35s ease-out;
  }
</style>
