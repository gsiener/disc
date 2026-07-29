import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, so the build works both at a domain root and under a GitHub Pages
  // project path (/ultimate-threejs/) without hardcoding the repo name.
  base: './',
  server: { port: 5173, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
  // Shaders authored as .glsl are imported as raw strings.
  assetsInclude: ['**/*.glsl'],
});
