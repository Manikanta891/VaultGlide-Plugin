import { Vault, TFile } from 'obsidian';
import { GoogleDrivePluginSettings, LocalFileHash } from '../types';
import { isConfigDirFile, shouldSyncConfigFile } from './configSyncFilter';

export const DEFAULT_IGNORED_PATTERNS = [
  '^\.git($|\/)',
  '^node_modules($|\/)',
  '^\.trash($|\/)',
  '^\.DS_Store$',
  '^Thumbs\.db$',
  '~$',
  '\.tmp$',
];

export class LocalHasher {
  constructor(
    private vault: Vault,
    private getSettings: () => GoogleDrivePluginSettings
  ) {}

  /**
   * Computes SHA-256 hex string for binary buffer using Web Crypto API.
   */
  public async computeHash(buffer: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Checks if a file path is ignored from syncing.
   * - Config dir (.obsidian) paths are checked against granular user settings & blacklist.
   * - Vault paths are checked against standard ignore patterns & custom user patterns.
   */
  public isIgnored(path: string): boolean {
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const configDir = (this.vault as any).configDir || '.obsidian';

    if (isConfigDirFile(clean, configDir)) {
      const settings = this.getSettings();
      return !shouldSyncConfigFile(clean, configDir, settings);
    }

    const custom = this.getSettings().customIgnoredPatterns || [];
    const all = [...DEFAULT_IGNORED_PATTERNS, ...custom];

    for (const pat of all) {
      try {
        const reg = new RegExp(pat, 'i');
        if (reg.test(clean)) return true;
      } catch {
        // Ignore invalid user regex
      }
    }
    return false;
  }

  /**
   * Recursively discovers all files in Obsidian's hidden config directory (e.g. .obsidian).
   */
  private async scanConfigDir(configDir: string): Promise<string[]> {
    const collected: string[] = [];
    const queue = [configDir];

    while (queue.length > 0) {
      const current = queue.shift()!;
      try {
        const list = await this.vault.adapter.list(current);
        if (list.files) {
          for (const f of list.files) {
            collected.push(f.replace(/\\/g, '/').replace(/^\/+/, ''));
          }
        }
        if (list.folders) {
          for (const d of list.folders) {
            queue.push(d.replace(/\\/g, '/').replace(/^\/+/, ''));
          }
        }
      } catch {
        // Directory may not exist or not accessible
      }
    }
    return collected;
  }

  /**
   * Scans all non-ignored vault files and eligible .obsidian config files,
   * computing their hashes in parallel chunks.
   */
  public async scanVault(): Promise<LocalFileHash[]> {
    const settings = this.getSettings();
    const configDir = (this.vault as any).configDir || '.obsidian';
    const result: LocalFileHash[] = [];

    // 1. Scan regular vault files
    const vaultFiles: TFile[] = this.vault.getFiles();
    const validVaultFiles = vaultFiles.filter((f) => !this.isIgnored(f.path));

    const BATCH_SIZE = 50;
    for (let i = 0; i < validVaultFiles.length; i += BATCH_SIZE) {
      const batch = validVaultFiles.slice(i, i + BATCH_SIZE);
      const batchEntries = await Promise.all(
        batch.map(async (file) => {
          try {
            const data = await this.vault.readBinary(file);
            const hash = await this.computeHash(data);
            return {
              relativePath: file.path.replace(/\\/g, '/').replace(/^\/+/, ''),
              hash,
              size: file.stat.size,
              mtime: file.stat.mtime,
            };
          } catch {
            return null;
          }
        })
      );

      for (const entry of batchEntries) {
        if (entry) result.push(entry);
      }
    }

    // 2. Scan .obsidian configuration files if enabled
    if (settings.syncConfigDir) {
      const configPaths = await this.scanConfigDir(configDir);
      const eligibleConfigPaths = configPaths.filter((p) => shouldSyncConfigFile(p, configDir, settings));

      for (let i = 0; i < eligibleConfigPaths.length; i += BATCH_SIZE) {
        const batch = eligibleConfigPaths.slice(i, i + BATCH_SIZE);
        const batchEntries = await Promise.all(
          batch.map(async (path) => {
            try {
              const data = await this.vault.adapter.readBinary(path);
              const stat = await this.vault.adapter.stat(path);
              const hash = await this.computeHash(data);
              return {
                relativePath: path,
                hash,
                size: stat?.size || data.byteLength,
                mtime: stat?.mtime || Date.now(),
              };
            } catch {
              return null;
            }
          })
        );

        for (const entry of batchEntries) {
          if (entry) result.push(entry);
        }
      }
    }

    return result;
  }
}
