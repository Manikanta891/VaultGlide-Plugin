import { App, TAbstractFile, TFile, TFolder } from 'obsidian';

export type JournalAction = 'create' | 'modify' | 'rename' | 'delete';

export interface ActivityEvent {
  id: string;
  action: JournalAction;
  path: string;
  oldPath?: string;
  type: 'file' | 'folder';
  timestamp: number;
  committed: boolean;
}

export class ActivityJournal {
  private events: ActivityEvent[] = [];
  private logFilePath: string;

  constructor(
    private app: App,
    private isPathIgnored: (path: string) => boolean
  ) {
    const configDir = (this.app.vault as any).configDir || '.obsidian';
    this.logFilePath = `${configDir}/plugins/vaultglide/activity-log.json`;
  }

  public async init(): Promise<void> {
    await this.loadLog();
    this.registerVaultListeners();
  }

  private registerVaultListeners(): void {
    this.app.vault.on('create', (file) => this.onVaultCreate(file));
    this.app.vault.on('modify', (file) => this.onVaultModify(file));
    this.app.vault.on('rename', (file, oldPath) => this.onVaultRename(file, oldPath));
    this.app.vault.on('delete', (file) => this.onVaultDelete(file));
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  private isInternalPath(p: string): boolean {
    const clean = this.normalizePath(p);
    return (
      clean.startsWith('.obsidian/plugins/vaultglide') ||
      clean.startsWith('.vaultglide') ||
      clean === 'VaultGlide Dashboard.md' ||
      this.isPathIgnored(clean)
    );
  }

  private onVaultCreate(file: TAbstractFile): void {
    const path = this.normalizePath(file.path);
    if (this.isInternalPath(path)) return;

    this.recordEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      action: 'create',
      path,
      type: file instanceof TFolder ? 'folder' : 'file',
      timestamp: Date.now(),
      committed: false,
    });
  }

  private onVaultModify(file: TAbstractFile): void {
    const path = this.normalizePath(file.path);
    if (this.isInternalPath(path) || file instanceof TFolder) return;

    // Deduplicate: If the last event for this file was a modify, just update its timestamp
    const existing = this.events.find((e) => !e.committed && e.path === path && e.action === 'modify');
    if (existing) {
      existing.timestamp = Date.now();
      this.saveLog();
      return;
    }

    this.recordEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      action: 'modify',
      path,
      type: 'file',
      timestamp: Date.now(),
      committed: false,
    });
  }

  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    const path = this.normalizePath(file.path);
    const cleanOld = this.normalizePath(oldPath);
    if (this.isInternalPath(path) && this.isInternalPath(cleanOld)) return;

    this.recordEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      action: 'rename',
      path,
      oldPath: cleanOld,
      type: file instanceof TFolder ? 'folder' : 'file',
      timestamp: Date.now(),
      committed: false,
    });
  }

  private onVaultDelete(file: TAbstractFile): void {
    const path = this.normalizePath(file.path);
    if (this.isInternalPath(path)) return;

    // If an uncommitted 'create' existed for this path, they cancel each other out
    const createIdx = this.events.findIndex((e) => !e.committed && e.path === path && e.action === 'create');
    if (createIdx !== -1) {
      this.events.splice(createIdx, 1);
      this.saveLog();
      return;
    }

    this.recordEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      action: 'delete',
      path,
      type: file instanceof TFolder ? 'folder' : 'file',
      timestamp: Date.now(),
      committed: false,
    });
  }

  private recordEvent(event: ActivityEvent): void {
    this.events.push(event);
    this.saveLog();
  }

  public getPendingEvents(): ActivityEvent[] {
    return this.events.filter((e) => !e.committed);
  }

  public markCommitted(eventIds: string[]): void {
    const idSet = new Set(eventIds);
    for (const e of this.events) {
      if (idSet.has(e.id)) {
        e.committed = true;
      }
    }
    this.saveLog();
  }

  public clearCommitted(): void {
    this.events = this.events.filter((e) => !e.committed);
    this.saveLog();
  }

  private async loadLog(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(this.logFilePath)) {
        const raw = await this.app.vault.adapter.read(this.logFilePath);
        this.events = JSON.parse(raw);
      }
    } catch {
      this.events = [];
    }
  }

  private async saveLog(): Promise<void> {
    try {
      const dir = this.logFilePath.substring(0, this.logFilePath.lastIndexOf('/'));
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(this.logFilePath, JSON.stringify(this.events, null, 2));
    } catch (e) {
      console.warn('Failed to persist activity log:', e);
    }
  }
}
