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
  '^\.vaultglide($|\/)',
  '^VaultGlide Dashboard\.md$',
];

export class LocalHasher {
  // In-memory cache mapping relativePath -> { mtime, size, hash } to skip flash storage reads
  private metaCache: Map<string, { mtime: number; size: number; hash: string }> = new Map();

  constructor(
    private vault: Vault,
    private getSettings: () => GoogleDrivePluginSettings
  ) {}

  /**
   * Computes SHA-256 hex string for binary buffer using Web Crypto API.
   * If filePath is a text format (.md, .txt, .canvas, .json, etc.),
   * normalizes CRLF (\r\n) to LF (\n) before hashing so Windows, Android,
   * and iOS generate identical SHA-256 digests.
   */
  public async computeHash(buffer: ArrayBuffer, filePath?: string): Promise<string> {
    let targetBuffer = buffer;
    if (filePath && /\.(md|markdown|txt|canvas|json|css|js|ts|html|xml|yaml|yml|csv)$/i.test(filePath)) {
      try {
        const text = new TextDecoder('utf-8').decode(buffer);
        if (text.includes('\r\n')) {
          const normalized = text.replace(/\r\n/g, '\n');
          targetBuffer = new TextEncoder().encode(normalized).buffer as ArrayBuffer;
        }
      } catch {
        targetBuffer = buffer;
      }
    }
    const hashBuffer = await crypto.subtle.digest('SHA-256', targetBuffer);
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
    if (clean === 'VaultGlide Dashboard.md' || clean === '.vaultglide' || clean.startsWith('.vaultglide/')) return true;

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
   * computing their hashes with fast mtime & size caching.
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
            const cleanPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
            const cached = this.metaCache.get(cleanPath);

            // Fast-path: If mtime and size match cache, reuse hash immediately without reading disk!
            if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
              return {
                relativePath: cleanPath,
                hash: cached.hash,
                size: cached.size,
                mtime: cached.mtime,
              };
            }

            const data = await this.vault.readBinary(file);
            const hash = await this.computeHash(data, cleanPath);
            this.metaCache.set(cleanPath, { mtime: file.stat.mtime, size: file.stat.size, hash });

            return {
              relativePath: cleanPath,
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
              const hash = await this.computeHash(data, path);
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
