import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Border uses foreground-at-low-opacity instead of the
          // shadcn `--input` token — that token resolves to a value
          // barely distinguishable from the background on dark themes.
          // foreground/15 reads as a clean subtle line on every
          // theme, and we bump it on hover/focus for affordance.
          "flex h-9 w-full rounded-md border border-foreground/15 bg-transparent px-3 py-1 text-base shadow-sm transition-colors",
          "hover:border-foreground/25",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
