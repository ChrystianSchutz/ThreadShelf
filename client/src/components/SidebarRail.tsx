import { Icons } from '../icons';
import { collLabel } from '../utils';
import { ThemeToggle } from './ThemeToggle';

type RoutePath = '/search' | '/chat' | '/insights' | '/notes' | '/indexing' | '/mcp' | '/settings';

interface NavItem {
  readonly id: RoutePath;
  readonly viewKey: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: '/search', viewKey: 'search', label: 'Search archive', icon: Icons.search },
  { id: '/chat', viewKey: 'chat', label: 'New chat', icon: Icons.spark },
  { id: '/insights', viewKey: 'insights', label: 'Insights', icon: Icons.chart },
  { id: '/notes', viewKey: 'notes', label: 'Markdown/Obsidian', icon: Icons.folder },
  { id: '/indexing', viewKey: 'indexing', label: 'Add data', icon: Icons.download },
  { id: '/mcp', viewKey: 'mcp', label: 'MCP', icon: Icons.plug },
  { id: '/settings', viewKey: 'settings', label: 'Settings', icon: Icons.settings },
];

interface SidebarRailProps {
  readonly view: string;
  readonly setView: (v: RoutePath) => void;
  readonly activeColl: string;
  readonly setActiveColl: (c: string) => void;
  readonly onDeleteCollection: (name: string) => void;
  readonly collections: readonly string[];
}

export function SidebarRail({
  view,
  setView,
  activeColl,
  setActiveColl,
  onDeleteCollection,
  collections,
}: SidebarRailProps) {
  return (
    <aside className="sidebar rail">
      <div className="rail-brand">
        <div className="sb-logo" aria-hidden="true" style={{ width: 22, height: 22 }} />
        <span className="name">ThreadShelf</span>
      </div>

      <nav className="rail-nav">
        {NAV_ITEMS.map((n) => (
          <button
            key={n.id}
            className="rail-item"
            data-active={view === n.viewKey}
            onClick={() => setView(n.id)}
          >
            <span className="ico-wrap">{n.icon}</span>
            <span>{n.label}</span>
          </button>
        ))}
      </nav>

      <div className="rail-sep-h">Collections</div>

      <div className="rail-colls">
        <button
          className="rail-coll"
          data-active={activeColl === 'all'}
          onClick={() => setActiveColl('all')}
        >
          <i style={{ background: 'var(--accent)' }} />
          <span>All collections</span>
        </button>

        {collections
          .filter((c) => c !== 'all')
          .map((c) => (
            <div key={c} className="rail-coll-row">
              <button
                className="rail-coll"
                data-active={activeColl === c}
                onClick={() => setActiveColl(c)}
              >
                <i />
                <span>{collLabel(c)}</span>
              </button>
              {c !== 'chunks' && c !== 'threadshelf_conversations' && (
                <button
                  className="rail-coll-delete"
                  title={`Delete ${collLabel(c)}`}
                  aria-label={`Delete ${collLabel(c)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCollection(c);
                  }}
                >
                  {Icons.trash}
                </button>
              )}
            </div>
          ))}
      </div>

      <div className="rail-foot">
        <span className="sb-status">:3000</span>
        <ThemeToggle variant="icon" />
      </div>
    </aside>
  );
}
