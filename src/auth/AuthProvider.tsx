import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
interface AuthContextValue { session: Session | null; user: User | null; loading: boolean; signInWithOtp: (email: string) => Promise<{ error?: string }>; verifyOtp: (email: string, token: string) => Promise<{ error?: string }>; signOut: () => Promise<void> }
const AuthContext = createContext<AuthContextValue | null>(null)
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null); const [loading, setLoading] = useState(true)
  useEffect(() => { let active = true; void supabase.auth.getSession().then(({ data }) => { if (active) { setSession(data.session); setLoading(false) } }); const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setLoading(false) }); return () => { active = false; subscription.unsubscribe() } }, [])
  const value = useMemo<AuthContextValue>(() => ({ session, user: session?.user ?? null, loading, async signInWithOtp(email) { const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + '/', shouldCreateUser: false } }); return error ? { error: error.message } : {} }, async verifyOtp(email, token) { const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' }); return error ? { error: error.message } : {} }, async signOut() { await supabase.auth.signOut() } }), [loading, session])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
export function useAuth() { const context = useContext(AuthContext); if (!context) throw new Error('useAuth must be used inside AuthProvider'); return context }
