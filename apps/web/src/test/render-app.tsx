import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { AppProviders } from '../app/AppProviders';
import { createAppRouter } from '../app/router';
import { t } from '../i18n/id';

/** Render aplikasi utuh (penyedia + router + kerangka) pada alamat tertentu. */
export async function renderApp(path = '/') {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  const view = render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await screen.findByRole('navigation', { name: t.nav.label });
  return { router, ...view };
}
