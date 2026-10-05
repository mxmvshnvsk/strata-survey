// Small DOM, SVG and charting helpers. No framework: elements are built with h() and s().

import type { Lang } from '../../types.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const DAY = 86400;
export const YEAR = 365.25 * DAY;

type AttrValue = string | number | boolean | null | undefined | ((e: any) => void);
export type Attrs = Record<string, AttrValue> | null;
export type Kid = Node | string | number | null | undefined | false | Kid[];

/** Look up an element that the template guarantees to exist. */
export function $<E extends HTMLElement = HTMLElement>(id: string): E {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the report template`);
  return el as E;
}

function setAttrs(e: Element, attrs: Attrs): void {
  for (const k in attrs || {}) {
    const v = attrs![k];
    if (typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.setAttribute('class', String(v));
    else if (k === 'html') e.innerHTML = String(v); // only for text we escaped ourselves
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
}

function appendKids(e: Element, kids: Kid[]): void {
  for (const kid of kids.flat(Infinity as 1) as Kid[]) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(typeof kid === 'object' ? (kid as Node) : String(kid));
  }
}

/** Create an HTML element. Attributes starting with "on" become event listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  setAttrs(e, attrs ?? null);
  appendKids(e, kids);
  return e;
}

/** Create an SVG element. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, ...kids: Kid[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  setAttrs(e, attrs ?? null);
  appendKids(e, kids);
  return e;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (x: unknown): string => String(x).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** A linear scale with its inverse. */
export interface Scale {
  (v: number): number;
  inv(px: number): number;
}

export function lin(d0: number, d1: number, r0: number, r1: number): Scale {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = ((v: number) => r0 + (v - d0) * k) as Scale;
  f.inv = (px) => d0 + (px - r0) / (k || 1);
  return f;
}

/** Round tick values (1, 2, 2.5, 5 × 10^n) between min and max. */
export function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || 1;
  const step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= step0) || 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Year ticks for long ranges, month ticks for short ones: [time, label]. */
export function timeTicks(t0: number, t1: number, maxTicks: number, lang: Lang): [number, string][] {
  const years = (t1 - t0) / YEAR;
  const out: [number, string][] = [];
  const y0 = new Date(t0 * 1000).getUTCFullYear(), y1 = new Date(t1 * 1000).getUTCFullYear();
  if (years >= 2) {
    const step = Math.max(1, Math.ceil((y1 - y0 + 1) / maxTicks));
    for (let y = y0 + 1; y <= y1; y += step) out.push([Date.UTC(y, 0, 1) / 1000, String(y)]);
    return out;
  }
  const months = Math.max(1, Math.ceil((years * 12) / maxTicks));
  const d = new Date(t0 * 1000);
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  for (;;) {
    if (m > 11) { y++; m -= 12; }
    const t = Date.UTC(y, m, 1) / 1000;
    if (t > t1) break;
    out.push([t, new Date(t * 1000).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })]);
    m += months;
  }
  return out;
}

/** Spread-free max: Math.max(...bigArray) throws past ~125k arguments. */
export function maxOf(init: number, values: Iterable<number>): number {
  let m = init;
  for (const v of values) if (v > m) m = v;
  return m;
}

export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** Shorten text to fit `px` pixels at roughly `charWidth` pixels per character. */
export function clip(str: string, px: number, charWidth: number): string {
  const n = Math.floor(px / charWidth);
  return str.length <= n ? str : n > 2 ? str.slice(0, n - 1) + '…' : '';
}

function rgbOf(c: string): number[] {
  c = c.trim();
  if (c[0] === '#') {
    if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  }
  const m = c.match(/\d+(\.\d+)?/g);
  return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
}

/** Dark or light label ink for a tile painted `color` at `opacity` over `under`. */
export function inkOn(color: string, opacity: number, under: string): string {
  const a = rgbOf(color), b = rgbOf(under);
  const c = a.map((v, i) => v * opacity + b[i] * (1 - opacity));
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return lum > 0.55 ? 'rgba(17,22,28,.82)' : 'rgba(244,246,243,.9)';
}

/** A CSS custom property's current value (theme-dependent). */
export const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ── Tooltip ─────────────────────────────────────────────────────────────

/** Show the shared tooltip near the pointer. `html` must already be escaped. */
export function showTip(evt: MouseEvent, html: string): void {
  const tip = $('tip');
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, hh = tip.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
  if (y + hh > window.innerHeight - 8) y = evt.clientY - hh - pad;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

export function hideTip(): void {
  $('tip').hidden = true;
}

/** One "label … value" row of a tooltip. `value` must already be escaped. */
export const tipRow = (label: string, value: string | number): string => `<div class="row"><span>${esc(label)}</span><b>${value}</b></div>`;
