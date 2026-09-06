import { useEcho } from '../echo/EchoProvider';

export function ConnectionBanner() {
  const { echo, connected } = useEcho();
  if (echo === null || connected) {
    return null;
  }
  return (
    <div className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-800">
      Connection lost — reconnecting…
    </div>
  );
}
