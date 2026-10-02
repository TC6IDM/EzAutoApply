import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/panel/App';
import '../../src/panel/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
