import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import SummaryDetail from './pages/SummaryDetail';
import ActivitySnapshotDetail from './pages/ActivitySnapshotDetail';
import CommitSnapshotDetail from './pages/CommitSnapshotDetail';
import ActivitySummaryDetail from './pages/ActivitySummaryDetail';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="summaries/:jobId" element={<SummaryDetail />} />
        <Route path="reports/snapshot/:snapshotId" element={<ActivitySnapshotDetail />} />
        <Route path="reports/commit-snapshot/:snapshotId" element={<CommitSnapshotDetail />} />
        <Route path="reports/activity-summary/:summaryId" element={<ActivitySummaryDetail />} />
        <Route path="activity" element={<Navigate to="/boards" replace />} />
        <Route path="projects" element={<Navigate to="/boards" replace />} />
        <Route path="*" element={null} />
      </Route>
    </Routes>
  );
}
