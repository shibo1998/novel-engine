import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5319,
    // Windows 上 vite 默认绑 localhost（仅 IPv6 ::1），curl/浏览器走 IPv4 127.0.0.1 会被拒——钉死 IPv4
    host: '127.0.0.1',
    /**
     * ⚠️ 这个 proxy 会制造一个假象（F20-3）：本地开发时你几乎从不直连 server，
     * 所有 /api 都是被 vite **从 127.0.0.1 转发**过去的，于是「只有本机能访问」看起来成立——
     * 但那是 vite 在这台机器上转发的结果，不是 server 自己只听了回环。
     * 曾经 server 的 listen 不传 host（= Node 默认听**全部网卡**），这个假象正好把它盖住。
     * 现在 server 侧已显式绑 127.0.0.1（见 apps/server/src/index.ts）；
     * 但以后要验「同网段能不能连上」，请直接用局域网 IP 访问 server 端口，
     * 不要拿本地面板的连通性当证据。
     */
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
