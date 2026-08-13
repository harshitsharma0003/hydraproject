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
import './styles.css';

const Private = ({ children }) =>
  localStorage.getItem('hydra_token') ? children : <Navigate to="/login" replace />;

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/welcome" element={<Landing />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Private><App /></Private>}>
        <Route index element={<Environments />} />
        <Route path="sites" element={<Sites />} />
        <Route path="billing" element={<Billing />} />
        <Route path="rules" element={<Rules />} />
        <Route path="queries" element={<Queries />} />
        <Route path="syncs" element={<Syncs />} />
        <Route path="usage" element={<Usage />} />
      </Route>
    </Routes>
  </BrowserRouter>
);
