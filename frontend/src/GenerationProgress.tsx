import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import type { Stage } from './generation';

const demoSteps = ['demo-brief', 'demo-artwork', 'demo-layout', 'demo-preview'] as const;
type DemoStage = typeof demoSteps[number] | 'demo-idle' | 'demo-done';
export type ProgressStage = Stage | DemoStage;

export async function previewAiProgress(show: (stage: DemoStage) => void) {
  for (const step of demoSteps) {
    show(step);
    await new Promise(resolve => window.setTimeout(resolve, 800));
  }
  show('demo-done');
}

const stages: Record<ProgressStage, { label: string; completed: number }> = {
  'demo-idle': { label: 'Ready to preview AI progress', completed: 0 },
  'demo-brief': { label: 'Preparing the prompt', completed: 0 },
  'demo-artwork': { label: 'Generating artwork', completed: 1 },
  'demo-layout': { label: 'Composing the poster', completed: 2 },
  'demo-preview': { label: 'Preparing the preview', completed: 3 },
  'demo-done': { label: 'Progress demo complete', completed: 4 },
  checking: { label: 'Checking product details', completed: 0 },
  rendering: { label: 'Laying out your poster', completed: 1 },
  saving: { label: 'Saving to your library', completed: 2 },
  preview: { label: 'Opening the preview', completed: 3 },
  ready: { label: 'Poster ready', completed: 4 },
};

export function GenerationProgress({ stage, error }: { stage: ProgressStage; error: string }) {
  const { label, completed } = stages[stage];
  const ready = completed === 4;
  const idle = stage === 'demo-idle';
  const Icon = error ? CircleAlert : ready ? CircleCheck : LoaderCircle;
  const title = error ? 'Stopped · ' + label : label;
  return <div className={'job-progress' + (error ? ' failed' : '')}>
    <div className="job-heading"><strong role="status">{!idle && <Icon aria-hidden="true" size={17} className={error || ready ? '' : 'spin'}/>}{title}</strong>
      <span aria-hidden="true">{completed * 25}%</span></div>
    <div className="job-track" role="progressbar" aria-label={stage.startsWith('demo-') ? 'AI progress demo' : 'Poster generation'} aria-valuemin={0}
      aria-valuemax={100} aria-valuenow={completed * 25} aria-valuetext={title}>
      <div style={{width: completed * 25 + '%'}}/>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
