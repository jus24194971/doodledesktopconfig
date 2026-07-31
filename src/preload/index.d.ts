import type { MeshRiderApi } from './index.js'

declare global {
  interface Window {
    api: MeshRiderApi
  }
}

export {}
