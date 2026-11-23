import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@fontsource-variable/geist'
import './app.css'
import { sampleFolderId } from './fileDetailsPrototype.fixture'

if (import.meta.env.DEV && import.meta.env.MODE === 'file-details-prototype') {
  void import('./fileDetailsPrototype.css')
  if (location.pathname === '/' && !location.hash) history.replaceState(null, '', `#item=${sampleFolderId}`)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
