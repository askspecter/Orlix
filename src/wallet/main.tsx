import React from 'react'
import ReactDOM from 'react-dom/client'
import { SpeedInsights } from '@vercel/speed-insights/react'

import './widget.css'

import { Providers } from './providers'
import { WalletWidget } from './WalletWidget'

type Unmount = () => void

// Mount the WalletWidget into any element matching the given CSS selector.
// Returns an unmount function, or undefined if the element isn't found.
function mount(selector = '#orlix-wallet'): Unmount | undefined {
  const container = document.querySelector<HTMLElement>(selector)
  if (!container) return undefined

  const root = ReactDOM.createRoot(container)

  root.render(
    <React.StrictMode>
      <Providers>
        <WalletWidget />
        <SpeedInsights />
      </Providers>
    </React.StrictMode>
  )

  return () => root.unmount()
}

// Auto-mount on DOMContentLoaded so the script can be placed anywhere
// in the HTML (including before the #orlix-wallet element)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount())
} else {
  mount()
}

// Expose a global API for manual / programmatic mounting
declare global {
  interface Window {
    OrlixWallet: {
      // mount('#my-custom-container') → returns unmount fn
      mount: typeof mount
    }
  }
}

window.OrlixWallet = { mount }
