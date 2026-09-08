import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  base: '/Millennium-UI/',
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 3001,
    strictPort: true,
  },
});
