import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Split large, stable dependencies into their own chunks so they can
        // be cached independently of app code and across route chunks.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'motion-vendor': ['framer-motion'],
          firebase: [
            'firebase/app',
            'firebase/auth',
            'firebase/firestore',
            'firebase/functions',
            'firebase/storage',
            'firebase/messaging',
            'firebase/analytics',
            'firebase/app-check',
          ],
        },
      },
    },
    // Route chunks pull in leaflet/recharts on demand; the default 500 kB warning
    // is noise here, so raise it to keep build output readable.
    chunkSizeWarningLimit: 900,
  },
})
