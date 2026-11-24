export type Product = { brand: string; product: string; description: string; price: string };
export type Poster = Product & { id: number; created_at: string; template_id: string };
export type FieldErrors = Partial<Record<keyof Product, string>>;

export const sample: Product = {
  brand: 'SUNSHIELD',
  product: 'Tropical Glow',
  description: 'Lightweight SPF 50+ sunscreen for sun-soaked days. Water-resistant, non-greasy, and made for the coast.',
  price: '14.99',
};

const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export const imageUrl = (id: number) => base + '/api/posters/' + id + '/image';

export class ApiError extends Error {
  constructor(message: string, public fields: FieldErrors = {}) { super(message); }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, { ...options, credentials: 'include' });
  } catch {
    throw new ApiError('Cannot reach the studio. Check your connection and try again.');
  }
  if (response.status === 401 && path.startsWith('/api/posters')) window.dispatchEvent(new Event('studio-session-ended'));
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new ApiError(data?.error || 'The studio is unavailable. Please try again.', data?.fields);
  return data as T;
}

export function validate(data: Product): FieldErrors {
  const errors: FieldErrors = {};
  for (const [key, max] of [['brand', 40], ['product', 60], ['description', 200]] as const) {
    if (!data[key].trim()) errors[key] = 'This field is required.';
    else if (Array.from(data[key].trim()).length > max) errors[key] = 'Use ' + max + ' characters or fewer.';
  }
  if (!/^[0-9]{1,6}(?:\.[0-9]{1,2})?$/.test(data.price.trim())) errors.price = 'Enter 0–999999.99 with up to two decimal places.';
  return errors;
}
