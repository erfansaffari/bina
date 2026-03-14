import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import Onboarding from './components/Onboarding'
import MainLayout from './components/MainLayout'
import type { AppScreen, StatusData } from './types'

export default function App() {
  const [screen, setScreen] = useState<AppScreen | null>(null)
  const [status, setStatus] = useState<StatusData | null>(null)
  const watcherStarted = useRef(false)

  useEffect(() => {
    api.status()
      .then((s) => {
        setStatus(s)
        if (s.watched_folder) {
          // Restart the FSEvents watcher every time the app launches so that
          // Finder deletions/additions are picked up even after a relaunch.
          if (!watcherStarted.current) {
            watcherStarted.current = true
            api.watch(s.watched_folder).catch(() => {})
          }
          setScreen('main')
        } else {
          setScreen('onboarding')
        }
      })
      .catch(() => {
        // API not yet ready — retry
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
        onComplete={(folder) => {
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
