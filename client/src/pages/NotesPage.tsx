import { useUIStore } from '../store';
import { Topbar } from '../components/Topbar';
import { ObsidianPanel } from '../components/ObsidianPanel';

export function NotesPage() {
  const activeColl = useUIStore((s) => s.activeColl);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  return (
    <>
      <Topbar view="notes" activeColl={activeColl} onMenu={() => setSidebarOpen(true)} />
      <div className="main-scroll">
        <div className="view">
          <ObsidianPanel />
        </div>
      </div>
    </>
  );
}
