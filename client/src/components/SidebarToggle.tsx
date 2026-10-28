import { Icons } from '../icons';
import { useUIStore } from '../store';

/** Matches the drawer breakpoint in styles/_responsive.scss. */
const DRAWER_QUERY = '(max-width: 820px)';

/** Opens the drawer on narrow screens; hides or shows the docked sidebar on wider ones. */
export function SidebarToggle({ onMenu }: { readonly onMenu: () => void }) {
  const hidden = useUIStore((s) => s.sidebarHidden);
  const setHidden = useUIStore((s) => s.setSidebarHidden);
  const drawer = typeof window !== 'undefined' && window.matchMedia(DRAWER_QUERY).matches;
  const label = drawer ? 'Open sidebar' : hidden ? 'Show sidebar' : 'Hide sidebar';
  return (
    <button
      className="icon-btn mobile-menu-btn"
      onClick={() => (window.matchMedia(DRAWER_QUERY).matches ? onMenu() : setHidden(!hidden))}
      aria-label={label}
      title={label}
    >
      {Icons.menu}
    </button>
  );
}
