import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
  // Shaders authored as .glsl are imported as raw strings.
  assetsInclude: ['**/*.glsl'],
});
