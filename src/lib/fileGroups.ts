import type { VaultFile } from './types'

export function groupFilesByMeasurement(files: VaultFile[]): Map<string, VaultFile[]> {
  const groups = new Map<string, VaultFile[]>()
  for (const file of files) {
    const group = groups.get(file.measurement_id) ?? []
    group.push(file)
    groups.set(file.measurement_id, group)
  }
  return groups
}

const dataExtension = /\.(xls|xlsx|csv|tsv|txt)$/i
const imageExtension = /\.(png|jpe?g|gif|webp|svg)$/i

export function primaryDataFile(files: VaultFile[]): VaultFile | undefined {
  return files.find((file) => file.kind === 'raw_xls')
    ?? files.find((file) => file.kind === 'raw_csv')
    ?? files.find((file) => dataExtension.test(file.original_name))
}

export function primaryImageFile(files: VaultFile[]): VaultFile | undefined {
  return files.find((file) => file.kind === 'plot_png')
    ?? files.find((file) => imageExtension.test(file.original_name))
}
