import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';

const WorkspaceContext = createContext(null);

export function WorkspaceProvider({ children }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentProject, setCurrentProject] = useState(null);

  const reloadProjects = useCallback(async () => {
    if (!user) {
      setProjects([]);
      setLoading(false);
      return [];
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/api/projects');
      setProjects(data.projects || []);
      return data.projects || [];
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    // Drop the previous identity's project list before refetching, so a role
    // pill or action set never survives a persona switch.
    setProjects([]);
    setCurrentProject(null);
    reloadProjects().catch(() => {});
  }, [reloadProjects]);

  const upsertProject = useCallback((project) => {
    if (!project) return;
    setProjects((current) => {
      const index = current.findIndex((entry) => entry.id === project.id);
      if (index === -1) return [project, ...current];
      const next = [...current];
      next[index] = { ...next[index], ...project };
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      projects,
      loading,
      error,
      reloadProjects,
      currentProject,
      setCurrentProject,
      upsertProject,
    }),
    [projects, loading, error, reloadProjects, currentProject, upsertProject],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return context;
}
