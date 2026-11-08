import './theme-tokens.css'
import './styles.css'
import './dispatch.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { App } from './App'
import { registerServiceWorker } from './lib/pwa'
import { followSystemTheme } from './lib/theme'

followSystemTheme()
registerServiceWorker()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
