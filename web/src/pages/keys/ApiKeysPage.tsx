import { Navigate } from 'react-router';
/** Legacy bookmarks now use owner-scoped product credentials in Settings. */
export function ApiKeysPage() { return <Navigate to="/settings" replace/>; }
