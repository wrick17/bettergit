/// <reference types="vite/client" />
import type { BetterGitApi } from '../../preload'

declare global {
  interface Window {
    bettergit: BetterGitApi
  }
}
