"use client"

import * as React from "react"
import {
  DirectionProvider as RadixDirectionProvider,
  useDirection as useRadixDirection,
} from "@radix-ui/react-direction"

export interface DirectionProviderProps {
  dir?: "ltr" | "rtl"
  direction?: "ltr" | "rtl"
  children: React.ReactNode
}

/**
 * DirectionProvider component that wraps @radix-ui/react-direction.
 * Conforms to https://ui.shadcn.com/docs/components/radix/direction
 */
export function DirectionProvider({
  dir,
  direction,
  children,
}: DirectionProviderProps) {
  const resolvedDir = direction ?? dir ?? "rtl"
  return (
    <RadixDirectionProvider dir={resolvedDir}>
      {children}
    </RadixDirectionProvider>
  )
}

export const useDirection = useRadixDirection
export { RadixDirectionProvider }

