import React from 'react';
import ReactDOM from 'react-dom/client';
import { JdmConfigProvider } from '@gorules/jdm-editor';
import '@gorules/jdm-editor/dist/style.css';
import './styles.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <JdmConfigProvider>
      <App />
    </JdmConfigProvider>
  </React.StrictMode>,
);
