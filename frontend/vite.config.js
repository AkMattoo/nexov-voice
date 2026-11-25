import { defineConfig } from "vite";

// In dev, proxy API + WebRTC signalling to the Python server.
export default defineConfig({
  server: { port: 5173, proxy: { "/api": "http://localhost:7860" } },
});
