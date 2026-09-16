import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getFieldDefs, getOptionLists } from '../lib/api'
import type { Entity, OptionValue } from '../lib/types'
// Goes through /api like everything else now. This hook used to query the database directly
// with the browser's anon key, which was the second of the two parallel data paths that
// contract v2.7 collapsed. The returned shape is unchanged, so every consumer is untouched.
export function useFieldDefs(entity: Entity, { includeInactive = false }: { includeInactive?: boolean } = {}) { const defsQuery = useQuery({ queryKey:['field_definitions',entity,includeInactive], staleTime:60000, queryFn: () => getFieldDefs(entity, includeInactive) }); const listsQuery = useQuery({ queryKey:['option_values',includeInactive], staleTime:60000, queryFn: async () => { const lists = await getOptionLists(includeInactive); return lists.reduce<Record<string,OptionValue[]>>((acc, list) => { acc[list.key] = (list.values ?? []).slice().sort((a, b) => a.sort_order - b.sort_order); return acc }, {}) } }); return { defs: defsQuery.data ?? [], lists: listsQuery.data ?? {}, isLoading: defsQuery.isLoading || listsQuery.isLoading, error: defsQuery.error ?? listsQuery.error, refetch: async () => { await Promise.all([defsQuery.refetch(), listsQuery.refetch()]) } } }
export function useInvalidateFieldDefs() { const queryClient = useQueryClient(); return () => queryClient.invalidateQueries({ queryKey:['field_definitions'] }).then(() => queryClient.invalidateQueries({ queryKey:['option_values'] })) }
