import { useEffect, useState } from 'react'
import { apiGet } from './api'
import Onboarding from './components/Onboarding'
import MainLayout from './components/MainLayout'
import type { AppScreen, StatusData } from './types'

export default function App() {
  const [screen, setScreen] = useState<AppScreen | null>(null)
  const [status, setStatus] = useState<StatusData | null>(null)

  useEffect(() => {
    // Use the IPC bridge (apiGet) so the request goes through Electron's
    // main process — avoids CSP restrictions on direct fetch() calls.
    apiGet<{ total_workspaces: number }>('/global/status')
      .then((s) => {
        setStatus(null)
        if (s.total_workspaces > 0) {
          setScreen('main')
        } else {
          setScreen('onboarding')
        }
      })
      .catch(() => {
        // API not yet ready — retry after short delay
        setTimeout(() => setScreen('onboarding'), 1500)
      })
  }, [])

  if (screen === null) {
    return (
      <div className="flex h-full items-center justify-center bg-bina-bg">
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          <div className="w-8 h-8 rounded-full border-2 border-bina-accent border-t-transparent animate-spin" />
          <p className="text-bina-muted text-sm">Starting…</p>
        </div>
      </div>
    )
  }

  if (screen === 'onboarding') {
    return (
      <Onboarding
        onComplete={() => {
          setScreen('main')
        }}
      />
    )
  }

  return (
    <MainLayout
      initialStatus={status}
      onNeedOnboarding={() => setScreen('onboarding')}
    />
  )
}
