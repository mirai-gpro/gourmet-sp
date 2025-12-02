import { defineConfig } from 'astro/config';
import AstroPWA from '@vite-pwa/astro';

export default defineConfig({
  output: 'static',
  build: {
    assets: 'assets' // アセットの出力先
  },
  server: {
    port: 4321,
    host: true
  },
  vite: {
    envPrefix: 'PUBLIC_',
    build: {
      charset: 'utf8'
    }
  },
  integrations: [
    AstroPWA({
      registerType: 'autoUpdate',
      
      // ★重要: Vercelで確実に認識させるため、拡張子を .json に固定する
      manifestFilename: 'manifest.json',
      
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      
      // ★重要: マニフェストの中身はここに書く（publicにファイルを置かない）
      manifest: {
        name: 'Gourmet SP',
        short_name: 'Gourmet',
        description: '美味しいグルメを探すためのアプリ',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        
        // ★重要: スコープを明示する（Vercelのサブディレクトリ対策）
        scope: '/',
        start_url: '/',
        
        icons: [
          {
            src: 'pwa-192x192.png', // publicフォルダの画像を指定
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