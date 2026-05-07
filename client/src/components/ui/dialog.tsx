import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X, ChevronLeft } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // No backdrop on mobile — the dialog is fullscreen page-style there,
      // an overlay would just be a wasted black layer behind opaque content.
      "fixed inset-0 z-50 bg-transparent sm:bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Default = desktop: centered modal with backdrop + corner X.
        // Mobile (max-sm): full-screen page that slides in from the
        // right with a back-arrow header, no border/backdrop, top
        // anchored so the iOS keyboard doesn't hide content.
        // `content-start` packs the grid rows at the top instead of
        // stretching to fill the container.
        "fixed z-50 grid gap-4 content-start overflow-y-auto bg-background shadow-lg duration-200",
        "left-[50%] top-[50%] w-full max-w-lg max-h-[90dvh] translate-x-[-50%] translate-y-[-50%] rounded-lg border p-6",
        "max-sm:inset-0 max-sm:left-0 max-sm:top-0 max-sm:max-w-none max-sm:max-h-dvh max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0 max-sm:p-4 max-sm:pt-16",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
        "max-sm:data-[state=open]:slide-in-from-right-4 max-sm:data-[state=closed]:slide-out-to-right-4 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=open]:zoom-in-100",
        className
      )}
      {...props}
    >
      {/* Mobile: native-page back arrow at top-left (sticky so it stays
          visible while the form scrolls).  Desktop: hidden, the corner X
          handles dismissal. */}
      <DialogPrimitive.Close className="sm:hidden fixed top-2 left-2 z-10 flex items-center gap-1 px-2 py-2 -ml-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronLeft className="h-5 w-5" />
        <span className="text-sm">Back</span>
      </DialogPrimitive.Close>
      {children}
      {/* Desktop X — hidden on mobile, the back arrow above takes over. */}
      <DialogPrimitive.Close className="hidden sm:flex absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
