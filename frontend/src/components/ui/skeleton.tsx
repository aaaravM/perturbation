import { cn } from "@/lib/utils"

// Loading placeholders: quiet blocks in the surface tone with a slow pulse, which holds still with
// reduced motion (globals.css stops .animate-pulse under the Motion setting or the system's).

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-md bg-muted [animation-duration:2.4s]", className)}
      {...props}
    />
  )
}

/**
 * The region a skeleton stands in for: busy for assistive technology, with one visually hidden
 * "Loading" in place of the blocks.
 */
function SkeletonRegion({ className, children, label = "Loading", ...props }: React.ComponentProps<"div"> & { label?: string }) {
  return (
    <div aria-busy="true" data-slot="skeleton-region" className={className} {...props}>
      <span role="status" className="sr-only">
        {label}
      </span>
      {children}
    </div>
  )
}

/**
 * Lines of text as blocks, each exactly one line high in the type style of `className` (text-lead,
 * text-body…), so the space they hold matches the text that replaces them.
 */
function SkeletonText({ lines, className, last = "62%" }: { lines: number; className?: string; last?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="my-[0.24lh] h-[0.52lh] max-w-full rounded-[3px]"
          style={{ width: i === lines - 1 && lines > 1 ? last : i % 3 === 1 ? "96%" : "100%" }}
        />
      ))}
    </div>
  )
}

export { Skeleton, SkeletonRegion, SkeletonText }
