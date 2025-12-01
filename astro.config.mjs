import { defineConfig } from 'astro/config';
import AstroPWA from '@vite-pwa/astro';

// https://astro.build/config
export default defineConfig({
  // Cloud Runで静的ファイルをホスティングする場合
  output: 'static',

  // ビルド設定
  build: {
    // アセットの出力先
    assets: 'assets'
  },

  // 開発サーバー設定
  server: {
    port: 4321,
    host: true
  },

  // Vite設定
  vite: {
    // 環境変数のプレフィックス
    envPrefix: 'PUBLIC_',
    // ビルド設定
    build: {
      // 文字エンコーディングを明示
      charset: 'utf8'
    }
  },

  // ▼▼▼ ここからPWAの設定を追加しました ▼▼▼
  integrations: [
    AstroPWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Gourmet SP',
        short_name: 'Gourmet',
        description: '美味しいグルメを探すためのアプリ',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        navigateFallback: '/404',
        globPatterns: ['**/*.{css,js,html,svg,png,ico,txt}']
      }
    })
  ]
});