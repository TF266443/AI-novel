import { useAppStore } from './stores/useAppStore'
import { useProjectStore } from './stores/useProjectStore'
import HomePage from './pages/HomePage'
import WorkbenchPage from './pages/WorkbenchPage'
import ModelsPage from './pages/ModelsPage'
import TemplatesPage from './pages/TemplatesPage'
import SettingsPage from './pages/SettingsPage'
import CharactersPage from './pages/CharactersPage'
import SkillsPage from './pages/SkillsPage'
import Toast from './components/ui/Toast'
import LoadingOverlay from './components/ui/LoadingOverlay'
import ErrorBoundary from './components/ui/ErrorBoundary'

function App() {
  const { currentPage, toasts, removeToast, isLoading } = useAppStore()
  const { currentProject } = useProjectStore()

  const renderPage = () => {
    if (currentPage === 'characters' && currentProject) {
      return <CharactersPage />
    }

    if (currentProject && currentPage !== 'home') {
      return <WorkbenchPage />
    }

    switch (currentPage) {
      case 'home':
        return <HomePage />
      case 'models':
        return <ModelsPage />
      case 'templates':
        return <TemplatesPage />
      case 'settings':
        return <SettingsPage />
      case 'skills':
        return <SkillsPage />
      default:
        return <HomePage />
    }
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50">
        {renderPage()}
        <LoadingOverlay />
        <div className="fixed bottom-4 right-4 space-y-2 z-50">
          {toasts.map((toast) => (
            <Toast
              key={toast.id}
              message={toast.message}
              type={toast.type}
              onClose={() => removeToast(toast.id)}
            />
          ))}
        </div>
      </div>
    </ErrorBoundary>
  )
}

export default App