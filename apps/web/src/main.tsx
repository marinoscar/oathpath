import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CssBaseline } from '@mui/material';
import App from './App';
import { registerServiceWorker } from './sw/registerServiceWorker';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <CssBaseline />
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// Issue #359, epic #345. AFTER the render call, not before: registration is a
// network fetch plus an install that precaches the shell, and doing it first
// would put that work in front of the first paint for no benefit — the worker
// controls the NEXT navigation, never this one.
//
// Self-gating: this is a no-op in test and in dev unless `VITE_ENABLE_SW=true`.
// See `sw/registerServiceWorker.ts` for why each of those is off.
void registerServiceWorker();
