import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as api from '../lib/api';
import { useAppStore, type Theme } from '../store';

const coreNavItems = [
  { to: '/', label: 'Repositories' },
  { to: '/commits', label: 'Commits' },
  { to: '/summaries', label: 'Summaries' },
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
  const { data: features } = useQuery({
    queryKey: ['features'],
    queryFn: api.getFeatures,
    staleTime: 60_000,
  });

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
    ...(features?.youtrack ? [{ to: '/boards', label: 'Boards' }] : []),
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
          {resolved === 'dark' ? '\u263E' : '\u2600'}
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
          <Outlet />
        </main>
      </div>
    </div>
  );
}
