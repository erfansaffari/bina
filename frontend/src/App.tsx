import { useState, useEffect } from 'react'
import { modelsApi } from './api'
import { useAppStore } from './store/appStore'
import Onboarding from './components/Onboarding'
import MainLayout from './components/MainLayout'

export default function App() {
  const { workspaces, loadWorkspaces } = useAppStore()
  const [ready, setReady] = useState(false)
  const [modelsReady, setModelsReady] = useState(true) // optimistic — corrected after check

  useEffect(() => {
    async function init() {
      await loadWorkspaces()
      // Check which Ollama models are installed
      try {
        const result = await modelsApi.status()
        setModelsReady(result.all_ready)
      } catch {
        // Backend not yet ready — assume OK; onboarding will recheck
        setModelsReady(true)
      }
      setReady(true)
    }
    init()
  }, [loadWorkspaces])

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-bina-bg">
        <div className="w-6 h-6 border-2 border-bina-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const hasWorkspaces = workspaces.length > 0

  // Show onboarding if no workspaces, OR if required AI models are missing
  if (!hasWorkspaces || !modelsReady) {
    return (
      <Onboarding
        onComplete={() => {
          loadWorkspaces()
          setModelsReady(true)
        }}
      />
    )
  }

  return <MainLayout />
}
