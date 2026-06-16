import { navItems } from '../../data/mockData'
import type { ScreenId, WithChildren } from '../../types'

type AppShellProps = WithChildren & {
  activeScreen: ScreenId
  onNavigate: (screen: ScreenId) => void
}

export function AppShell({
  activeScreen,
  children,
  onNavigate,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <img
            alt="AUTOPAL logo"
            className="brand-logo"
            src="/autopal-logo.png"
          />
          <div>
            <p className="brand-kicker">AUTOPAL</p>
            <h1 className="brand-title">PI System</h1>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary navigation">
          {navItems.map((item) => (
            <button
              className={`nav-button ${activeScreen === item.id ? 'active' : ''}`}
              key={item.id}
              onClick={() => onNavigate(item.id)}
              type="button"
            >
              <span>{item.label}</span>
              <small>{item.meta}</small>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="status-dot"></span>
          <div>
            <strong>Frontend only</strong>
            <span>Mock data workspace</span>
          </div>
        </div>
      </aside>

      <main className="content-shell">{children}</main>
    </div>
  )
}
