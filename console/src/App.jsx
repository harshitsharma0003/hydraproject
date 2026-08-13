import { NavLink, Outlet, useNavigate } from 'react-router-dom';

export default function App() {
  const nav = useNavigate();
  const logout = () => { localStorage.removeItem('hydra_token'); nav('/login'); };

  return (
    <div className="shell">
      <aside>
        <div className="brand">Hydra</div>
        <nav>
          <NavLink to="/" end>Sites</NavLink>
          <NavLink to="/queries">Queries</NavLink>
          <NavLink to="/rules">Rules</NavLink>
          <NavLink to="/syncs">Syncs</NavLink>
          <NavLink to="/usage">Usage</NavLink>
        </nav>
        <button className="link" onClick={logout}>Sign out</button>
      </aside>
      <main><Outlet /></main>
    </div>
  );
}
