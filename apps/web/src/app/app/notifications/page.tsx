export default function NotificationsPage() {
  return (
    <main className="dash">
      <header className="dash-header">
        <div>
          <h1>Notifications</h1>
          <p className="muted">Project shares, render completions, and team activity.</p>
        </div>
      </header>
      <div className="empty-panel">
        <h3>You&apos;re all caught up</h3>
        <p className="muted">New notifications will show here as your studio grows.</p>
      </div>
    </main>
  );
}
