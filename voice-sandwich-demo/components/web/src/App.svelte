<script lang="ts">
  import { onMount } from "svelte";
  import {
    Header,
    Controls,
    PipelineCard,
    CartPanel,
    ActivityFeed,
    Console,
    VoiceExperience,
    KitchenDisplay,
  } from "./lib/components";
  import { createVoiceSession } from "./lib/websocket";

  const voiceSession = createVoiceSession();

  type AppRoute = "voice" | "dev" | "kitchen";

  function resolveRoute(): AppRoute {
    if (typeof window === "undefined") return "voice";
    const path = window.location.pathname.replace(/\/$/, "");
    if (path === "/kitchen" || path.endsWith("/kitchen")) return "kitchen";
    if (window.location.hash === "#/dev") return "dev";
    return "voice";
  }

  let route = $state<AppRoute>("voice");

  onMount(() => {
    const sync = (): void => {
      route = resolveRoute();
    };
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  });
</script>

{#if route === "kitchen"}
  <KitchenDisplay />
{:else if route === "dev"}
  <div class="max-w-3xl mx-auto px-4 py-8">
    <Header />
    <Controls
      onStart={() => voiceSession.start()}
      onStop={() => voiceSession.stop()}
    />
    <CartPanel />
    <PipelineCard />
    <ActivityFeed />
    <Console />
    <p class="mt-8 text-center text-sm flex justify-center gap-4">
      <a
        class="text-gray-500 underline decoration-gray-300 underline-offset-2 hover:text-gray-800"
        href="/"
      >
        ← Voice experience
      </a>
      <a
        class="text-gray-500 underline decoration-gray-300 underline-offset-2 hover:text-gray-800"
        href="/kitchen"
      >
        Cocina →
      </a>
    </p>
  </div>
{:else}
  <VoiceExperience
    onStart={() => voiceSession.start()}
    onStop={() => voiceSession.stop()}
  />
{/if}
