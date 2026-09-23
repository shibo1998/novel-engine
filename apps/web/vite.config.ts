import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5319,
    // Windows 上 vite 默认绑 localhost（仅 IPv6 ::1），curl/浏览器走 IPv4 127.0.0.1 会被拒——钉死 IPv4
    host: '127.0.0.1',
    proxy: {
      // web 只调 server，不 import core——与 CLI 共享同一内核，防双轨漂移
      '/api': {
        target: 'http://127.0.0.1:4319',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
