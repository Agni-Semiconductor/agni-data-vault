import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button, Spinner } from '../components/ui'
import { getStats } from '../lib/api'
import { CreateSampleModal } from './SamplesList'

export default function Dashboard() {
  const [createOpen, setCreateOpen] = useState(false)
  const { data, error, isLoading } = useQuery({ queryKey: ['stats'], queryFn: getStats })

  if (isLoading) return <Spinner />
  if (error) return <p className="text-danger">{error.message}</p>
  if (!data) return null

  const max = Math.max(1, ...Object.values(data.by_kind))
  const stats = [
    ['Samples', data.samples],
    ['Measurements', data.measurements],
    ['Files', data.files],
    ['Storage', `${(data.bytes / 1048576).toFixed(1)} MB`],
  ] as const

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Button onClick={() => setCreateOpen(true)}>New sample</Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="w-full max-w-xs rounded-lg border border-border-subtle bg-white p-4 shadow-card">
            <p className="label-caps">{label}</p>
            <p className="font-display text-[28px] text-agni-ink">{value}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <section className="min-w-0 max-w-lg">
          <h2 className="font-semibold">By kind</h2>
          <div className="mt-3 space-y-3">
            {Object.entries(data.by_kind).map(([kind, count]) => (
              <div key={kind}>
                <div className="flex max-w-md justify-between gap-4">
                  <span className="truncate">{kind}</span>
                  <span className="num shrink-0">{count}</span>
                </div>
                <div className="mt-1 h-2 max-w-md bg-surface-2">
                  <div className="h-2 bg-agni-orange" style={{ width: `${count / max * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="min-w-0">
          <h2 className="font-semibold">Recent measurements</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-[36rem] w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-agni-slate">
                  <th className="px-2 py-2 font-medium" scope="col">Date</th>
                  <th className="px-2 py-2 font-medium" scope="col">Sample key</th>
                  <th className="px-2 py-2 font-medium" scope="col">Kind</th>
                  <th className="px-2 py-2 text-right font-medium" scope="col"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map(row=><tr key={row.measurement_id} className="border-b border-border-subtle last:border-b-0">
                  <td className="whitespace-nowrap px-2 py-2">{row.measured_on}</td>
                  <td className="px-2 py-2"><Link className="text-agni-orange" to={`/samples/${row.sample_uuid ?? row.sample_id}`}>{row.sample_id}</Link></td>
                  <td className="px-2 py-2">{row.kind}</td>
                  <td className="px-2 py-2 text-right"><Link className="text-agni-orange" to={`/measurements/${row.measurement_id}`}>Open</Link></td>
                </tr>)}</tbody>
            </table>
          </div>
        </section>
      </div>
      <CreateSampleModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}
