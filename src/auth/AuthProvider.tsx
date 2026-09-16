import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
interface AuthUser { email: string; user_metadata: { full_name?: string } }
interface AuthContextValue { user: AuthUser | null; loading: boolean; error: Error | null; signOut: () => void }
const AuthContext = createContext<AuthContextValue | null>(null)
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<Error | null>(null)
  useEffect(() => { const controller = new AbortController(); void fetch('/api/me', { signal: controller.signal }).then(async (response) => { if (!response.ok) throw new Error(response.status === 401 ? 'Cloudflare Access authentication is required.' : 'Unable to verify access.'); const { principal } = await response.json() as { principal: { kind: string; actor: string } }; setUser({ email: principal.actor, user_metadata: {} }) }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason : new Error('Unable to verify access.')) }).finally(() => { if (!controller.signal.aborted) setLoading(false) }); return () => controller.abort() }, [])
  const value = useMemo<AuthContextValue>(() => ({ user, loading, error, signOut() { window.location.assign('/cdn-cgi/access/logout') } }), [error, loading, user])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
export function useAuth() { const context = useContext(AuthContext); if (!context) throw new Error('useAuth must be used inside AuthProvider'); return context }
