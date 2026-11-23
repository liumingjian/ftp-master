import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileDetailsPrototype } from './scripts/file-details-prototype'

export default defineConfig(({ mode, command }) => ({
  plugins: [react(), command === 'serve' && mode === 'file-details-prototype' && fileDetailsPrototype()],
  server: {
    // During `pnpm dev`, the API is the Go service started by `make run-backend`.
    proxy: { '/api': process.env.API_ORIGIN ?? 'http://localhost:8080' },
  },
}))
