import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app/theme.css';
import { App } from './app/App';
import { registerServiceWorker } from './app/serviceWorker';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html is missing <div id="root">');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
