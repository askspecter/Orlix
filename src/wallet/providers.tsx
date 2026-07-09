import type { ReactNode } from 'react'
import { PrivyProvider } from '@privy-io/react-auth'
import { base } from 'viem/chains'

export function Providers({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId="cmqh5fvyg00co0ci68birz0s2"
      config={{
        loginMethods: ['wallet'],
        appearance: {
          theme: 'dark',
          accentColor: '#F07830',
          logo: 'https://orlixai.xyz/orlix-logo.jpeg',
          landingHeader: 'Connect your wallet',
          loginMessage: 'Connect a wallet to continue',
        },
        defaultChain: base,
        supportedChains: [base],
        embeddedWallets: {
          createOnLogin: 'off',
        },
      }}
    >
      {children}
    </PrivyProvider>
  )
}
