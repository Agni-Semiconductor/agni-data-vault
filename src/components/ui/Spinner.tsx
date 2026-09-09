import clsx from 'clsx'
export function Spinner({ size = 'md' }: { size?: 'sm'|'md' }) { return <span aria-label="Loading" role="status" className={clsx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', size === 'sm' ? 'h-4 w-4' : 'h-6 w-6')} /> }
