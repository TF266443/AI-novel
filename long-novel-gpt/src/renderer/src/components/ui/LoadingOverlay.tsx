import { useAppStore } from '../../stores/useAppStore'

interface LoadingOverlayProps {
  message?: string
}

export default function LoadingOverlay({ message = '加载中...' }: LoadingOverlayProps) {
  const { isLoading } = useAppStore()

  if (!isLoading) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl p-8 flex flex-col items-center">
        <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-gray-700 font-medium">{message}</p>
      </div>
    </div>
  )
}