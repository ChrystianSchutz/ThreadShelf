import type { ReactNode } from 'react';
import { Icons } from '../icons';
import { collLabel } from '../utils';

const VIEW_LABELS: Record<string, string> = {
  search: 'Archive',
  insights: 'Insights',
  notes: 'Markdown/Obsidian',
  indexing: 'Add data',
  mcp: 'MCP',
  settings: 'Settings',
  chat: 'Chat',
};

interface TopbarProps {
  readonly view: string;
  readonly activeColl: string;
  readonly onMenu: () => void;
  readonly actions?: ReactNode;
}

export function Topbar({ view, activeColl, onMenu, actions }: TopbarProps) {
  return (
    <div className="topbar">
      <button className="icon-btn mobile-menu-btn" onClick={onMenu} aria-label="Open sidebar">
        {Icons.menu}
      </button>
      <div className="crumbs">
        <span>{VIEW_LABELS[view]}</span>
        {view === 'search' && (
          <>
            <span className="sep">/</span>
            <b>{collLabel(activeColl)}</b>
          </>
        )}
      </div>
      <div className="topbar-spacer" />
      {actions && <div className="topbar-actions">{actions}</div>}
    </div>
  );
}
