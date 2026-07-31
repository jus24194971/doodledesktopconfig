import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

async function boot(): Promise<void> {
  // Outside Electron there is no preload bridge, so fall back to the demo dataset. This lets the
  // interface be developed in a plain browser without any radios attached.
  if (!window.api) {
    const { installMockApi } = await import('./mockApi')
    installMockApi()
  }

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void boot()
