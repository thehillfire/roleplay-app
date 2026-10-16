import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync, createReadStream } from 'node:fs';
import { join } from 'node:path';

// The Don't Smile game's face model runs in the browser. Its WebAssembly files are served
// from our own origin (never a CDN), so the camera feature talks to nobody but Kindred.
const WASM_DIR = 'node_modules/@mediapipe/tasks-vision/wasm';
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'];
function mediapipeWasm() {
  return {
    name: 'mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe', (req, res, next) => {
        const file = WASM_FILES.find((f) => req.url === `/${f}`);
        if (!file) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        createReadStream(join(WASM_DIR, file)).pipe(res);
      });
    },
    writeBundle(options) {
      const out = join(options.dir, 'mediapipe');
      mkdirSync(out, { recursive: true });
      for (const f of WASM_FILES) copyFileSync(join(WASM_DIR, f), join(out, f));
    },
  };
}

export default defineConfig({
  root: 'client',
  plugins: [react(), mediapipeWasm()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000', '/ws': { target: 'ws://localhost:3000', ws: true } } },
});
