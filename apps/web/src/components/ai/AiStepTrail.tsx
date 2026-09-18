import type { ReactElement } from 'react';
import type { AiToolStep } from '@banana-chat/shared';

/**
 * The answer as it is being written, with the agent's steps sitting where they
 * happened. A step arrives with `at_char` — how much of the answer existed at
 * the time — so the text splits around it instead of the cards piling up at the
 * top, which is what makes an agent read like it is working rather than stalling.
 */
export function AiStepTrail({ text, steps }: { text: string; steps: AiToolStep[] }) {
  if (steps.length === 0) {
    return <>{text}</>;
  }

  // at_char comes from PHP mb_strlen, which counts code points; a JS string
  // index counts UTF-16 units, so one 🍒 earlier in the answer would shift the
  // card and could slice a surrogate pair in half. Count the same units.
  const chars = Array.from(text);
  const ordered = [...steps].sort((a, b) => a.at_char - b.at_char);
  const parts: ReactElement[] = [];
  let cursor = 0;

  ordered.forEach((step, i) => {
    const at = Math.min(Math.max(step.at_char, 0), chars.length);
    const segment = chars.slice(cursor, at).join('');
    if (segment !== '') {
      parts.push(<span key={`t${i}`}>{segment}</span>);
    }
    cursor = at;
    parts.push(<AiStepCard key={step.id} step={step} />);
  });

  const tail = chars.slice(cursor).join('');
  if (tail !== '') {
    parts.push(<span key="tail">{tail}</span>);
  }

  return <>{parts}</>;
}

function AiStepCard({ step }: { step: AiToolStep }) {
  const done = step.status === 'completed';

  return (
    <span
      className="my-1 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600"
      data-testid="ai-step"
      data-status={step.status}
    >
      <span aria-hidden>{step.emoji ?? '⚙'}</span>
      <span className="font-sans font-semibold text-slate-500">{step.tool}</span>
      {/* agent-supplied text: React escapes it, and it never becomes markup */}
      <span className="min-w-0 flex-1 truncate" title={step.label ?? undefined}>{step.label}</span>
      <span className={done ? 'text-emerald-600' : 'animate-pulse text-amber-500'}>{done ? '✓' : '●'}</span>
    </span>
  );
}

/**
 * After the answer is finished it renders as one markdown block, so the steps
 * can no longer sit between its words. They stay underneath instead — the work
 * is still worth seeing once it is done.
 */
export function AiStepSummary({ steps }: { steps: AiToolStep[] }) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <div className="mt-1 flex flex-col gap-0.5" data-testid="ai-step-summary">
      {steps.map(step => (
        <span key={step.id} className="flex items-center gap-1.5 font-mono text-[10px] text-slate-400">
          <span aria-hidden>{step.emoji ?? '⚙'}</span>
          <span className="font-sans">{step.tool}</span>
          <span className="min-w-0 truncate" title={step.label ?? undefined}>{step.label}</span>
          <span className={step.status === 'completed' ? 'text-emerald-500' : 'text-amber-500'}>
            {step.status === 'completed' ? '✓' : '●'}
          </span>
        </span>
      ))}
    </div>
  );
}
