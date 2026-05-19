import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  appType: "spa",
  plugins: [svelte(), tailwindcss()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
      "/ws/kitchen": {
        target: "ws://localhost:8000",
        ws: true,
      },
      "/api/kitchen": {
        target: "http://localhost:8000",
      },
    },
  },
});
