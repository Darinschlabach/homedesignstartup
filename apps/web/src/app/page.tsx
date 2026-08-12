import Link from 'next/link';
import { Button } from '@aihd/ui';

export default function HomePage() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Atelier</div>
        <nav style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <Link href="/login" className="muted">
            Sign in
          </Link>
          <Link href="/signup">
            <Button>Start designing</Button>
          </Link>
        </nav>
      </header>
      <section className="hero">
        <div className="hero-content">
          <h1>Atelier</h1>
          <p>
            Describe the home, barn, or shop you want. Collaborate with an AI architect on floor
            plans, editable 3D, and construction-ready documents.
          </p>
          <div className="hero-actions">
            <Link href="/signup">
              <Button>Open your studio</Button>
            </Link>
            <Link href="/login">
              <Button variant="secondary">I already have an account</Button>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
