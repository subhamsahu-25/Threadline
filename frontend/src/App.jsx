import { Component, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AppShell from './components/AppShell.jsx';
import { IdleWakeNotice } from './components/ColdStartNotice.jsx';
import { ErrorState, LoadingScreen } from './components/ui.jsx';
import { useAuth } from './context/AuthContext.jsx';
import { WorkspaceProvider } from './context/WorkspaceContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ProjectsPage from './pages/ProjectsPage.jsx';
import ProjectLayout from './pages/ProjectLayout.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import SourcesPage from './pages/SourcesPage.jsx';
import ClaimsPage from './pages/ClaimsPage.jsx';
import HandoversPage from './pages/HandoversPage.jsx';
import HandoverReviewPage from './pages/HandoverReviewPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import PeoplePage from './pages/PeoplePage.jsx';
import QuestionsPage from './pages/QuestionsPage.jsx';
import SharedHandoverPage from './pages/SharedHandoverPage.jsx';
import VerifyEmailPage from './pages/VerifyEmailPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname]);
  return null;
}

function RequireAuth({ children }) {
  const { user, booting } = useAuth();
  const location = useLocation();
  if (booting) return <LoadingScreen label="Checking your session" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-2xl px-6 py-16">
          <ErrorState
            title="The interface hit an unexpected error"
            error={this.state.error}
            onRetry={() => window.location.reload()}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <ScrollToTop />
      <IdleWakeNotice />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/shared/:token" element={<SharedHandoverPage />} />
        <Route
          element={
            <RequireAuth>
              <WorkspaceProvider>
                <AppShell />
              </WorkspaceProvider>
            </RequireAuth>
          }
        >
          <Route index element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="sources" element={<SourcesPage />} />
            <Route path="claims" element={<ClaimsPage />} />
            <Route path="handovers" element={<HandoversPage />} />
            <Route path="handovers/:handoverId" element={<HandoverReviewPage />} />
            <Route path="questions" element={<QuestionsPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="people" element={<PeoplePage />} />
            <Route path="settings" element={<Navigate to="../people" replace />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
