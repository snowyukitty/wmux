// @vitest-environment jsdom
//
// The Fan-out dialog with agy as the launcher: the preview shows the `-i` main
// puts before the prompt (agy refuses a positional prompt), and the dialog
// warns that agy reads files .gitignore / .geminiignore would hide (owner
// decision C) whenever a task can land on agy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import FanOutDialog from '../FanOutDialog';
import { useStore } from '../../../stores';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(FanOutDialog, { onClose: vi.fn() })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState({ orchestratorRoleBindings: {} });
});

const q = <T extends HTMLElement>(id: string): T | null => container.querySelector(`[data-testid="${id}"]`);
const preview = (): string => q('fanout-command-preview')?.textContent ?? '';

function setValue(id: string, value: string, proto: typeof HTMLInputElement | typeof HTMLTextAreaElement): void {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(id) as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('FanOutDialog with agy', () => {
  it('previews `agy -i <prompt>` once there is a prompt, and plain `agy` without one', () => {
    setValue('fanout-agent', 'agy', HTMLInputElement);
    expect(preview()).toBe('agy');
    setValue('fanout-prompt', 'do the thing', HTMLTextAreaElement);
    expect(preview()).toBe('agy -i "$(cat <prompt file>)"');
    setValue('fanout-agent', 'claude', HTMLInputElement);
    expect(preview()).toBe('claude "$(cat <prompt file>)"');
  });

  it('warns that agy reads ignored files when agy is the launcher', () => {
    expect(q('fanout-agy-warning')).toBeNull();
    setValue('fanout-agent', 'agy --model gemini-3.8-flash-high', HTMLInputElement);
    expect(q('fanout-agy-warning')?.textContent).toMatch(/\.gitignore/);
    setValue('fanout-agent', 'codex', HTMLInputElement);
    expect(q('fanout-agy-warning')).toBeNull();
  });

  it('warns when a task role is bound to agy', () => {
    act(() => useStore.setState({ orchestratorRoleBindings: { Builder: { agent: 'agy' } } }));
    const select = q<HTMLSelectElement>('fanout-role-0') as HTMLSelectElement;
    expect(select).not.toBeNull();
    act(() => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(q('fanout-agy-warning')).not.toBeNull();
  });
});
