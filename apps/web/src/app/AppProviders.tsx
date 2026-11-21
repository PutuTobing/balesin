import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BrandProvider } from '../brand/BrandProvider';
import { BrandTheme } from '../brand/BrandTheme';
import { TooltipProvider } from '../components/ui/Tooltip';
import { ThemeProvider } from '../theme/ThemeProvider';

/** Penyedia tingkat aplikasi: data server, merek (white-label), tema, tooltip. */
export function AppProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrandProvider>
        <ThemeProvider>
          {/* Warna utama organisasi → token aksen tema yang sedang tampil. */}
          <BrandTheme />
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </BrandProvider>
    </QueryClientProvider>
  );
}
