import { Vault, TFile } from 'obsidian';
import { LocalFileHash } from '../types';

export const DEFAULT_IGNORED_PATTERNS = [
  '^\.git($|\/)',
  '^node_modules($|\/)',
  '^\.trash($|\/)',
  '^\.obsidian\/workspace',
  '^\.obsidian\/cache',
  '^\.DS_Store$',
  '^Thumbs\.db$',
  '~$',
  '\.tmp$',
];

export class LocalHasher {
  constructor(private vault: Vault, private getCustomPatterns: () => string[]) {}

  /**
   * Computes SHA-256 hex string for binary buffer using Web Crypto API.
   */
  public async computeHash(buffer: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  public isIgnored(path: string): boolean {
    const custom = this.getCustomPatterns();
    const all = [...DEFAULT_IGNORED_PATTERNS, ...custom];

    for (const pat of all) {
      try {
        const reg = new RegExp(pat, 'i');
        if (reg.test(path)) return true;
      } catch {
        // Ignore invalid user regex
      }
    }
    return false;
  }

  /**
   * Scans all non-ignored vault files and computes their hashes in parallel chunks.
   * Seamlessly handles empty 0-byte notes.
   */
  public async scanVault(): Promise<LocalFileHash[]> {
    const files: TFile[] = this.vault.getFiles();
    const valid = files.filter((f) => !this.isIgnored(f.path));

    const result: LocalFileHash[] = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const batch = valid.slice(i, i + BATCH_SIZE);
      const batchEntries = await Promise.all(
        batch.map(async (file) => {
          try {
            const data = await this.vault.readBinary(file);
            const hash = await this.computeHash(data);
            return {
              relativePath: file.path,
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

    return result;
  }
}
