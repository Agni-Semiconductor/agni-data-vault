import { Navigate, useLocation } from 'react-router-dom'
import { Button } from '../components/ui'
import { useAuth } from './AuthProvider'
export default function Login() {
  const { user, loading, error } = useAuth(); const location = useLocation(); const from = (location.state as { from?: string } | null)?.from
  if (user) return <Navigate to={from ?? '/'} replace />
  return <main className="flex min-h-screen items-center justify-center bg-white p-4"><section className="w-full max-w-md rounded-lg border border-border-subtle bg-white p-6 shadow-card"><img src="/agni-logo.png" alt="Agni" className="w-40" /><h1 className="mt-6 text-2xl">Workspace access</h1><p className="mt-2 text-sm text-agni-slate">Access is granted through Google Workspace sign-in by Cloudflare Access.</p>{error && <p role="alert" className="mt-4 text-sm text-[#B3261E]">{error.message}</p>}<Button className="mt-6 w-full" type="button" loading={loading} onClick={() => window.location.reload()}>Retry</Button></section></main>
}
