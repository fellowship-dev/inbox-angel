import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { expect, it } from 'vitest';
import { ApiKeysPage } from '../src/pages/keys/ApiKeysPage';
import { renderApp } from './render';
it('redirects legacy key bookmarks to scoped access settings without requesting broad keys', async () => {
    const { calls } = renderApp(<Routes><Route path="/keys" element={<ApiKeysPage />}/><Route path="/settings" element={<h1>Scoped access settings</h1>}/></Routes>, { route: '/keys' });
    expect(await screen.findByRole('heading', { name: 'Scoped access settings' })).toBeInTheDocument();
    expect(calls.some(c => c.path.startsWith('/api/keys'))).toBe(false);
});
