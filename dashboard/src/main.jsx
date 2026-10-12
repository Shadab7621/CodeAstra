import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionGlobalConfig } from 'framer-motion';
import App from './App';
import './styles.css';

// ?motion=off shows every screen in its final state at once. Useful for screenshots, and for
// a projector or a slow machine where animation would only get in the way.
if (new URLSearchParams(window.location.search).get('motion') === 'off') {
  MotionGlobalConfig.skipAnimations = true;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
