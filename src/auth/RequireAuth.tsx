import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Spinner } from '../components/ui'
import { useAuth } from './AuthProvider'
export default function RequireAuth() { const { user, loading } = useAuth(); const location = useLocation(); if (loading) return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>; if (!user) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />; return <Outlet /> }
