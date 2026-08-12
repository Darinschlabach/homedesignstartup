import Link from 'next/link';
import { Button } from '@aihd/ui';

export default function AssistantPage() {
  return (
    <main className="dash">
      <header className="dash-header">
        <div>
          <h1>AI Assistant</h1>
          <p className="muted">Talk to an architect inside any project workspace.</p>
        </div>
      </header>
      <div className="empty-panel">
        <h3>Open a project to start designing</h3>
        <p className="muted">
          The assistant lives next to your floor plan and 3D model so every change stays grounded in the building.
        </p>
        <Link href="/app/projects">
          <Button>Go to projects</Button>
        </Link>
      </div>
    </main>
  );
}
