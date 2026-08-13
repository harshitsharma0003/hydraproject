import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import App from './App';
import Login from './pages/Login';
import Sites from './pages/Sites';
import Rules from './pages/Rules';
import Queries from './pages/Queries';
import Usage from './pages/Usage';
import Syncs from './pages/Syncs';
import Environments from './pages/Environments';
import Billing from './pages/Billing';
import Landing from './pages/Landing';
import Signup from './pages/Signup';
import Users from './pages/Users';
import Audit from './pages/Audit';
import AcceptInvite from './pages/AcceptInvite';
import Forgot from './pages/Forgot';
import Reset from './pages/Reset';
import { ToastProvider } from './Toast';
import './styles.css';

const Private = ({ children }) =>
  localStorage.getItem('algivo_token') ? children : <Navigate to="/login" replace />;

// The root path is the public marketing homepage for logged-out visitors and
// the console for signed-in users. Reading the token inside a component (not
// once at module load) means it re-evaluates on every navigation, so logging in
// swaps the landing for the dashboard without a full reload.
const Root = () =>
  localStorage.getItem('algivo_token') ? <App /> : <Landing />;

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <ToastProvider>
    <Routes>
      <Route path="/welcome" element={<Landing />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/accept" element={<AcceptInvite />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route path="/reset" element={<Reset />} />
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Root />}>
        <Route index element={<Environments />} />
        <Route path="sites" element={<Sites />} />
        <Route path="billing" element={<Billing />} />
        <Route path="users" element={<Users />} />
        <Route path="audit" element={<Audit />} />
        <Route path="rules" element={<Rules />} />
        <Route path="queries" element={<Queries />} />
        <Route path="syncs" element={<Syncs />} />
        <Route path="usage" element={<Usage />} />
      </Route>
    </Routes>
    </ToastProvider>
  </BrowserRouter>
);
