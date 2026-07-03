import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { installWebApi } from './web-api'
import App from './App.tsx'

// Electron preload 대체: window.electronAPI 를 fetch+WS 어댑터로 설치
installWebApi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
