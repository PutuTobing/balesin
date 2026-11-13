import { configureZodLocale } from '@balesin/shared';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Urutan CSS penting: token → font → gaya dasar, baru kemudian gaya komponen.
import 'virtual:design-tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import { AppProviders } from './app/AppProviders';
import { createQueryClient } from './app/query-client';
import { createAppRouter } from './app/router';

const container = document.getElementById('root');
if (!container) throw new Error('Elemen #root tidak ditemukan di index.html.');

// Pesan validasi bawaan Zod berbahasa Indonesia (cadangan bila skema tidak punya pesan sendiri).
configureZodLocale();

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });

createRoot(container).render(
  <StrictMode>
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
