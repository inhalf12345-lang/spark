import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';
import { unlockSound } from './lib/sounds';

window.addEventListener('pointerdown', unlockSound, { once: true });

const bootLoader = document.getElementById('spark-boot-loader');
if (bootLoader && bootLoader.parentNode) {
  bootLoader.parentNode.removeChild(bootLoader);
}

const rootElement = document.getElementById('root');

if (rootElement) {
  (window as any).__SPARK_MOUNTED__ = true;
  rootElement.innerHTML = '';
  createRoot(rootElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
} else {
  console.error('Fatal: Spark root element #root not found in document.');
}


