import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { RootLayout } from './layouts/RootLayout';
import { SearchPage } from './pages/SearchPage';
import { ThreadPage } from './pages/ThreadPage';
import { IndexingPage } from './pages/IndexingPage';
import { NotesPage } from './pages/NotesPage';
import { InsightsPage } from './pages/InsightsPage';
import { McpPage } from './pages/McpPage';
import { SettingsPage } from './pages/SettingsPage';
import { ChatPage } from './pages/ChatPage';
import { NotFound } from './components/NotFound';

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/search/$collection', params: { collection: 'all' } });
  },
});

export interface SearchParams {
  q?: string;
  model?: string;
  from?: string;
  to?: string;
  mode?: string;
}

// Bare /search (and old ?collection links) redirect to the canonical collection
// route so the active collection is always visible in the URL.
const searchRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  beforeLoad: ({ search }: { search: Record<string, unknown> }) => {
    const collection = typeof search.collection === 'string' ? search.collection : 'all';
    throw redirect({
      to: '/search/$collection',
      params: { collection },
      search: {
        q: typeof search.q === 'string' ? search.q : undefined,
        model: typeof search.model === 'string' ? search.model : undefined,
        from: typeof search.from === 'string' ? search.from : undefined,
        to: typeof search.to === 'string' ? search.to : undefined,
        mode: typeof search.mode === 'string' ? search.mode : undefined,
      },
    });
  },
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search/$collection',
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    q: typeof search.q === 'string' ? search.q : undefined,
    model: typeof search.model === 'string' ? search.model : undefined,
    from: typeof search.from === 'string' ? search.from : undefined,
    to: typeof search.to === 'string' ? search.to : undefined,
    mode: search.mode === 'keyword' ? 'keyword' : undefined,
  }),
});

export interface ThreadParams {
  sourceFile: string;
  collection?: string;
  conversationKey?: string;
  q?: string;
  title?: string;
  provider?: string;
  model?: string;
  matchIdx?: number;
}

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/thread',
  component: ThreadPage,
  validateSearch: (search: Record<string, unknown>): ThreadParams => ({
    sourceFile: typeof search.sourceFile === 'string' ? search.sourceFile : '',
    collection: typeof search.collection === 'string' ? search.collection : undefined,
    conversationKey:
      typeof search.conversationKey === 'string' ? search.conversationKey : undefined,
    q: typeof search.q === 'string' ? search.q : undefined,
    title: typeof search.title === 'string' ? search.title : undefined,
    provider: typeof search.provider === 'string' ? search.provider : undefined,
    model: typeof search.model === 'string' ? search.model : undefined,
    matchIdx: typeof search.matchIdx === 'number' ? search.matchIdx : undefined,
  }),
});

const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/insights',
  component: InsightsPage,
});

const indexingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/indexing',
  component: IndexingPage,
});

const notesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notes',
  component: NotesPage,
});

const mcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mcp',
  component: McpPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

export interface ChatParams {
  draft?: string;
  private?: string;
  thread?: string;
}

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>): ChatParams => ({
    draft: typeof search.draft === 'string' ? search.draft : undefined,
    private: typeof search.private === 'string' ? search.private : undefined,
    thread: typeof search.thread === 'string' ? search.thread : undefined,
  }),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  searchRedirectRoute,
  searchRoute,
  threadRoute,
  insightsRoute,
  notesRoute,
  indexingRoute,
  mcpRoute,
  settingsRoute,
  chatRoute,
]);

export const router = createRouter({ routeTree, defaultNotFoundComponent: NotFound });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
