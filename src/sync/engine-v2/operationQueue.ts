import { App } from 'obsidian';

export type OperationType = 'create' | 'update' | 'delete' | 'rename' | 'create-folder' | 'delete-folder';
export type OperationState = 'pending' | 'prepared' | 'remote-written' | 'committed';

export interface QueuedOperation {
  operationId: string;
  type: OperationType;
  fileId: string;
  path: string;
  oldPath?: string;
  baseVersionId?: string;
  newVersionId?: string;
  contentHash?: string;
  driveFileId?: string;
  state: OperationState;
  createdAt: number;
  retriesRemaining: number;
}

export class OperationQueue {
  private queue: QueuedOperation[] = [];
  private filePath: string;

  constructor(private app: App) {
    const configDir = (this.app.vault as any).configDir || '.obsidian';
    this.filePath = `${configDir}/plugins/vaultglide/operation-queue.json`;
  }

  public async load(): Promise<QueuedOperation[]> {
    try {
      if (await this.app.vault.adapter.exists(this.filePath)) {
        const raw = await this.app.vault.adapter.read(this.filePath);
        this.queue = JSON.parse(raw);
      }
    } catch {
      this.queue = [];
    }
    return this.queue;
  }

  public getOperations(): QueuedOperation[] {
    return this.queue;
  }

  public add(op: Omit<QueuedOperation, 'createdAt' | 'retriesRemaining'>): void {
    this.queue.push({
      ...op,
      createdAt: Date.now(),
      retriesRemaining: 3,
    });
    this.save();
  }

  public updateState(operationId: string, state: OperationState): void {
    const op = this.queue.find((o) => o.operationId === operationId);
    if (op) {
      op.state = state;
      this.save();
    }
  }

  public remove(operationId: string): void {
    this.queue = this.queue.filter((o) => o.operationId !== operationId);
    this.save();
  }

  public clear(): void {
    this.queue = [];
    this.save();
  }

  private async save(): Promise<void> {
    try {
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(this.filePath, JSON.stringify(this.queue, null, 2));
    } catch (e) {
      console.warn('Failed to persist operation queue:', e);
    }
  }
}
