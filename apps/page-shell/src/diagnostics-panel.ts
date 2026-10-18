/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The diagnostics group of a panel: the full-log switch (applies at the next start), capacity and dropped counts, and
// the export button. The key log is always on. Nothing is uploaded; exporting is the only way out.

/** The parts of a diagnostic log the panel uses (DiagnosticLog satisfies it). */
export interface DiagnosticLogLike {
  readonly level: 'key' | 'full';
  setLevel(level: 'key' | 'full'): void;
  getCapacity(): { capacity: number; records: number; dropped: number };
  export(): { readonly runId: string; readonly createdAt: string };
}

export interface DiagnosticsPanelText {
  readonly fullLog: string;
  readonly appliesNextStart: string;
  readonly capacity: (records: number, capacity: number, dropped: number) => string;
  readonly export: string;
}

export class DiagnosticsPanel {
  private readonly status: HTMLElement;
  private readonly log: DiagnosticLogLike;
  private readonly text: DiagnosticsPanelText;

  constructor(
    panel: HTMLElement,
    log: DiagnosticLogLike,
    text: DiagnosticsPanelText,
    notify: (message: string) => void,
  ) {
    const doc = panel.ownerDocument;
    this.log = log;
    this.text = text;
    const label = doc.createElement('label');
    const toggle = doc.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = log.level === 'full';
    toggle.addEventListener('change', () => {
      log.setLevel(toggle.checked ? 'full' : 'key');
      notify(text.appliesNextStart);
    });
    label.append(toggle, doc.createTextNode(` ${text.fullLog}`));
    this.status = doc.createElement('p');
    this.status.className = 'lm-hint';
    const exportButton = doc.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = text.export;
    exportButton.addEventListener('click', () => this.download());
    panel.append(label, this.status, exportButton);
    this.refresh();
  }

  refresh(): void {
    const { capacity, records, dropped } = this.log.getCapacity();
    this.status.textContent = this.text.capacity(records, capacity, dropped);
  }

  /** Saves the export as a JSON file named after the run and the time. */
  download(): void {
    const exported = this.log.export();
    const blob = new Blob([JSON.stringify(exported, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = this.status.ownerDocument.createElement('a');
    link.href = url;
    link.download = `livemira-${exported.runId.slice(0, 8)}-${exported.createdAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    this.refresh();
  }
}
