import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import ErrorBoundary from './components/ErrorBoundary';
import { configureIssueTracker } from './lib/linkify';
import { useAppStore } from './store';
import App from './App';
import './index.css';

dayjs.extend(relativeTime);

// Apply persisted issue tracker config on startup
const { settings, theme } = useAppStore.getState();
if (settings?.issueTrackerType && settings?.issueTrackerUrl) {
  configureIssueTracker(settings.issueTrackerType, settings.issueTrackerUrl);
}

// Apply persisted theme on startup (before React renders)
if (theme === 'dark' || theme === 'light') {
  document.documentElement.classList.add(`theme-${theme}`);
} else {
  // auto: detect system
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.add(isDark ? 'theme-dark' : 'theme-light');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
