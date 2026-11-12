import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { TooltipProvider } from '../components/ui/Tooltip';
import { ThemeProvider } from '../theme/ThemeProvider';
import { createQueryClient } from './query-client';

/** Penyedia tingkat aplikasi: data server, tema, tooltip. */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
