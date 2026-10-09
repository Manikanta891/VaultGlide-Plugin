import { BaseFileEntry, BaseStateData } from './baseState';

export interface LocalFileState {
  path: string;
  hash: string;
  size: number;
}

export interface RemoteFileState {
  driveFileId: string;
  path: string;
  hash?: string;
  versionId?: string;
  size?: number;
}

export interface DiffConflict {
  path: string;
  localState: LocalFileState;
  remoteState: RemoteFileState;
  baseEntry?: BaseFileEntry;
  type: 'content-divergence' | 'edit-vs-delete' | 'delete-vs-edit';
}

export interface SyncPlan {
  toUpload: Array<{ path: string; local: LocalFileState; base?: BaseFileEntry }>;
  toDownload: Array<{ path: string; remote: RemoteFileState; base?: BaseFileEntry }>;
  toDeleteRemote: Array<{ path: string; driveFileId: string; fileId: string }>;
  toDeleteLocal: Array<{ path: string; fileId: string }>;
  conflicts: DiffConflict[];
  converged: Array<{ path: string; hash: string }>;
}

export class ThreeWayDiffEngine {
  /**
   * Builds an unambiguous sync plan comparing Base, Local, and Remote states.
   */
  public static computePlan(
    base: BaseStateData,
    localFiles: Map<string, LocalFileState>,
    remoteFiles: Map<string, RemoteFileState>,
    localDeletions: Set<string> = new Set()
  ): SyncPlan {
    const plan: SyncPlan = {
      toUpload: [],
      toDownload: [],
      toDeleteRemote: [],
      toDeleteLocal: [],
      conflicts: [],
      converged: [],
    };

    const allPaths = new Set<string>([
      ...localFiles.keys(),
      ...remoteFiles.keys(),
      ...Object.values(base.files).map((f) => f.path),
    ]);

    for (const path of allPaths) {
      const local = localFiles.get(path);
      const remote = remoteFiles.get(path);
      const baseEntry = Object.values(base.files).find((f) => f.path === path);

      const localChanged = local && baseEntry ? local.hash !== baseEntry.contentHash : !!local && !baseEntry;
      const remoteChanged = remote && baseEntry ? remote.hash !== baseEntry.contentHash : !!remote && !baseEntry;
      const localDeleted = !local && !!baseEntry && localDeletions.has(path);
      const remoteDeleted = !remote && !!baseEntry;

      // 1. Both Sides Unchanged
      if (!localChanged && !remoteChanged && local && remote) {
        continue;
      }

      // 2. Converged (Both changed, but content hashes are identical)
      if (local && remote && localChanged && remoteChanged && local.hash === remote.hash) {
        plan.converged.push({ path, hash: local.hash });
        continue;
      }

      // 3. Conflict: Both changed with different content hashes
      if (local && remote && localChanged && remoteChanged && local.hash !== remote.hash) {
        plan.conflicts.push({
          path,
          localState: local,
          remoteState: remote,
          baseEntry,
          type: 'content-divergence',
        });
        continue;
      }

      // 4. Edit-vs-Delete Conflict: Edited locally, deleted remotely
      if (local && localChanged && remoteDeleted) {
        plan.conflicts.push({
          path,
          localState: local,
          remoteState: remote!,
          baseEntry,
          type: 'edit-vs-delete',
        });
        continue;
      }

      // 5. Delete-vs-Edit Conflict: Deleted locally, edited remotely
      if (localDeleted && remote && remoteChanged) {
        plan.conflicts.push({
          path,
          localState: local!,
          remoteState: remote,
          baseEntry,
          type: 'delete-vs-edit',
        });
        continue;
      }

      // 6. Clean Local Change -> Upload to Remote
      if (local && localChanged && (!remote || !remoteChanged)) {
        plan.toUpload.push({ path, local, base: baseEntry });
        continue;
      }

      // 7. Clean Remote Change -> Download to Local
      if (remote && remoteChanged && (!local || !localChanged)) {
        plan.toDownload.push({ path, remote, base: baseEntry });
        continue;
      }

      // 8. Clean Local Deletion -> Delete on Remote
      if (localDeleted && remote && baseEntry) {
        plan.toDeleteRemote.push({
          path,
          driveFileId: remote.driveFileId,
          fileId: baseEntry.fileId,
        });
        continue;
      }

      // 9. Clean Remote Deletion -> Delete on Local
      if (remoteDeleted && local && baseEntry && !localChanged) {
        plan.toDeleteLocal.push({
          path,
          fileId: baseEntry.fileId,
        });
        continue;
      }
    }

    return plan;
  }
}
