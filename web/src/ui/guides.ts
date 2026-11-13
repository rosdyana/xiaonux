// Guided lessons: each step types a real command into the terminal and is
// checked off once the shell prompt comes back after the visitor runs it.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import unixBasics from '../lessons/unix-basics.json';
import permissions from '../lessons/permissions.json';
import processes from '../lessons/processes.json';
import python from '../lessons/python.json';
import triage from '../lessons/triage.json';
import { lessonText, onLocaleChange, t } from '../i18n';

interface Step { text: string; cmd?: string }
interface Lesson { id: string; title: string; intro: string; steps: Step[] }

export const LESSONS: Lesson[] = [unixBasics, permissions, processes, python, triage];
export const LESSONS_DONE_KEY = 'xiaonux.lessons.done';
const DONE_KEY = LESSONS_DONE_KEY;
const CHECK = '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13.5l5 5.5L20 5"/></svg>';

export function lessonProgress(): Record<string, number[]> {
  try { return JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}'); } catch { return {}; }
}

export interface Guides {
  show(id: string): void;
  /** the visitor pressed Enter in the terminal */
  onEnter(): void;
  /** the shell printed a prompt */
  onPrompt(): void;
}

export function initGuides(type: (s: string) => void): Guides {
  const select = document.getElementById('lesson-select') as HTMLSelectElement;
  const intro = document.getElementById('lesson-intro')!;
  const list = document.getElementById('lesson-steps')!;
  const progress = document.getElementById('lesson-progress');
  // One segment per step: done, next, or still to come.
  const drawProgress = () => {
    if (!progress) return;
    const fin = new Set(done[lesson.id] ?? []);
    const next = lesson.steps.findIndex((_, i) => !fin.has(i));
    progress.replaceChildren(...lesson.steps.map((_, i) => {
      const seg = document.createElement('i');
      if (fin.has(i)) seg.className = 'done'; else if (i === next) seg.className = 'next';
      return seg;
    }));
  };
  const done = lessonProgress();
  let lesson = LESSONS[0];
  let typed: number | null = null;   // step whose command is in the input line
  let running: number | null = null; // step submitted with Enter, waiting for a prompt

  const fillSelect = () => {
    select.replaceChildren(...LESSONS.map((l) => new Option(lessonText(l).title, l.id)));
    select.value = lesson.id;
  };
  fillSelect();
  onLocaleChange(() => { fillSelect(); show(lesson.id); });
  select.addEventListener('change', () => show(select.value));

  function save() {
    try { localStorage.setItem(DONE_KEY, JSON.stringify(done)); } catch { /* private mode */ }
  }

  function setDone(i: number, on: boolean, animate = false) {
    const set = new Set(done[lesson.id] ?? []);
    if (on) set.add(i); else set.delete(i);
    done[lesson.id] = [...set].sort((a, b) => a - b);
    save();
    const li = list.children[i] as HTMLElement | undefined;
    if (!li) return;
    li.classList.toggle('done', on);
    li.classList.toggle('fresh', on && animate);
    if (on && animate) li.addEventListener('animationend', () => li.classList.remove('fresh'), { once: true });
    li.querySelector('.mark')?.setAttribute('aria-pressed', String(on));
    drawProgress();
  }

  function show(id: string) {
    lesson = LESSONS.find((l) => l.id === id) ?? LESSONS[0];
    select.value = lesson.id;
    const text = lessonText(lesson);
    intro.textContent = text.intro;
    typed = running = null;
    const finished = new Set(done[lesson.id] ?? []);
    list.replaceChildren(...lesson.steps.map((s, i) => {
      const li = document.createElement('li');
      li.className = 'step' + (finished.has(i) ? ' done' : '');
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'mark';
      mark.setAttribute('aria-pressed', String(finished.has(i)));
      mark.setAttribute('aria-label', t('guides.stepDone', { n: i + 1 }));
      mark.innerHTML = `<span class="num">${i + 1}</span>${CHECK}`;
      mark.addEventListener('click', () => setDone(i, !li.classList.contains('done')));
      const body = document.createElement('div');
      body.className = 'step-body';
      const p = document.createElement('p');
      p.innerHTML = text.step(i); // lesson text is our own static JSON / translations
      body.append(p);
      if (s.cmd) {
        const row = document.createElement('div');
        row.className = 'cmd';
        const code = document.createElement('code');
        code.textContent = s.cmd;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-quiet btn-small';
        btn.textContent = t('guides.typeIt');
        btn.addEventListener('click', () => {
          type('\x15' + s.cmd); // Ctrl-U clears whatever was half-typed
          typed = i;
        });
        row.append(code, btn);
        body.append(row);
      }
      li.append(mark, body);
      return li;
    }));
    drawProgress();
  }

  show(lesson.id);
  return {
    show,
    onEnter() {
      if (typed !== null) { running = typed; typed = null; }
    },
    onPrompt() {
      if (running === null) return;
      const i = running;
      running = null;
      setDone(i, true, true);
      const next = list.children[i + 1] as HTMLElement | undefined;
      next?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    },
  };
}
