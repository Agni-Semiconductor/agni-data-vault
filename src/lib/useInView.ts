import { useEffect, useRef, useState } from 'react'

/** Tracks proximity and visibility without retaining charts far from the viewport. */
export function useInView(rootMargin = '300px') {
  const ref = useRef<HTMLDivElement>(null)
  const [hasBeenNear, setHasBeenNear] = useState(false)
  const [isNear, setIsNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      setIsNear(entry.isIntersecting)
      if (entry.isIntersecting) setHasBeenNear(true)
    }, { rootMargin })
    observer.observe(element)
    return () => observer.disconnect()
  }, [rootMargin])
  return { ref, hasBeenNear, isNear }
}
