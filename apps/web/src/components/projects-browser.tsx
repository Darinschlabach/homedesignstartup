'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { projectCover, relativeTime } from '@/lib/format';

export type ProjectListItem = {
  id: string;
  name: string;
  building_type: string;
  status: string;
  updated_at: string;
  shared: boolean;
};

type Filter = 'all' | 'progress' | 'completed' | 'shared';
type ViewMode = 'grid' | 'list';

export function ProjectsBrowser({ projects }: { projects: ProjectListItem[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>('grid');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((project) => {
      if (filter === 'progress' && !(project.status === 'active' || project.status === 'draft')) {
        return false;
      }
      if (filter === 'completed' && project.status !== 'archived') return false;
      if (filter === 'shared' && !project.shared) return false;
      if (q && !project.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [filter, projects, query]);

  return (
    <>
      <div className="projects-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="Project filters">
          {(
            [
              ['all', 'All'],
              ['progress', 'In Progress'],
              ['completed', 'Completed'],
              ['shared', 'Shared'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="filter-tab"
              aria-selected={filter === id}
              data-active={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="projects-tools">
          <label className="projects-search">
            <span className="sr-only">Search projects</span>
            <SearchIcon />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects..."
            />
          </label>
          <div className="view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className="view-toggle-btn"
              data-active={view === 'grid'}
              aria-label="Grid view"
              onClick={() => setView('grid')}
            >
              <GridIcon />
            </button>
            <button
              type="button"
              className="view-toggle-btn"
              data-active={view === 'list'}
              aria-label="List view"
              onClick={() => setView('list')}
            >
              <ListIcon />
            </button>
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty-panel">
          <h3>No projects match</h3>
          <p className="muted">Try another filter or create a new project.</p>
        </div>
      ) : view === 'grid' ? (
        <div className="projects-grid">
          {visible.map((project) => (
            <Link key={project.id} href={`/app/projects/${project.id}`} className="project-tile">
              <div
                className="project-tile-thumb"
                style={{ backgroundImage: `url(${projectCover(project.building_type, project.id)})` }}
              />
              <strong>{project.name}</strong>
              <span>Updated {relativeTime(project.updated_at)}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="projects-list">
          {visible.map((project) => (
            <Link key={project.id} href={`/app/projects/${project.id}`} className="project-row">
              <div
                className="project-row-thumb"
                style={{ backgroundImage: `url(${projectCover(project.building_type, project.id)})` }}
              />
              <div className="project-row-copy">
                <strong>{project.name}</strong>
                <span>Updated {relativeTime(project.updated_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.25" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16.5L20 20.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 7h12M8 12h12M8 17h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="4.5" cy="7" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}
