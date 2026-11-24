import { ApiError, imageUrl } from './api';
import type { Product, Poster } from './api';

export type ActiveStage = 'checking' | 'rendering' | 'saving' | 'preview';
export type Stage = ActiveStage | 'ready';
type GenerationEvent =
  | { stage: 'rendering' | 'saving' }
  | { stage: 'saved'; poster: Poster }
  | { stage: 'failed'; error: string };

export async function generatePoster(
  form: Product, templateId: string, requestId: string, onStage: (stage: ActiveStage) => void,
): Promise<Poster> {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60000);
  const interrupted = 'Generation was interrupted. Retry to recover your poster.';
  let shownAt = performance.now();

  // Pace the presentation of confirmed milestones when a local render is very fast.
  // Slow operations stay on their actual stage until the next event arrives.
  async function show(stage: ActiveStage) {
    const remaining = 480 - (performance.now() - shownAt);
    if (remaining > 0) await new Promise(resolve => window.setTimeout(resolve, remaining));
    onStage(stage);
    shownAt = performance.now();
  }
  try {
    const response = await fetch(base + '/api/posters/template', {
      method: 'POST', credentials: 'include', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ ...form, template_id: templateId, request_id: requestId }),
    });
    if (response.status === 401) window.dispatchEvent(new Event('studio-session-ended'));
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new ApiError(problem.error || 'Generation could not start. Please retry.', problem.fields);
    }
    if (!response.body) throw new ApiError(interrupted);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new ApiError(interrupted);
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const event: GenerationEvent = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (event.stage === 'failed') throw new ApiError(event.error);
          if (event.stage === 'rendering' || event.stage === 'saving') {
            await show(event.stage);
          } else if (event.stage === 'saved') {
            await show('preview');
            const preview = new Image();
            preview.src = imageUrl(event.poster.id);
            try {
              await Promise.all([
                loadPreview(preview, controller.signal),
                new Promise(resolve => window.setTimeout(resolve, 480)),
              ]);
            } catch {
              throw new ApiError('Your poster was saved, but the preview could not load. Retry to open it.');
            }
            return event.poster;
          } else {
            throw new ApiError(interrupted);
          }
        }
      }
    } finally { reader.releaseLock(); }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(controller.signal.aborted
      ? 'The studio took too long to respond. Please retry.'
      : 'Connection to the studio was interrupted. Check your connection and retry.');
  } finally {
    window.clearTimeout(timeout);
    controller.abort();
  }
}

function loadPreview(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Timed out'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Timed out'));
    signal.addEventListener('abort', abort, { once: true });
    image.decode().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
