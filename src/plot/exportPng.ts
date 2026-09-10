export type PlotLegendEntry = { label: string; color: string }

export function composePlotPng(opts: { chartCanvas: HTMLCanvasElement; pxRatio: number; title: string; subtitle: string; legend: PlotLegendEntry[]; width: number; height: number }): HTMLCanvasElement {
  const ratio = opts.pxRatio || 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(opts.width * ratio)
  canvas.height = Math.round((opts.height + 64) * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.scale(ratio, ratio)
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, opts.width, opts.height + 64)
  ctx.fillStyle = '#95001A'; ctx.font = '600 16px Cabin, "IBM Plex Sans", sans-serif'; ctx.fillText(opts.title, 16, 24)
  ctx.fillStyle = '#888894'; ctx.font = '12px "IBM Plex Sans", sans-serif'; ctx.fillText(opts.subtitle, 16, 44)
  ctx.drawImage(opts.chartCanvas, 0, 0, opts.chartCanvas.width, opts.chartCanvas.height, 0, 56, opts.width, opts.height)
  ctx.font = '11px "IBM Plex Sans", sans-serif'
  const footerY = opts.height + 56
  ctx.fillText('Agni Data Vault', 16, footerY)
  let legendX = opts.width - 16
  for (const entry of [...opts.legend].reverse()) {
    legendX -= ctx.measureText(entry.label).width + 22
    ctx.fillStyle = entry.color; ctx.fillRect(legendX, footerY - 9, 10, 10)
    ctx.fillStyle = '#888894'; ctx.fillText(entry.label, legendX + 14, footerY)
    legendX -= 12
  }
  return canvas
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  const download = (href: string) => { const anchor = document.createElement('a'); anchor.download = filename; anchor.href = href; anchor.click() }
  if (canvas.toBlob) {
    canvas.toBlob((blob) => { if (!blob) return; const url = URL.createObjectURL(blob); download(url); URL.revokeObjectURL(url) }, 'image/png')
    return
  }
  download(canvas.toDataURL('image/png'))
}

export const safeFilename = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120)
