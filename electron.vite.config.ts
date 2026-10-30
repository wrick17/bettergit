import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { prepareDevApp } from './scripts/dev-app'

const config = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react()],
  },
})

export default defineConfig(({ command }) => {
  if (command === 'serve' && process.platform === 'darwin' && !process.env.ELECTRON_EXEC_PATH) {
    process.env.ELECTRON_EXEC_PATH = prepareDevApp(process.cwd())
  }
  return config
})
