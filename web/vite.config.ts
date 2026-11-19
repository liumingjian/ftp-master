import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // During `pnpm dev`, the API is the Go service started by `make run-backend`.
    proxy: { '/api': process.env.API_ORIGIN ?? 'http://localhost:8080' },
  },
})
