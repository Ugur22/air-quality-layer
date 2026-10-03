import { useEffect, useState } from 'react'

/** The value, but only once it has stopped changing for `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value)
    }, ms)
    return () => {
      clearTimeout(timer)
    }
  }, [value, ms])
  return debounced
}
