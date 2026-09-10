import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { EchoProvider } from './echo/EchoProvider';
import { AiAssistantView } from './components/ai/AiAssistantView';
import { AppShell } from './components/AppShell';
import { ChatView } from './components/ChatView';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { LoginPage } from './pages/LoginPage';
import { NoWorkspacePage } from './pages/NoWorkspacePage';
import { SearchPage } from './pages/SearchPage';
import { useSession } from './state/session';

import { queryClient } from './lib/query-client';

function SessionGate({ children }: { children: React.ReactNode }) {
  const { bootstrap } = useSession();
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionGate>
          <EchoProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/change-password" element={<ChangePasswordPage />} />
              <Route path="/no-workspace" element={<NoWorkspacePage />} />
              <Route element={<AppShell />}>
                <Route index element={<Navigate to="/" replace />} />
                <Route path="/rooms/:roomId" element={<ChatView />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/ai" element={<AiAssistantView />} />
                <Route path="/ai/:conversationId" element={<AiAssistantView />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </EchoProvider>
        </SessionGate>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
