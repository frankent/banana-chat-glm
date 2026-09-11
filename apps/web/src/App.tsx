import { MeetingsPage } from "./pages/MeetingsPage";
import { PublicMeetingPage } from "./pages/PublicMeetingPage";
import { CallProvider } from "./components/calls/CallProvider";
import { BoardPage } from "./pages/BoardPage";
import { unlockNotificationAudio } from "./lib/notification-audio";
import { unreadTitle } from "@banana-chat/chat-core";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { EchoProvider } from "./echo/EchoProvider";
import { AiAssistantView } from "./components/ai/AiAssistantView";
import { AppShell, WelcomeView } from "./components/AppShell";
import { ChatView } from "./components/ChatView";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { LoginPage } from "./pages/LoginPage";
import { NoWorkspacePage } from "./pages/NoWorkspacePage";
import { MembersPage } from "./pages/MembersPage";
import { SearchPage } from "./pages/SearchPage";
import { useSession } from "./state/session";

import { queryClient } from "./lib/query-client";

function SessionGate({ children }: { children: React.ReactNode }) {
  const { bootstrap, workspaces, status } = useSession();
  useEffect(() => {
    document.title = unreadTitle(status === "authenticated" ? workspaces : []);
  }, [workspaces, status]);
  useEffect(() => {
    const unlock = (event: Event) => {
      if (event.isTrusted) unlockNotificationAudio();
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);
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
          <Routes>
            <Route path="/meet/:code" element={<PublicMeetingPage />} />
            <Route
              path="*"
              element={
                <EchoProvider>
                  <CallProvider>
                    <Routes>
                      <Route path="/login" element={<LoginPage />} />
                      <Route
                        path="/change-password"
                        element={<ChangePasswordPage />}
                      />
                      <Route
                        path="/no-workspace"
                        element={<NoWorkspacePage />}
                      />
                      <Route element={<AppShell />}>
                        <Route index element={<WelcomeView />} />
                        <Route path="/meetings" element={<MeetingsPage />} />
                        <Route path="/board" element={<BoardPage />} />
                        <Route
                          path="/board/:ticketId"
                          element={<BoardPage />}
                        />
                        <Route path="/rooms/:roomId" element={<ChatView />} />
                        <Route path="/members" element={<MembersPage />} />
                        <Route path="/search" element={<SearchPage />} />
                        <Route path="/ai" element={<AiAssistantView />} />
                        <Route
                          path="/ai/:conversationId"
                          element={<AiAssistantView />}
                        />
                      </Route>
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </CallProvider>
                </EchoProvider>
              }
            />
          </Routes>
        </SessionGate>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
