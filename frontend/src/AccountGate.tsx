import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { LoaderCircle, RefreshCw, Waves } from 'lucide-react';
import { api } from './api';

type User = { id: number; email: string | null };
type Captcha = { id: string; image: string };
const request = (body: object): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const describe = (err: unknown) => err instanceof Error ? err.message : 'Please try again.';

export function AccountGate({ children }: { children: (user: User, signOut: () => Promise<void>) => ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const refresh = useCallback(async () => {
    const version = ++revision.current;
    try {
      const result = await api<{ user: User | null }>('/api/auth/me');
      if (version === revision.current) { setUser(result.user); setError(''); }
    } catch (err) { if (version === revision.current) setError(describe(err)); }
    finally { if (version === revision.current) setChecking(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const ended = () => { ++revision.current; setUser(null); setChecking(false); setError(''); };
    window.addEventListener('studio-session-ended', ended);
    const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('swell-auth') : null;
    channel.current = bus;
    if (bus) bus.onmessage = () => void refresh();
    return () => { bus?.close(); channel.current=null; window.removeEventListener('studio-session-ended', ended); };
  }, [refresh]);
  function change(next: User | null) {
    ++revision.current; setUser(next); setError(''); channel.current?.postMessage('session-changed');
  }
  async function signOut() {
    try { await api('/api/auth/logout', request({})); change(null); }
    catch (err) { setError(describe(err)); }
  }
  if (checking) return <main className="loading" role="status"><LoaderCircle className="spin"/>Opening your studio…</main>;
  return <>{error && <div className="alert" role="alert">{error} <button onClick={() => void refresh()}>Retry</button></div>}
    {user ? children(user, signOut) : <AccountForm onSignIn={change}/>}</>;
}

function AccountForm({ onSignIn }: { onSignIn: (user: User) => void }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const confirmInput = useRef<HTMLInputElement>(null);
  const challengeVersion = useRef(0);
  const refreshCaptcha = useCallback(async () => {
    const version = ++challengeVersion.current;
    setCaptcha(null); setCode(''); setLoadingImage(true);
    try {
      const next = await api<Captcha>('/api/auth/captcha');
      if (version === challengeVersion.current) setCaptcha(next);
    } catch (err) { if (version === challengeVersion.current) setError(describe(err)); }
    finally { if (version === challengeVersion.current) setLoadingImage(false); }
  }, []);
  useEffect(() => {
    if (!register) void refreshCaptcha();
    return () => { ++challengeVersion.current; };
  }, [register, refreshCaptcha]);
  function switchMode(next: boolean) {
    setRegister(next); setPassword(''); setConfirmation(''); setMismatch(false);
    setCode(''); setError(''); setNotice('');
  }
  async function enterGuest() {
    if (pending) return;
    setPending(true); setError(''); setNotice('');
    try {
      const result = await api<{user:User}>('/api/auth/guest', request({}));
      onSignIn(result.user);
    } catch (err) { setError(describe(err)); }
    finally { setPending(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (register && password !== confirmation) {
      setMismatch(true); setError(''); confirmInput.current?.focus();
      return;
    }
    setPending(true); setError(''); setNotice('');
    try {
      if (register) {
        const result = await api<{message:string}>('/api/auth/register', request({email,password,confirm_password:confirmation}));
        switchMode(false); setNotice(result.message);
      } else {
        const result = await api<{user:User}>('/api/auth/login', request({email,password,captcha:code,captcha_id:captcha?.id}));
        onSignIn(result.user);
      }
    } catch (err) {
      setError(describe(err));
      if (!register) await refreshCaptcha();
    } finally { setPending(false); }
  }

  return <><header className="topbar"><div className="top-inner">
    <span className="brand"><span className="logo"><Waves size={25}/></span>Swell<span className="brand-light">Studio</span></span>
  </div></header><main className="auth-layout">
    <section className="auth-paper"><img src={import.meta.env.BASE_URL + 'sample.png'} alt="Ocean Breeze sample product poster"/></section>
    <section className="auth-card card"><div className="auth-title">
      <h1>{register ? 'Create an account' : 'Welcome back'}</h1>
      <p>{register ? 'Create an account to keep your personal poster library.' : 'Sign in to create posters and open your library.'}</p>
    </div>
    <form onSubmit={submit}>
      <div className="field"><div className="field-label"><label htmlFor="account-email">Email address</label></div>
        <input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={pending} onChange={e=>setEmail(e.target.value)}/></div>
      <div className="field"><div className="field-label"><label htmlFor="account-password">Password</label></div>
        <input id="account-password" type="password" autoComplete={register?'new-password':'current-password'} minLength={register?8:1} maxLength={128} required
          placeholder={register?'At least 8 characters':undefined} value={password} disabled={pending} onChange={e=>{setPassword(e.target.value);setMismatch(false);}}/></div>
      {register ? <div className="field"><div className="field-label"><label htmlFor="confirm-password">Confirm password</label></div>
        <input ref={confirmInput} id="confirm-password" type="password" autoComplete="new-password" required maxLength={128}
          aria-invalid={mismatch} aria-describedby={mismatch?'password-mismatch':undefined}
          value={confirmation} disabled={pending} onChange={e=>{setConfirmation(e.target.value);setMismatch(false);}}/>
        {mismatch && <small className="field-error" role="alert" id="password-mismatch">Passwords do not match. Enter the same password twice.</small>}
      </div> : <div className="field"><div className="field-label"><label htmlFor="account-code">Image verification code</label></div>
        <div className="captcha-row">
          {captcha ? <img width={178} height={52} src={captcha.image} alt="Five-character sign-in verification challenge"/> : <span>{loadingImage?'Loading image…':'Image unavailable'}</span>}
          <button type="button" className="icon-btn" aria-label="Refresh image code" disabled={pending||loadingImage} onClick={()=>{setError('');void refreshCaptcha();}}><RefreshCw size={17}/></button>
        </div>
        <input id="account-code" required minLength={5} maxLength={5} pattern="[A-Za-z0-9]{5}" autoComplete="off" placeholder="5 characters" value={code} disabled={pending} onChange={e=>setCode(e.target.value)}/>
      </div>}
      {error && <div className="alert" role="alert">{error}</div>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      <button type="submit" className="generate" disabled={pending||(!register && !captcha)}>{pending ? <LoaderCircle className="spin" size={17}/> : null}{register?'Create account':'Sign in'}</button>
      {!register && <div className="guest-entry"><button type="button" className="secondary" disabled={pending} onClick={()=>void enterGuest()}>Continue as guest</button>
        <small>Your guest library is available in this browser until you sign out or the session expires.</small></div>}
      <p className="auth-switch">{register?'Already registered?':'New to Swell Studio?'} <button type="button" disabled={pending} onClick={()=>switchMode(!register)}>{register?'Sign in':'Create account'}</button></p>
    </form></section>
  </main></>;
}
