import { useQuery } from '@tanstack/react-query'
import { getKinds } from '../lib/figures'
import { buildRegistry, type MeasurementKind, type UnitRegistry } from '../plot/units'

const emptyRegistry:UnitRegistry={units:{},columnUnits:{},kinds:{}}
export function useKinds(){const query=useQuery({queryKey:['kinds'],staleTime:60000,queryFn:async()=>{const response=await getKinds();return {kinds:response.items,registry:buildRegistry(response)}}});return {kinds:query.data?.kinds??[] as MeasurementKind[],registry:query.data?.registry??emptyRegistry,isLoading:query.isLoading,error:query.error,refetch:query.refetch}}
