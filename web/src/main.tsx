import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { purgeLegacyToken } from './lib/api';
import { createQueryClient } from './lib/query';
import { captureSignupIntent } from './lib/signup-intent';
import './app.css';

purgeLegacyToken();

// `/signup?domain=…` from the website: keep the domain as a prefill and show the fixed sign-up address (the input is never echoed into the URL).
const signupUrl = captureSignupIntent(window.location);
if (signupUrl) window.history.replaceState(null, '', signupUrl);

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App queryClient={createQueryClient()} />
	</StrictMode>,
);
