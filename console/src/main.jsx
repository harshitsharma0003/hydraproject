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
import './styles.css';

const Private = ({ children }) =>
  localStorage.getItem('hydra_token') ? children : <Navigate to="/login" replace />;

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Private><App /></Private>}>
        <Route index element={<Sites />} />
        <Route path="rules" element={<Rules />} />
        <Route path="queries" element={<Queries />} />
        <Route path="syncs" element={<Syncs />} />
        <Route path="usage" element={<Usage />} />
      </Route>
    </Routes>
  </BrowserRouter>
);
