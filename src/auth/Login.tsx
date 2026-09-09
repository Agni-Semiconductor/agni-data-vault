import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Button, Input } from '../components/ui'
import { useAuth } from './AuthProvider'
export default function Login() {
  const { session, signInWithOtp, verifyOtp } = useAuth(); const location = useLocation(); const from = (location.state as { from?: string } | null)?.from
  const [email, setEmail] = useState(''); const [token, setToken] = useState(''); const [sent, setSent] = useState(false); const [error, setError] = useState<string>(); const [loading, setLoading] = useState(false)
  if (session) return <Navigate to={from ?? '/'} replace />
  async function send(event: FormEvent) { event.preventDefault(); setLoading(true); setError(undefined); const result = await signInWithOtp(email); setLoading(false); if (result.error) setError(result.error); else setSent(true) }
  async function verify(event: FormEvent) { event.preventDefault(); setLoading(true); setError(undefined); const result = await verifyOtp(email, token); setLoading(false); if (result.error) setError(result.error) }
  return <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4"><section className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm"><h1 className="text-2xl font-semibold text-gray-900">Agni Data Vault</h1><p className="mt-2 text-sm text-gray-600">Sign in with your approved work email.</p><form className="mt-6 space-y-4" onSubmit={send}><Input label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /><Button className="w-full" type="submit" loading={loading}>Send magic link</Button></form>{sent && <form className="mt-6 space-y-4 border-t border-gray-200 pt-5" onSubmit={verify}><p className="text-sm font-medium text-green-700">Check your email. You can also enter the 6-digit code below.</p><Input label="Verification code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={token} onChange={(event) => setToken(event.target.value.replace(/\D/g, ''))} /><Button className="w-full" type="submit" loading={loading} disabled={token.length !== 6}>Verify code</Button></form>}{error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}</section></main>
}
