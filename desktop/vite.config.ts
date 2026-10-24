import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  // Signing credentials must never be exposed through import.meta.env.
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ["react-markdown"],
          primitives: ["radix-ui"],
        },
      },
    },
  },
});
