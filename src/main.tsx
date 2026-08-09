import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { initStore, startStorePersistence } from './db/storeInit';

async function bootstrap(): Promise<void> {
  // 1) Hydrate in-memory Zustand store from IndexedDB
  //    (also runs one-time localStorage → IndexedDB migration)
  await initStore();

  // 2) Start subscribing to store changes and persist to IndexedDB
  startStorePersistence();

  // 3) Render the app
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
