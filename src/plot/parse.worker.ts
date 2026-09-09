import { parseFile } from './parseFile'
type Request = { id: number; buffer: ArrayBuffer; name: string; sheet?: string }
self.onmessage = ({ data }: MessageEvent<Request>) => { try { const parsed = parseFile(data.buffer, data.name, { sheet: data.sheet }); self.postMessage({ id: data.id, ok: true, parsed }) } catch (error: unknown) { self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) }) } }
