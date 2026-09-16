/// <reference types="vite/client" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
// @ts-ignore — node URL polyfill for vite alias resolution
import { fileURLToPath, URL } from "url";

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    plugins: [
      react(),
      nodePolyfills({
        include: ["buffer"],
        globals: {
          Buffer: true,
        },
      }),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      target: "esnext",
    },
    define: {
      global: "window",
    },
    envPrefix: ["VITE_", "PUBLIC_"],
  };
});
