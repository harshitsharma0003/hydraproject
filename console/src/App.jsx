import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import Logo from './Logo';

export default function App() {
  const nav = useNavigate();
  const logout = () => { localStorage.removeItem('algivo_token'); nav('/login'); };

  return (
    <div className="shell">
      <aside>
        <div className="brand"><Logo size={26} /></div>
        <nav>
          <NavLink to="/" end>Environments</NavLink>
          <NavLink to="/sites">Sites</NavLink>
          <NavLink to="/queries">Queries</NavLink>
          <NavLink to="/rules">Rules</NavLink>
          <NavLink to="/syncs">Syncs</NavLink>
          <NavLink to="/usage">Usage</NavLink>
          <NavLink to="/billing">Billing</NavLink>
          <NavLink to="/users">Users</NavLink>
          <NavLink to="/audit">Audit</NavLink>
        </nav>
        <button className="link" onClick={logout}>Sign out</button>
      </aside>
      <main><Outlet /></main>
    </div>
  );
}
