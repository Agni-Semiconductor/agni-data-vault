import { useNavigate } from 'react-router-dom'
import AskConversation from './AskConversation'

/**
 * The full-page form remains addressable at /ask, but it is no longer in the navigation: the
 * assistant is a panel now (src/components/AskSidebar.tsx), available without leaving the page you
 * are reading. This wrapper exists so an existing link or bookmark does not 404.
 */
export default function AskPage() {
  const navigate = useNavigate()
  return (
    <div className="max-w-4xl space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Ask the vault</h1>
        <p className="mt-1 text-sm text-agni-slate">
          Turn a question into an editable filter. The agent sees the schema, never measurements or their notes.
        </p>
      </header>
      <AskConversation onOpenFilter={(url) => navigate(url)} />
    </div>
  )
}

export { AskPage }
