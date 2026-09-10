import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getCoreRowModel, useReactTable, type ColumnDef, type OnChangeFn, type SortingState } from '@tanstack/react-table'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Input, Spinner, Table } from '../../components/ui'
import { asFigureSortKey, deleteFigure, listFigures } from '../../lib/figures'

const pageSize = 50
type Figure = Awaited<ReturnType<typeof listFigures>>['items'][number]

export default function FigureList() {
  const navigate = useNavigate(), client = useQueryClient(), [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? ''), [debouncedQ, setDebouncedQ] = useState(q)
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0)
  // Narrow the URL's sort key here, at the edge, so the header and the server cannot disagree.
  const [sorting, setSorting] = useState<SortingState>(() => [{ id: asFigureSortKey(params.get('sort') ?? undefined) ?? 'updated_at', desc: params.get('order') !== 'asc' }])
  useEffect(() => { const t = window.setTimeout(() => { setDebouncedQ(q.trim()); setParams((current) => { const next = new URLSearchParams(current); if (q.trim()) next.set('q', q.trim()); else next.delete('q'); if ((current.get('q') ?? '') !== q.trim()) next.delete('page'); return next }, { replace: true }) }, 300); return () => window.clearTimeout(t) }, [q, setParams])
  const onSortingChange: OnChangeFn<SortingState> = (update) => setSorting((current) => { const next = typeof update === 'function' ? update(current) : update, sort = next[0]; setParams((value) => { const updated = new URLSearchParams(value); if (sort) { updated.set('sort', sort.id); updated.set('order', sort.desc ? 'desc' : 'asc') } else { updated.delete('sort'); updated.delete('order') } updated.delete('page'); return updated }, { replace: true }); return next })
  const result = useQuery({ queryKey: ['figures', debouncedQ, sorting, page], queryFn: () => listFigures({ q: debouncedQ, sort: asFigureSortKey(sorting[0]?.id), order: sorting[0]?.desc ? 'desc' : 'asc', limit: pageSize, offset: page * pageSize }) })
  const remove = useMutation({ mutationFn: deleteFigure, onSuccess: async () => { await client.invalidateQueries({ queryKey: ['figures'] }) } })
  const { error: removeError, isPending: isRemoving, mutate: removeFigure, variables: removingId } = remove
  const figurePath = (figure: Figure) => `/figures/${encodeURIComponent(figure.slug || figure.id)}`
  const columns = useMemo<ColumnDef<Figure>[]>(() => [
    { accessorKey: 'title', header: 'Title', enableSorting: true, cell: ({ row }) => <Link className="font-medium text-agni-orange hover:underline" to={figurePath(row.original)} onClick={(event) => event.stopPropagation()}>{row.original.title}</Link> },
    { accessorKey: 'description', header: 'Description', enableSorting: false, cell: ({ getValue }) => <span className="block max-w-md truncate" title={String(getValue() ?? '')}>{String(getValue() ?? 'No description')}</span> },
    { accessorKey: 'created_by', header: 'Created by', enableSorting: true, cell: ({ getValue }) => String(getValue() ?? 'Unknown') },
    { accessorKey: 'updated_at', header: 'Updated', enableSorting: true, cell: ({ getValue }) => { const value = getValue<string | null>(); return value ? new Date(value).toLocaleString() : 'Not recorded' } },
    { id: 'actions', header: '', enableSorting: false, cell: ({ row }) => <Button variant="danger" size="sm" loading={isRemoving && removingId === row.original.id} onClick={(event) => { event.stopPropagation(); if (window.confirm(`Delete figure "${row.original.title}"? This saved artifact cannot be recovered.`)) removeFigure(row.original.id) }}>Delete</Button> },
  ], [isRemoving, removeFigure, removingId])
  const table = useReactTable({ data: result.data?.items ?? [], columns, state: { sorting }, onSortingChange, getCoreRowModel: getCoreRowModel(), manualSorting: true, manualPagination: true })
  const setPage = (nextPage: number) => setParams((current) => { const next = new URLSearchParams(current); if (nextPage) next.set('page', String(nextPage)); else next.delete('page'); return next }, { replace: true })
  if (result.isLoading) return <Spinner />
  if (result.error) return <p className="text-[#B3261E]">{result.error.message}</p>
  const total = result.data?.total ?? 0, emptyText = total ? 'No figures exist on this page.' : debouncedQ ? `No figures match "${debouncedQ}".` : 'No figures have been saved yet.'
  return <div className="space-y-4">
    <header><h1 className="text-xl font-semibold">Figures</h1><p className="mt-1 text-sm text-agni-slate">Saved, shareable figures for publication and review.</p></header>
    <Input aria-label="Search figures" placeholder="Search title, description or slug" value={q} onChange={(event) => setQ(event.target.value)} />
    {removeError && <p className="text-sm text-[#B3261E]">Could not delete figure: {removeError.message}</p>}
    <Table table={table} onRowClick={(figure) => navigate(figurePath(figure))} emptyText={emptyText} />
    <div className="flex items-center justify-between"><p className="text-sm text-agni-slate">{total ? `${page * pageSize + 1}-${Math.min((page + 1) * pageSize, total)} of ${total}` : '0 figures'}</p><div className="flex gap-2"><Button variant="secondary" size="sm" disabled={page === 0 || result.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="secondary" size="sm" disabled={(page + 1) * pageSize >= total || result.isFetching} onClick={() => setPage(page + 1)}>Next</Button></div></div>
  </div>
}
