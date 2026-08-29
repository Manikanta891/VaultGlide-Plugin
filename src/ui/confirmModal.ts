import { App, Modal, Setting } from 'obsidian';

export class ConfirmConflictModal extends Modal {
  constructor(
    app: App,
    private conflictedPaths: string[],
    private onDecision: (proceed: boolean) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Google Drive Sync: Cloud Changes Detected' });
    contentEl.createEl('p', {
      text: 'The following files in your Google Drive have been updated since your last sync. Pulling will update your local copies.',
      cls: 'mod-warning',
    });

    const listEl = contentEl.createEl('ul', { cls: 'gdrive-conflict-list' });
    for (const p of this.conflictedPaths.slice(0, 10)) {
      listEl.createEl('li', { text: p });
    }
    if (this.conflictedPaths.length > 10) {
      listEl.createEl('li', { text: `...and ${this.conflictedPaths.length - 10} more files` });
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Cancel Pull')
          .onClick(() => {
            this.close();
            this.onDecision(false);
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText('Download & Overwrite Local')
          .setCta()
          .onClick(() => {
            this.close();
            this.onDecision(true);
          })
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
