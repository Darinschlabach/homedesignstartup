'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

const NAV = [
  { href: '/app', label: 'Dashboard', icon: HomeIcon, exact: true },
  { href: '/app/projects', label: 'Projects', icon: FolderIcon },
  { href: '/app/templates', label: 'Templates', icon: TemplateIcon },
  { href: '/app/assistant', label: 'AI Assistant', icon: SparkIcon },
];

const SECONDARY = [
  { href: '/app/notifications', label: 'Notifications', icon: BellIcon },
  { href: '/app/settings', label: 'Settings', icon: GearIcon },
];

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-5v-6H10v6H5a1 1 0 01-1-1v-9.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7.5h6l1.8 2H20.5v9a1 1 0 01-1 1h-15a1 1 0 01-1-1v-10a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}
function TemplateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
      <rect x="13" y="4" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
      <rect x="4" y="13" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
      <rect x="13" y="13" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
function SparkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}
function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9a6 6 0 1112 0c0 4.5 1.5 5.5 1.5 5.5H4.5S6 13.5 6 9z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M10 18.5a2 2 0 004 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.4 6.4l1.4 1.4M16.2 16.2l1.4 1.4M17.6 6.4l-1.4 1.4M7.8 16.2l-1.4 1.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function AppSidebar(props: {
  displayName: string;
  planLabel: string;
  initials: string;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <aside className="studio-sidebar">
      <Link href="/app" className="studio-brand">
        Atelier
      </Link>

      <nav className="studio-nav" aria-label="Main">
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="studio-nav-link"
              data-active={isActive(item.href, item.exact)}
            >
              <Icon />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="studio-sidebar-bottom">
        <nav className="studio-nav" aria-label="Account">
          {SECONDARY.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="studio-nav-link"
                data-active={isActive(item.href)}
              >
                <Icon />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="studio-user">
          <button
            type="button"
            className="studio-user-button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
          >
            <span className="studio-avatar">{props.initials}</span>
            <span className="studio-user-copy">
              <strong>{props.displayName}</strong>
              <span>{props.planLabel}</span>
            </span>
            <span className="studio-user-chevron" aria-hidden>
              ›
            </span>
          </button>
          {menuOpen ? (
            <div className="studio-user-menu">
              <Link href="/app/settings" onClick={() => setMenuOpen(false)}>
                Profile settings
              </Link>
              <Link href="/app/org" onClick={() => setMenuOpen(false)}>
                Organizations
              </Link>
              <form action="/auth/signout" method="post">
                <button type="submit">Sign out</button>
              </form>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
