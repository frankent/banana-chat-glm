import type { CallJoin } from "@banana-chat/shared";
import { endpoints } from "../../lib/api";
import { useSession } from "../../state/session";
import MediaPanel from "./MediaPanel";
export default function CallPanel({
  active,
  onLeave,
  registerDisconnect,
}: {
  active: CallJoin & { slug: string };
  onLeave: (end?: boolean) => void;
  registerDisconnect: (fn: () => void) => void;
}) {
  const { me } = useSession();
  return (
    <MediaPanel
      id={active.call.id}
      kind={active.call.kind}
      title={active.call.room_name || active.call.caller_name || "Call"}
      url={active.url}
      token={active.token}
      canEnd={active.call.started_by === me?.id}
      onLeave={onLeave}
      registerDisconnect={registerDisconnect}
      // FR-CALL-009 / DEC-086: MediaPanel rejoins backgrounded drops with fresh
      // credentials; join is idempotent for the same session and re-issues the
      // media token, and a 409 "Call ended." stops the rejoin.
      refreshCredentials={async () => endpoints.joinCall(active.call.id, active.slug)}
      checkActive={async () =>
        (await endpoints.calls(active.slug)).calls.some(
          (c) => c.id === active.call.id,
        )
      }
    />
  );
}
