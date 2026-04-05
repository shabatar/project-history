import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Repositories from './pages/Repositories';
import CommitExplorer from './pages/CommitExplorer';
import Summaries from './pages/Summaries';
import SummaryDetail from './pages/SummaryDetail';
import Boards from './pages/Boards';
import Settings from './pages/Settings';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Repositories />} />
        <Route path="repositories" element={<Repositories />} />
        <Route path="commits" element={<CommitExplorer />} />
        <Route path="summaries" element={<Summaries />} />
        <Route path="summaries/:jobId" element={<SummaryDetail />} />
        <Route path="boards" element={<Boards />} />

        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
