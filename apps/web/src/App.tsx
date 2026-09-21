import { MeetingsPage } from "./pages/MeetingsPage";
import { PublicMeetingPage } from "./pages/PublicMeetingPage";
import { PublicChatVisitorPage } from "./pages/PublicChatVisitorPage";
import { JoinInvitePage } from "./pages/JoinInvitePage";
import { PublicChatListPage } from "./pages/PublicChatListPage";
import { PublicChatRoomPage } from "./pages/PublicChatRoomPage";
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
  const { bootstrap, workspaces, status, currentWorkspace } = useSession();
  useEffect(() => {
    document.title = unreadTitle(
      status === "authenticated" ? workspaces : [],
      status === "authenticated" ? currentWorkspace?.workspace.name : null,
    );
  }, [workspaces, status, currentWorkspace]);
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
            {/*
              FR-PCHAT-007 — the public visitor page is a SIBLING of /meet/:code
              and lives OUTSIDE both <EchoProvider> and <CallProvider>. That is
              the structural guarantee that a support conversation can never
              offer a call or a meeting on the client: <CallButtons/> cannot
              mount in a subtree with no call context. Do not move it inside.
            */}
            <Route path="/support/:code" element={<PublicChatVisitorPage />} />
            {/*
              FR-AUTH-008/FR-WS-006 (DEC-081) — a brand-new person has no
              account and no session yet, so this is a SIBLING of /meet/:code
              and /support/:code, outside both providers, for the same reason.
            */}
            <Route path="/join/:token" element={<JoinInvitePage />} />
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
                        {/* FR-PCHAT-004/006 — the agent queue and one conversation. */}
                        <Route
                          path="/public-chat"
                          element={<PublicChatListPage />}
                        />
                        <Route
                          path="/public-chat/:roomId"
                          element={<PublicChatRoomPage />}
                        />
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
