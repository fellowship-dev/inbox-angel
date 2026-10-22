import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { createQueryClient } from './lib/query';
import './app.css';

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App queryClient={createQueryClient()} />
	</StrictMode>,
);
