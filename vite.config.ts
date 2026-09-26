import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // The new worker takes over at once (skipWaiting + clientsClaim). src/app/serviceWorker.ts
      // registers it through virtual:pwa-register, which then reloads the page onto the new build
      // (D-133); with that import present, injectRegister 'auto' adds no registerSW.js.
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Club EPOS',
        short_name: 'Club EPOS',
        description: 'Golf-club bar till (learning build)',
        lang: 'en-GB',
        theme_color: '#14532d',
        background_color: '#0b1f14',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        // 'any' icons have transparent corners; the maskable one is green to every edge with the
        // glyph inside the central safe zone.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
});
