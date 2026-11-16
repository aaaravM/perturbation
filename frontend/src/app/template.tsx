// Soft page-enter transition. A template re-mounts on every navigation, so each page fades in.
// The fade is CSS (.page-enter in globals.css), so it runs from the first paint: the page, or its
// skeleton while it loads, shows before the scripts arrive. Opacity only: a transform here would
// sit above the sky viewer's canvas while it measures.

export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter flex flex-1 flex-col">{children}</div>;
}
