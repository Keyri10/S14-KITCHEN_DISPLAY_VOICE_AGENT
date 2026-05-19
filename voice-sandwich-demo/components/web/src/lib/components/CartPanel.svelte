<script lang="ts">
  import { activities } from "../stores";

  interface CartLine {
    item: string;
    quantity: number;
  }

  let cart = $derived.by(() => {
    const lines: CartLine[] = [];
    for (const activity of $activities) {
      if (activity.type !== "tool" || !activity.args) continue;
      const item = activity.args.item;
      const quantity = activity.args.quantity;
      if (typeof item === "string" && typeof quantity === "number") {
        lines.push({ item, quantity });
      }
    }
    return lines;
  });
</script>

<div class="bg-white rounded-2xl p-6 mb-5 border border-gray-200">
  <div class="flex items-center justify-between mb-4">
    <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-500"
      >Your order</span
    >
    <span class="text-xs text-gray-400">{cart.length} item{cart.length === 1 ? "" : "s"}</span>
  </div>

  {#if cart.length === 0}
    <p class="text-sm text-gray-400 text-center py-4">
      Order items will appear here as you speak.
    </p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each cart as line, i (i)}
        <li
          class="flex items-center justify-between py-2.5 px-3.5 bg-amber-50 border border-amber-100 rounded-xl text-sm"
        >
          <span class="font-medium text-gray-900 capitalize">{line.item}</span>
          <span class="font-mono text-gray-500">×{line.quantity}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
