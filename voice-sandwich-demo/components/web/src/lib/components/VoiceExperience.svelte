<script lang="ts">
  import { session, formattedTime, currentTurn } from "../stores";

  interface Props {
    onStart: () => void;
    onStop: () => void;
  }

  let { onStart, onStop }: Props = $props();

  const statusLabels: Record<string, string> = {
    ready: "Tap to start ordering",
    connecting: "Connecting…",
    listening: "Listening — speak your order",
    error: "Something went wrong",
    disconnected: "Session ended",
  };

  let statusText = $derived(statusLabels[$session.status] ?? $session.status);
  let isActive = $derived($session.connected);
</script>

<div
  class="min-h-screen bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col"
>
  <header class="flex items-center justify-between px-6 py-5">
    <div class="flex items-center gap-3">
      <span class="text-3xl">🥪</span>
      <h1 class="text-xl font-semibold text-gray-900">Voice Sandwich</h1>
    </div>
    <div class="flex items-center gap-3 font-mono text-sm text-gray-400">
      {#if isActive}
        <span>{$formattedTime}</span>
      {/if}
      <a
        href="#/dev"
        class="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2"
        >Dev</a
      >
      <a
        href="/kitchen"
        class="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2"
        >Cocina</a
      >
    </div>
  </header>

  <main class="flex-1 flex flex-col items-center justify-center px-6 pb-16">
    <p class="text-sm text-gray-500 mb-8 text-center max-w-xs">{statusText}</p>

    <button
      type="button"
      onclick={isActive ? onStop : onStart}
      disabled={$session.status === "connecting"}
      class="relative w-36 h-36 rounded-full flex items-center justify-center transition-all duration-300
             {isActive
        ? 'bg-red-500 shadow-[0_0_40px_rgba(239,68,68,0.4)] hover:bg-red-600'
        : 'bg-gray-900 shadow-[0_0_40px_rgba(0,0,0,0.15)] hover:bg-gray-700 hover:scale-105'}
             disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
      aria-label={isActive ? "End session" : "Start session"}
    >
      {#if isActive}
        <span class="w-10 h-10 bg-white rounded-md"></span>
      {:else}
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          stroke-width="2"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg>
      {/if}
      {#if isActive}
        <span
          class="absolute inset-0 rounded-full border-4 border-red-300 animate-ping opacity-30"
        ></span>
      {/if}
    </button>

    <p class="mt-6 text-xs text-gray-400">
      {isActive ? "Tap to end session" : "Microphone required"}
    </p>

    {#if $currentTurn.transcript || $currentTurn.response}
      <div class="mt-10 w-full max-w-md space-y-3">
        {#if $currentTurn.transcript}
          <div class="p-4 bg-white/80 border border-gray-200 rounded-2xl text-sm">
            <span class="text-[10px] font-semibold uppercase text-cyan-600">You</span>
            <p class="mt-1 text-gray-800">{$currentTurn.transcript}</p>
          </div>
        {/if}
        {#if $currentTurn.response}
          <div class="p-4 bg-white/80 border border-gray-200 rounded-2xl text-sm">
            <span class="text-[10px] font-semibold uppercase text-purple-600"
              >Assistant</span
            >
            <p class="mt-1 text-gray-800">{$currentTurn.response}</p>
          </div>
        {/if}
      </div>
    {/if}
  </main>
</div>
