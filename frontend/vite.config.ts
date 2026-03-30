import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, '..');
  const env = loadEnv(mode, repoRoot, '');
  const proxyPort = env.BINANCE_PROXY_PORT || '8787';
  const pythonPlatformPort = env.PY_PLATFORM_PORT || '8800';

  return {
    root: __dirname,
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: [
          '**/backend/python/data/**',
          '**/backend/python/strategy_store/**',
          '**/backend/python/__pycache__/**',
        ],
      },
      proxy: {
        '/api/binance': {
          target: `http://127.0.0.1:${proxyPort}`,
          changeOrigin: true,
        },
        '/api/platform': {
          target: `http://127.0.0.1:${pythonPlatformPort}`,
          changeOrigin: true,
        },
        '/research': {
          target: `http://127.0.0.1:${pythonPlatformPort}`,
          changeOrigin: true,
        },
        '/portfolio': {
          target: `http://127.0.0.1:${pythonPlatformPort}`,
          changeOrigin: true,
        },
        '/governance': {
          target: `http://127.0.0.1:${pythonPlatformPort}`,
          changeOrigin: true,
        },
        '/ws/binance': {
          target: `http://127.0.0.1:${proxyPort}`,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, 'build'),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;

            if (id.includes('lightweight-charts')) {
              return 'vendor-charts';
            }

            if (id.includes('recharts')) {
              return 'vendor-recharts';
            }

            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }

            return 'vendor';
          },
        },
      },
    },
  };
});
