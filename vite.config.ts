import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const proxyPort = env.BINANCE_PROXY_PORT || '8787';
  const pythonPlatformPort = env.PY_PLATFORM_PORT || '8800';
  const researchPort = env.RESEARCH_SERVICE_PORT || '8797';
  const portfolioPort = env.PORTFOLIO_SERVICE_PORT || '8798';
  const governancePort = env.GOVERNANCE_SERVICE_PORT || '8799';

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: [
          '**/python_services/data/**',
          '**/python_services/strategy_store/**',
          '**/python_services/__pycache__/**',
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
