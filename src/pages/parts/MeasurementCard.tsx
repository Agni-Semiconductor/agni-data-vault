import { useQuery } from '@tanstack/react-query'
import { Badge, Button, Spinner } from '../../components/ui'
import { getFileUrl } from '../../lib/api'
import { primaryDataFile, primaryImageFile } from '../../lib/fileGroups'
import { useInView } from '../../lib/useInView'
import type { Measurement, Sample, VaultFile } from '../../lib/types'
import { QuickPlot } from '../../plot/QuickPlot'
import { useParsedFile } from '../../plot/useParsedFile'

type Props = { measurement: Measurement; files: VaultFile[]; sample: Sample; mode: 'plot' | 'image'; onOpen: () => void; forceMount?: boolean }

function DataPlot({ file }: { file: VaultFile }) {
  const urlQuery = useQuery({ queryKey: ['file-url', file.id], queryFn: () => getFileUrl(file), staleTime: 240_000 })
  const parsed = useParsedFile(urlQuery.data ? { url: urlQuery.data, name: file.original_name, key: file.sha256 ?? file.id } : null)
  if (urlQuery.isLoading || parsed.isLoading) return <Spinner size="sm" />
  if (urlQuery.error || parsed.error) return <p className="px-3 text-xs text-red-600">{urlQuery.error?.message ?? parsed.error}</p>
  return parsed.parsed ? <QuickPlot parsed={parsed.parsed} compact className="h-full" /> : <p className="text-sm text-agni-slate">No data file</p>
}

function ImagePreview({ file }: { file: VaultFile }) {
  const urlQuery = useQuery({ queryKey: ['file-url', file.id], queryFn: () => getFileUrl(file), staleTime: 240_000 })
  if (urlQuery.isLoading) return <Spinner size="sm" />
  if (urlQuery.error) return <p className="px-3 text-xs text-red-600">{urlQuery.error.message}</p>
  return urlQuery.data ? <img src={urlQuery.data} alt={file.original_name} loading="lazy" className="h-full w-full object-contain bg-white" /> : null
}

export function MeasurementCard({ measurement, files, mode, onOpen, forceMount = false }: Props) {
  const { ref, hasBeenNear, isNear } = useInView()
  const dataFile = primaryDataFile(files); const imageFile = primaryImageFile(files); const file = mode === 'plot' ? dataFile : imageFile
  const meta = measurement.meta
  const temperature = measurement.temperature_c === null ? '—' : `${measurement.temperature_c} °C`
  const details = [meta.replicate, measurement.device_address ?? meta.device_address].filter((value) => value !== null && value !== undefined && value !== '').map(String)
  const displayName = file?.original_name ?? files[0]?.original_name ?? 'No files'
  const open = () => { if (!window.getSelection()?.toString()) onOpen() }
  return <article ref={ref} role="button" tabIndex={0} onClick={open} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }} className="flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border-subtle bg-white shadow-card">
    <header className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-agni-slate"><Badge tone="blue">{measurement.kind ?? '—'}</Badge><span>{temperature}</span><span>{measurement.measured_on ?? '—'}</span>{details.map((detail) => <span key={detail}>{detail}</span>)}</header>
    <div className="flex h-52 items-center justify-center overflow-hidden">{!file ? <p className="text-sm text-agni-slate">{mode === 'plot' ? 'No data file' : 'No image file'}</p> : (forceMount || (hasBeenNear && isNear)) && (mode === 'plot' ? <DataPlot file={file} /> : <ImagePreview file={file} />)}</div>
    <footer className="flex items-center gap-2 border-t border-border-subtle px-3 py-2 text-xs"><span className="min-w-0 flex-1 truncate" title={displayName}>{displayName}</span>{measurement.run_numbers.map((run) => <span className="num" key={run}>{run}</span>)}<span>{files.length} files</span><Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); onOpen() }}>Open</Button></footer>
  </article>
}
