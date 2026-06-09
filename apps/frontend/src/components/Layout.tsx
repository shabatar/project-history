import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as api from '../lib/api';
import { configureIssueTracker } from '../lib/linkify';
import { useAppStore, type Theme } from '../store';

import Repositories from '../pages/Repositories';
import Summaries from '../pages/Summaries';
import Boards from '../pages/Boards';
import Settings from '../pages/Settings';
import SummaryDetail from '../pages/SummaryDetail';
import ActivitySnapshotDetail from '../pages/ActivitySnapshotDetail';
import CommitSnapshotDetail from '../pages/CommitSnapshotDetail';
import ActivitySummaryDetail from '../pages/ActivitySummaryDetail';

type PageKey = 'repositories' | 'summaries' | 'boards' | 'settings' | 'summary-detail' | 'snapshot-detail' | 'commit-snapshot-detail' | 'activity-summary-detail';
const ALL_PAGE_KEYS: PageKey[] = ['repositories', 'summaries', 'boards', 'settings'];

function resolveActiveKey(pathname: string): PageKey {
  if (/^\/summaries\/[^/]+/.test(pathname)) return 'summary-detail';
  if (/^\/reports\/snapshot\/[^/]+/.test(pathname)) return 'snapshot-detail';
  if (/^\/reports\/commit-snapshot\/[^/]+/.test(pathname)) return 'commit-snapshot-detail';
  if (/^\/reports\/activity-summary\/[^/]+/.test(pathname)) return 'activity-summary-detail';
  if (pathname.startsWith('/summaries')) return 'summaries';
  if (pathname.startsWith('/boards') || pathname.startsWith('/activity')) return 'boards';
  if (pathname.startsWith('/settings')) return 'settings';
  return 'repositories';
}

function pageElement(key: PageKey) {
  switch (key) {
    case 'repositories': return <Repositories />;
    case 'summaries': return <Summaries />;
    case 'boards': return <Boards />;
    case 'settings': return <Settings />;
    case 'summary-detail': return <SummaryDetail />;
    case 'snapshot-detail': return <ActivitySnapshotDetail />;
    case 'commit-snapshot-detail': return <CommitSnapshotDetail />;
    case 'activity-summary-detail': return <ActivitySummaryDetail />;
  }
}

const coreNavItems = [
  { to: '/', label: 'Repositories' },
  { to: '/summaries', label: 'Reports' },
];

function useResolvedTheme(theme: Theme): 'dark' | 'light' {
  const [system, setSystem] = useState<'dark' | 'light'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return theme === 'auto' ? system : theme;
}

export default function Layout() {
  const { pathname } = useLocation();
  const active = resolveActiveKey(pathname);

  // Track which pages have ever been rendered so we never unmount them.
  // Mutating a ref during render is intentional — it's not reactive state,
  // and the change is always reflected before children render.
  const mountedRef = useRef(new Set<PageKey>());
  if (active !== 'summary-detail' && active !== 'snapshot-detail' && active !== 'commit-snapshot-detail' && active !== 'activity-summary-detail') {
    mountedRef.current.add(active as PageKey);
  }

  const { data: features } = useQuery({
    queryKey: ['features'],
    queryFn: api.getFeatures,
    staleTime: 60_000,
  });

  const { data: ytConfig } = useQuery({
    queryKey: ['yt-config'],
    queryFn: api.getYouTrackConfig,
    enabled: !!features?.youtrack,
    staleTime: 60_000,
  });

  useEffect(() => {
    const { settings } = useAppStore.getState();
    if (settings?.issueTrackerType && settings?.issueTrackerType !== 'none' && settings?.issueTrackerUrl) {
      configureIssueTracker(settings.issueTrackerType, settings.issueTrackerUrl);
      return;
    }
    if (ytConfig?.base_url) {
      configureIssueTracker('youtrack', ytConfig.base_url);
    }
  }, [ytConfig?.base_url]);

  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const resolved = useResolvedTheme(theme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-dark', 'theme-light');
    root.classList.add(`theme-${resolved}`);
  }, [resolved]);

  function toggleTheme() {
    setTheme(resolved === 'dark' ? 'light' : 'dark');
  }

  const navItems = [
    ...coreNavItems,
    ...(features?.youtrack ? [{ to: '/boards', label: 'Activity' }] : []),
    { to: '/settings', label: 'Settings' },
  ];

  return (
    <div className="layout">
      <header className="topbar">
        <h1 className="topbar-title">project history</h1>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          title={`Switch to ${resolved === 'dark' ? 'light' : 'dark'}`}
        >
          {resolved === 'dark' ? '☾' : '☀'}
        </button>
      </header>
      <div className="layout-body">
        <nav className="sidebar">
          <ul className="sidebar-nav">
            {navItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    `sidebar-link${isActive ? ' active' : ''}`
                  }
                  end={item.to === '/'}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="main-content">
          {ALL_PAGE_KEYS.map((key) => {
            if (!mountedRef.current.has(key)) return null;
            return (
              <div
                key={key}
                style={active === key ? { display: 'contents' } : { display: 'none' }}
              >
                {pageElement(key)}
              </div>
            );
          })}
          {/* Detail pages use useParams() — rendered via Outlet inside matched Routes */}
          {(active === 'summary-detail' || active === 'snapshot-detail' || active === 'commit-snapshot-detail' || active === 'activity-summary-detail') && <Outlet />}
        </main>
      </div>
    </div>
  );
}
