/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Just enough of a document for the page shell: elements with children, attributes, hidden, text, style, class and
// click listeners, and a head and body.

type Listener = () => void;

export class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  parent: FakeElement | null = null;
  hidden = false;
  className = '';
  id = '';
  type = '';
  title = '';
  checked = false;
  href = '';
  download = '';
  textContent: string | null = '';
  onclick: Listener | null = null;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') this.textContent = `${this.textContent ?? ''}${node}`;
      else this.insertBefore(node, null);
    }
  }

  insertBefore(node: FakeElement, before: FakeElement | null): void {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parent = this;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Fires listeners and the onclick handler; a link click records its download. */
  click(): void {
    if (this.tagName === 'A')
      this.ownerDocument.downloads.push({ href: this.href, name: this.download });
    for (const listener of this.listeners.get('click') ?? []) listener();
    this.onclick?.();
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  /** Every descendant, depth first. */
  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
}

export class FakeDocument {
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly downloads: { href: string; name: string }[] = [];

  constructor() {
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createTextNode(text: string): string {
    return text;
  }

  getElementById(id: string): FakeElement | null {
    return [...this.head.all(), ...this.body.all()].find((e) => e.id === id) ?? null;
  }
}
