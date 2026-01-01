import { defineConfig } from 'vite';

export default defineConfig({
  base: '/hotwheels-id.js/', // 👈 REPLACE with your repo name
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
});
