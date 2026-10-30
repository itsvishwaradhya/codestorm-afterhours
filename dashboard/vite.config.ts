import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const healer = process.env.HEALER_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    port: Number(process.env.DASHBOARD_PORT ?? 5173),
    proxy: {
      "/api": healer,
      "/socket.io": { target: healer, ws: true },
    },
  },
});
