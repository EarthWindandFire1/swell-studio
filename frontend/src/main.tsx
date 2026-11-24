import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, Check, ChevronDown, Download, Expand, Image as ImageIcon, Layers2, LoaderCircle, PanelsTopLeft, SlidersHorizontal, Sparkles, Trash2, Waves, X } from 'lucide-react';
import '@fontsource-variable/dm-sans';
import '@fontsource/dm-serif-text/latin-400.css';
import '@fontsource/dm-serif-text/latin-400-italic.css';
import { api, ApiError, imageUrl, sample, validate } from './api';
import type { Product, Poster, FieldErrors } from './api';
import { generatePoster } from './generation';
import type { ProgressStage } from './GenerationProgress';
import { AccountGate } from './AccountGate';
import { GenerationProgress, previewAiProgress } from './GenerationProgress';
import './style.css';

import catalog from '../../templates.json';

const availableTemplates = catalog.filter(style => !style.archived);
const imageBase = import.meta.env.BASE_URL;
const sampleFor = (id: string) => id === 'ocean-breeze' ? imageBase + 'sample.png' : imageBase + 'templates/' + id + '-sample.webp';
const message = (err: unknown) => err instanceof Error ? err.message : 'Something went wrong. Please try again.';
type Preview = { src: string; name: string; id?: number };

function Lightbox({ item, close }: { item: Preview; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} aria-label={item.name} onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="lightbox"><div className="box-head"><strong>{item.name}</strong><button autoFocus className="icon-btn" aria-label="Close preview" onClick={close}><X/></button></div>
      <img src={item.src} alt={item.name + ' poster'}/>
      {item.id && <a className="text-link" href={imageUrl(item.id) + '?download=1'}><Download size={16}/>Download PNG</a>}
    </div>
  </dialog>;
}

function DeletePoster({ poster, cancel, removed }: { poster: Poster; cancel: () => void; removed: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  async function confirmDelete() {
    setPending(true); setError('');
    try {
      await api('/api/posters/' + poster.id, { method: 'DELETE' });
      removed();
    } catch (err) { setError(message(err)); setPending(false); }
  }
  return <dialog ref={ref} className="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description"
    onCancel={e => { e.preventDefault(); if (!pending) cancel(); }}>
    <h2 id="delete-title">Delete poster?</h2>
    <p id="delete-description">“{poster.product}” will be permanently removed from your library.</p>
    {error && <div className="alert" role="alert">{error}</div>}
    <div className="delete-actions"><button autoFocus className="secondary" disabled={pending} onClick={cancel}>Cancel</button>
      <button className="delete-confirm" disabled={pending} onClick={() => void confirmDelete()}>{pending ? 'Deleting…' : 'Delete poster'}</button></div>
  </dialog>;
}

function Library({ open, onRemoved }: { open: (item: Preview) => void; onRemoved: (id: number) => void }) {
  const [target, setTarget] = useState<Poster | null>(null);
  const [items, setItems] = useState<Poster[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  async function load(before?: number, signal?: AbortSignal) {
    setBusy(true); setError('');
    try {
      const page = await api<{ items: Poster[]; next: number | null }>('/api/posters' + (before ? '?before=' + before : ''), { signal });
      if (!signal?.aborted) { setItems(old => before ? [...old, ...page.items] : page.items); setNext(page.next); }
    } catch (err) { if (!signal?.aborted) setError(message(err)); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  useEffect(() => { const ctl = new AbortController(); void load(undefined, ctl.signal); return () => ctl.abort(); }, []);
  return <>
    <div className="intro"><div><h1>Poster <em>library.</em></h1><p>Your saved product posters, newest first.</p></div></div>
    {items.length > 0 && <div className="gallery">{items.map(item => <article key={item.id} className="gallery-item"><button className="open-poster" onClick={() => open({src:imageUrl(item.id), name:item.product, id:item.id})}>
      <img loading="lazy" src={imageUrl(item.id)} alt={item.product + ' poster'}/><div className="gallery-copy"><small>{item.brand}</small><strong>{item.product}</strong><span>{catalog.find(t => t.id === item.template_id)?.name} · {new Date(item.created_at).toLocaleDateString()} · USD {item.price}</span></div>
    </button><button className="remove-poster" aria-label={'Delete ' + item.product} onClick={() => setTarget(item)}><Trash2 size={15}/>Delete</button></article>)}</div>}
    {target && <DeletePoster poster={target} cancel={() => setTarget(null)} removed={() => {
      setItems(old => old.filter(item => item.id !== target.id)); setTarget(null); onRemoved(target.id);
      if (items.length === 1 && next) void load(next);
    }}/>}
    {!items.length && !next && !busy && !error && <div className="empty"><Archive/><h2>Your library is ready</h2><p>Generate your first poster to save it here.</p><a className="text-link" href="#studio">Open studio</a></div>}
    {error && <div className="alert" role="alert">{error} <button onClick={() => void load(next ?? undefined)}>Try again</button></div>}
    {busy && <p className="loading" role="status"><LoaderCircle className="spin"/>Loading posters…</p>}
    {!busy && !error && next && <button className="secondary more" onClick={() => void load(next)}>Load more</button>}
  </>;
}

function App({ email, signOut }: { email: string | null; signOut: () => Promise<void> }) {
  const [library, setLibrary] = useState(location.hash === '#library');
  useEffect(() => {
    const change = () => { setLibrary(location.hash === '#library'); window.scrollTo(0,0); };
    window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change);
  }, []);
  const [form, setForm] = useState<Product>({...sample});
  const [mode, setMode] = useState<'template' | 'ai'>('template');
  const [template, setTemplate] = useState(availableTemplates[0]);
  const [result, setResult] = useState<Poster | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState('');
  const [stage, setStage] = useState<ProgressStage | null>(null);
  const [lightbox, setLightbox] = useState<Preview | null>(null);
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const previewRef = useRef<HTMLElement>(null);
  const item = result ? { src:imageUrl(result.id), name:result.product, id:result.id } : { src:sampleFor(template.id), name:template.name + ' sample' };

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    const issues = validate(form);
    setErrors(issues); setError(''); setStage(null);
    if (Object.keys(issues).length) {
      document.getElementById(Object.keys(issues)[0])?.focus();
      return;
    }
    setBusy(true); inFlight.current = true;
    try {
      if (mode === 'ai') {
        await previewAiProgress(setStage);
        return;
      }
      setStage('checking');
      requestId.current ??= crypto.randomUUID();
      const poster = await generatePoster(form, template.id, requestId.current, setStage);
      setResult(poster); setStage('ready'); requestId.current = null;
      if (window.matchMedia('(max-width: 700px)').matches) {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        previewRef.current?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
      }
    } catch (err) { setError(message(err)); if (err instanceof ApiError) {
        setErrors(err.fields);
        const field = Object.keys(err.fields)[0];
        if (field) requestAnimationFrame(() => document.getElementById(field)?.focus());
      } }
    finally { setBusy(false); inFlight.current = false; }
  }

  function selectMode(next: 'template' | 'ai') {
    if (mode !== next) { setMode(next); setStage(null); setError(''); }
  }

  function field(key: keyof Product, label: string, max?: number) {
    const props = { id:key, name:key, value:form[key], required:true, disabled:busy,
      'aria-invalid':!!errors[key], 'aria-describedby':errors[key] ? key+'-error' : undefined,
      onChange:(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setForm({...form, [key]:e.target.value}); setErrors({...errors,[key]:undefined}); setError(''); setStage(null); requestId.current=null;
      }
    };
    return <div className="field"><div className="field-label"><label htmlFor={key}>{label}</label>
      {key === 'description' && <span>{Array.from(form.description).length} / {max}</span>}</div>
      {key === 'description' ? <textarea {...props} rows={3} maxLength={max}/> : key === 'price' ?
      <div className="price"><span>$</span><input {...props} autoComplete="off" inputMode="decimal"/><span>USD</span></div> :
      <input {...props} maxLength={max}/>}
      {errors[key] && <small className="field-error" id={key+'-error'}>{errors[key]}</small>}
    </div>;
  }

  return <><header className="topbar"><div className="top-inner">
    <a className="brand" href="#studio" aria-label="Swell Studio home"><span className="logo"><Waves size={25} strokeWidth={2.3}/></span>Swell<span className="brand-light">Studio</span></a>
    <nav aria-label="Workspace"><a href="#studio" aria-current={!library?'page':undefined}><PanelsTopLeft size={16}/>Studio</a><a href="#library" aria-current={library?'page':undefined}><Archive size={16}/>Library</a></nav>
    <button className="session-exit" disabled={busy} title={email ?? "Guest workspace"} onClick={() => void signOut()}>{email ? 'Sign out' : 'Exit guest'}</button>
  </div></header>
  <main>{library ? <Library key={result?.id} open={setLightbox} onRemoved={id => {
    if (result?.id === id) { setResult(null); setStage(null); }
  }}/> : <>
    <div className="intro"><div><h1>Poster <em>workshop.</em></h1><p>Turn your product details into a ready-to-share campaign poster.</p></div>
    </div>
    <div className="workspace">
      <section className="card editor"><div className="section-head"><SlidersHorizontal size={18}/><h2>Product details</h2></div>
        <form noValidate onSubmit={generate}>
          {field('brand','Brand name',40)}{field('product','Product name',60)}{field('description','Description',200)}{field('price','Price')}
          <div className="generation-controls">
            <div className="mode-switch" role="group" aria-label="Generation mode">
              <button type="button" disabled={busy} aria-pressed={mode === 'template'} onClick={() => selectMode('template')}><Layers2 size={16}/>Templates</button>
              <button type="button" disabled={busy} aria-pressed={mode === 'ai'} onClick={() => selectMode('ai')}><Sparkles size={16}/>AI generation</button>
            </div>
            {mode === 'template' ? <div className="field">
              <div className="field-label"><label htmlFor="poster-template">Poster template</label></div>
              <div className="template-select">
                <select id="poster-template" value={template.id} disabled={busy} onChange={event => {
                  const selected = availableTemplates.find(style => style.id === event.target.value);
                  if (!selected) return;
                  setTemplate(selected); setResult(null); setStage(null); setError(''); requestId.current = null;
                }}>
                  {availableTemplates.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
                </select>
                <ChevronDown size={16} aria-hidden="true"/>
              </div>
            </div> : <p className="ai-notice" role="status">Preview the AI workflow with simulated progress. The model is not connected.</p>}
            {mode === 'ai' && <GenerationProgress stage={stage ?? 'demo-idle'} error={error}/>}
            {mode === 'template' && error && <div className="alert" role="alert">{error}</div>}
            <button type="submit" disabled={busy} className="generate">
              {busy ? <LoaderCircle className="spin" size={18}/> : <Sparkles size={18}/>}
              {mode === 'ai'
                ? (busy ? 'Running demo…' : stage === 'demo-done' ? 'Replay AI progress' : 'Preview AI progress')
                : (busy ? 'Generating poster…' : error ? 'Retry generation' : 'Generate poster')}
            </button>
          </div>
        </form>
      </section>
      <section ref={previewRef} className="card preview"><div className="section-head"><Layers2 size={19}/><h2>Poster preview</h2><button className="icon-btn expand" aria-label="Enlarge poster" onClick={() => setLightbox(item)}><Expand size={17}/></button></div>
        <div className={'stage'+(busy && mode === 'template'?' rendering':'')} aria-busy={busy && mode === 'template'}><div className="paper"><img key={item.src} src={item.src} alt={item.name+' marketing poster'}/></div>
          {busy && mode === 'template' && <div className="rendering-label"><LoaderCircle className="spin" size={18}/>Generating…</div>}
        </div>
        <div className="preview-foot"><div className="asset-meta">{result?<Check size={17}/>:<ImageIcon size={17}/>}<div><strong aria-live="polite">{result?'Saved to library':'Template sample'}</strong><small>794 × 794 px · PNG</small></div></div>
          {result ? <a className="text-link" href={imageUrl(result.id)+'?download=1'}><Download size={16}/>Download</a> : null}
        </div>
      </section>
    </div>
  </>}</main>{lightbox && <Lightbox item={lightbox} close={() => setLightbox(null)}/>}</>;
}
createRoot(document.getElementById('root')!).render(<AccountGate>{(user, signOut) => <App key={user.id} email={user.email} signOut={signOut}/>}</AccountGate>);

