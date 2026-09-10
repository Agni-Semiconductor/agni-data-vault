import { afterEach, describe, expect, it, vi } from 'vitest'
import { composePlotPng, downloadCanvas, safeFilename } from '../src/plot/exportPng'

const context = { fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), scale: vi.fn(), measureText: vi.fn(() => ({ width: 40 })), fillStyle: '', font: '' }

describe('plot PNG export', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('composes a scaled canvas and draws the chart once', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const chartCanvas = document.createElement('canvas'); chartCanvas.width = 600; chartCanvas.height = 320
    const result = composePlotPng({ chartCanvas, pxRatio: 2, title: 'Curve', subtitle: 'I vs V', legend: [{ label: 'I', color: '#F15A2A' }], width: 300, height: 160 })
    expect(result.width).toBe(600); expect(result.height).toBe(448); expect(context.drawImage).toHaveBeenCalledTimes(1)
  })
  it('converts a plot title to a safe file name', () => expect(safeFilename('20-DC-1 (300C) |BI|')).toBe('20-DC-1_300C_BI'))
  it('downloads a blob through an anchor element', () => {
    let downloaded = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloaded = this.download })
    const createObjectURL = vi.fn(() => 'blob:plot')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'toBlob').mockImplementation((callback) => callback(new Blob(['png'], { type: 'image/png' })))
    downloadCanvas(canvas, 'curve.png')
    expect(createObjectURL).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); expect(downloaded).toBe('curve.png')
  })
})
