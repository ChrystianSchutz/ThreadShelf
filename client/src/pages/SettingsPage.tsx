import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useUIStore } from '../store';
import { useCollectionsQuery } from '../queries';
import { Topbar } from '../components/Topbar';
import { SettingsView } from '../components/SettingsView';
import { GenerationSettings } from '../components/GenerationSettings';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeColl = useUIStore((s) => s.activeColl);
  const setActiveColl = useUIStore((s) => s.setActiveColl);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const { data } = useCollectionsQuery();
  const stats = data?.stats ?? {};

  const onRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['collections'] });
    await queryClient.invalidateQueries({ queryKey: ['files'] });
  }, [queryClient]);

  const onDeleted = useCallback(() => {
    setActiveColl('all');
    void navigate({ to: '/search/$collection', params: { collection: 'all' } });
  }, [navigate, setActiveColl]);

  return (
    <>
      <Topbar view="settings" activeColl={activeColl} onMenu={() => setSidebarOpen(true)} />
      <div className="main-scroll">
        <div className="view">
          <GenerationSettings />
        </div>
        <SettingsView
          activeColl={activeColl}
          stats={stats}
          onRefresh={onRefresh}
          onDeleted={onDeleted}
        />
      </div>
    </>
  );
}
