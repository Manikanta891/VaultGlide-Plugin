import { App } from 'obsidian';

export interface BaseFileEntry {
  fileId: string;
  path: string;
  contentHash: string;
  versionId: string;
  driveFileId: string;
  updatedAt?: number;
}

export interface BaseFolderEntry {
  path: string;
  driveFileId: string;
}

export interface BaseTombstone {
  fileId: string;
  path: string;
  deletedAt: number;
  deletedByDevice?: string;
}

export interface BaseStateData {
  schemaVersion: number;
  vaultId: string;
  snapshotId: string;
  files: Record<string, BaseFileEntry>;
  folders: Record<string, BaseFolderEntry>;
  tombstones: BaseTombstone[];
}

export class BaseStateManager {
  private data: BaseStateData;
  private filePath: string;

  constructor(private app: App) {
    const configDir = (this.app.vault as any).configDir || '.obsidian';
    this.filePath = `${configDir}/plugins/vaultglide/base-state.json`;
    this.data = {
      schemaVersion: 1,
      vaultId: '',
      snapshotId: '',
      files: {},
      folders: {},
      tombstones: [],
    };
  }

  public async load(): Promise<BaseStateData> {
    try {
      if (await this.app.vault.adapter.exists(this.filePath)) {
        const raw = await this.app.vault.adapter.read(this.filePath);
        this.data = JSON.parse(raw);
      }
    } catch {
      // Return defaults if not exists
    }
    return this.data;
  }

  public getState(): BaseStateData {
    return this.data;
  }

  public findByPath(path: string): BaseFileEntry | undefined {
    const clean = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    for (const entry of Object.values(this.data.files)) {
      if (entry.path === clean) return entry;
    }
    return undefined;
  }

  public findByFileId(fileId: string): BaseFileEntry | undefined {
    return this.data.files[fileId];
  }

  public setFile(entry: BaseFileEntry): void {
    this.data.files[entry.fileId] = entry;
  }

  public removeFile(fileId: string, tombstone?: boolean, deviceId?: string): void {
    const entry = this.data.files[fileId];
    if (entry && tombstone) {
      this.data.tombstones.push({
        fileId,
        path: entry.path,
        deletedAt: Date.now(),
        deletedByDevice: deviceId,
      });
    }
    delete this.data.files[fileId];
  }

  public async save(): Promise<void> {
    try {
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      // Atomic write pattern: write to tmp then rename
      const tmpPath = `${this.filePath}.tmp`;
      await this.app.vault.adapter.write(tmpPath, JSON.stringify(this.data, null, 2));
      if (await this.app.vault.adapter.exists(this.filePath)) {
        await this.app.vault.adapter.remove(this.filePath);
      }
      await this.app.vault.adapter.rename(tmpPath, this.filePath);
    } catch (e) {
      console.warn('Failed to persist base state atomically:', e);
    }
  }
}
