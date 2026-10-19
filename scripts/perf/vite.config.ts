import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
// Production build of the real renderer behind the HTTP API stand-in, served by `vite preview`. CSS is not minified:
// the minifier dropped the unprefixed backdrop-filter, so pages measured without the blur the real build keeps.
export default defineConfig({ root: __dirname, base: './', plugins: [react()], build: { outDir: '/tmp/bettergit-perf/dist', emptyOutDir: true, target: 'chrome130', cssMinify: false }, preview: { port: 5793, strictPort: true } })
