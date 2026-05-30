import { createFileRoute } from '@tanstack/react-router'
import { ProsperScreen } from '@/screens/prosper/prosper-screen'

export const Route = createFileRoute('/prosper')({
  component: ProsperScreen,
})
