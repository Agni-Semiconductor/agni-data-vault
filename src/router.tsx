import { lazy, Suspense } from 'react'
import { createBrowserRouter as makeBrowserRouter, useRouteError } from 'react-router-dom'
import Login from './auth/Login'
import RequireAuth from './auth/RequireAuth'
import Layout from './components/Layout'
import { Spinner } from './components/ui'
const Dashboard = lazy(() => import('./pages/Dashboard')); const SamplesList = lazy(() => import('./pages/SamplesList')); const SampleDetail = lazy(() => import('./pages/SampleDetail')); const MeasurementDetail = lazy(() => import('./pages/MeasurementDetail')); const AdminFields = lazy(() => import('./pages/AdminFields')); const AdminVocabularies = lazy(() => import('./pages/AdminVocabularies'))
function Page({ component: Component }: { component: React.LazyExoticComponent<React.ComponentType> }) { return <Suspense fallback={<div className="p-8"><Spinner /></div>}><Component /></Suspense> }
function RouteError() { const error: unknown = useRouteError(); return <main className="p-6"><h1 className="text-xl font-semibold">Something went wrong</h1><p className="mt-2 text-sm text-red-700">{error instanceof Error ? error.message : 'An unexpected route error occurred.'}</p></main> }
export const router = makeBrowserRouter([{ path: '/login', element: <Login />, errorElement: <RouteError /> }, { element: <RequireAuth />, errorElement: <RouteError />, children: [{ element: <Layout />, children: [{ path: '/', element: <Page component={Dashboard} /> }, { path: '/samples', element: <Page component={SamplesList} /> }, { path: '/samples/:sampleId', element: <Page component={SampleDetail} /> }, { path: '/measurements/:id', element: <Page component={MeasurementDetail} /> }, { path: '/admin/fields', element: <Page component={AdminFields} /> }, { path: '/admin/vocab', element: <Page component={AdminVocabularies} /> }] }] }])
