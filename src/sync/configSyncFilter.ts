import { GoogleDrivePluginSettings } from '../types';

/**
 * Checks if a relative path belongs to Obsidian's configuration directory (e.g. .obsidian).
 */
export function isConfigDirFile(path: string, configDir: string = '.obsidian'): boolean {
  const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const cleanConfig = configDir.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return cleanPath === cleanConfig || cleanPath.startsWith(`${cleanConfig}/`) || cleanPath.startsWith('.obsidian/');
}

/**
 * Normalizes a configuration path by extracting the subpath inside .obsidian/
 * e.g. ".obsidian/plugins/dataview/main.js" -> "plugins/dataview/main.js"
 */
export function getRelativeConfigSubpath(path: string, configDir: string = '.obsidian'): string {
  const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const cleanConfig = configDir.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

  if (cleanPath.startsWith(`${cleanConfig}/`)) {
    return cleanPath.substring(cleanConfig.length + 1);
  }
  if (cleanPath.startsWith('.obsidian/')) {
    return cleanPath.substring('.obsidian/'.length);
  }
  return cleanPath;
}

/**
 * Determines whether a specific .obsidian configuration file should be synced
 * according to user settings and safety rules.
 */
export function shouldSyncConfigFile(
  path: string,
  configDir: string = '.obsidian',
  settings: GoogleDrivePluginSettings
): boolean {
  if (!settings.syncConfigDir) {
    return false;
  }

  const subpath = getRelativeConfigSubpath(path, configDir).toLowerCase();

  // 1. HARD BLACKLIST: Never sync device secrets, local caches, or system files
  // Protect VaultGlide's own credentials so devices never overwrite each other's deviceId / tokens
  if (
    subpath === 'plugins/vaultglide/data.json' ||
    subpath === 'plugins/obsidian-google-drive/data.json' ||
    subpath.startsWith('plugins/vaultglide/data.') ||
    subpath.startsWith('plugins/obsidian-google-drive/data.')
  ) {
    return false;
  }

  // Never sync transient cache files or search indexes
  if (
    subpath.startsWith('cache/') ||
    subpath.startsWith('.trash/') ||
    subpath.endsWith('.ds_store') ||
    subpath.endsWith('thumbs.db') ||
    subpath.endsWith('.tmp') ||
    subpath.endsWith('~')
  ) {
    return false;
  }

  // Workspace tab layout: Only sync if explicitly enabled (default false to protect mobile layouts)
  if (subpath === 'workspace.json' || subpath === 'workspace-mobile.json') {
    return Boolean(settings.syncWorkspaceLayout);
  }

  // Graph view coordinates
  if (subpath === 'graph.json') {
    return false;
  }

  // 2. WHITELIST CATEGORIES

  // Themes and CSS Snippets
  if (subpath === 'appearance.json' || subpath.startsWith('snippets/') || subpath.startsWith('themes/')) {
    return Boolean(settings.syncAppearance);
  }

  // Community Plugins (main.js, manifest.json, styles.css, plugin data.json, enabled list)
  if (
    subpath === 'community-plugins.json' ||
    subpath === 'core-plugins.json' ||
    subpath.startsWith('plugins/')
  ) {
    return Boolean(settings.syncCommunityPlugins);
  }

  // Core Editor Settings & Keybindings
  if (subpath === 'app.json' || subpath === 'hotkeys.json' || subpath === 'types.json') {
    return Boolean(settings.syncCoreSettings);
  }

  // Other root-level configuration jsons default to Core Settings toggle
  if (!subpath.includes('/') && subpath.endsWith('.json')) {
    return Boolean(settings.syncCoreSettings);
  }

  return false;
}

/**
 * Checks if a synced file is a plugin, theme, or snippet that would benefit from
 * an Obsidian reload after pulling from Google Drive.
 */
export function isPluginOrThemeFile(path: string, configDir: string = '.obsidian'): boolean {
  if (!isConfigDirFile(path, configDir)) return false;
  const subpath = getRelativeConfigSubpath(path, configDir).toLowerCase();
  return (
    subpath.startsWith('plugins/') ||
    subpath === 'community-plugins.json' ||
    subpath === 'appearance.json' ||
    subpath.startsWith('snippets/') ||
    subpath.startsWith('themes/')
  );
}
