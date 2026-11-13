import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { act, render } from '@testing-library/react';
import { AppProviders } from '../app/AppProviders';
import { createAppRouter } from '../app/router';
import { installFakeApi, type FakeApiOptions } from './fake-api';
import { createTestQueryClient } from './query-client';

/**
 * Render aplikasi utuh (penyedia + router + kerangka) pada alamat tertentu, dengan API tiruan
 * (bawaan: Owner sudah masuk). Menunggu sampai router selesai memuat rute pertama.
 */
export async function renderApp(path = '/', api: FakeApiOptions = {}) {
  const fake = installFakeApi(api);
  const queryClient = createTestQueryClient();
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await act(() => router.load());
  return { router, queryClient, api: fake, ...view };
}
