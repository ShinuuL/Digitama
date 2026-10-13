import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: "127.0.0.1",
    // O Cargo trava arquivos em target/ enquanto o Vite sobe (EBUSY no Windows).
    watch: { ignored: ["**/target/**", "**/src-tauri/**", "**/hook/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pet: resolve(__dirname, "index.html"),
        chat: resolve(__dirname, "chat.html"),
        settings: resolve(__dirname, "settings.html"),
        snip: resolve(__dirname, "snip.html"),
      },
    },
  },
});
