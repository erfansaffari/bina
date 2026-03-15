import { useState, useEffect } from 'react'
import { useAppStore } from './store/appStore'
import Onboarding from './components/Onboarding'
import MainLayout from './components/MainLayout'

export default function App() {
  const { workspaces, loadWorkspaces } = useAppStore()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    loadWorkspaces().then(() => setReady(true))
  }, [loadWorkspaces])

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-bina-bg">
        <div className="w-6 h-6 border-2 border-bina-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Only show onboarding for brand-new users with no workspaces.
  // Model setup is handled inside the Onboarding flow (models step)
  // and also accessible from Settings → AI Models for existing users.
  if (workspaces.length === 0) {
    return <Onboarding onComplete={() => loadWorkspaces()} />
  }

  return <MainLayout />
}
