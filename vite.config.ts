import { defineConfig } from "vite";
import { resolve, join } from "node:path";
import { createReadStream, existsSync } from "node:fs";

/** Só em dev: serve a pasta local de sprites em /__sprites (prévia de animação). */
const localSprites = {
  name: "digitama-local-sprites",
  configureServer(server: any) {
    const root = join(process.env.APPDATA ?? "", "br.com.mastersys.digitama", "sprites");
    server.middlewares.use((req: any, res: any, next: any) => {
      const m = /^\/__sprites\/([a-z]+)\/([a-z]+)\.png/.exec(req.url ?? "");
      if (!m) return next();
      const file = join(root, m[1], `${m[2]}.png`);
      if (!existsSync(file)) return next();
      res.setHeader("Content-Type", "image/png");
      createReadStream(file).pipe(res);
    });
  },
};

export default defineConfig({
  plugins: [localSprites],
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
