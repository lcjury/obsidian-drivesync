import { TFile, type TAbstractFile } from 'obsidian';
import type ObsidianDriveSync from './main';
import { syncSingleLocalChange, syncSingleLocalDelete, syncSingleLocalRename } from './drive/sync';
import { log } from './utils/logger';

interface WatcherOptions {
	quietMs?: number;
}

export function startWatcher(
	plugin: ObsidianDriveSync,
	options: WatcherOptions = {},
): () => void {
	let debounceTimer: number | null = null;
	const pendingPaths = new Set<string>();
	let isSyncing = false;
	const ignoreUntil = Date.now() + (options.quietMs ?? 0);

	function getSyncableFile(file: TAbstractFile): TFile | null {
		if (Date.now() < ignoreUntil) return null;
		if (plugin.syncing) return null;
		if (!(file instanceof TFile)) return null;
		if (file.path.startsWith(plugin.app.vault.configDir + '/')) return null;

		const tracked = plugin.syncState?.files[file.path];
		if (tracked && file.stat.mtime === tracked.localMtime) return null;

		return file;
	}

	function flushChanges() {
		if (isSyncing || pendingPaths.size === 0) return;

		isSyncing = true;
		const paths = [...pendingPaths];
		pendingPaths.clear();

		Promise.resolve()
			.then(async () => {
				for (const path of paths) {
					const file = plugin.app.vault.getAbstractFileByPath(
						path,
					) as TFile | null;
					if (!file) continue;
					await syncSingleLocalChange(plugin, file);
				}
			})
			.catch((err: unknown) => {
				console.error('DriveSync watcher error:', err);
			})
			.finally(() => {
				isSyncing = false;
				if (pendingPaths.size > 0) {
					debounceTimer = window.setTimeout(
						flushChanges,
						plugin.settings.debounceMs,
					);
				}
			});
	}

	function queueChange(file: TAbstractFile, action: string) {
		const syncableFile = getSyncableFile(file);
		if (!syncableFile) return;

		log(`DriveSync watcher: ${action} ${syncableFile.path}`);
		pendingPaths.add(syncableFile.path);

		if (debounceTimer) {
			window.clearTimeout(debounceTimer);
		}
		debounceTimer = window.setTimeout(
			flushChanges,
			plugin.settings.debounceMs,
		);
	}

	const createRef = plugin.app.vault.on('create', (file) => {
		queueChange(file, 'created');
	});
	const modifyRef = plugin.app.vault.on('modify', (file) => {
		queueChange(file, 'modified');
	});
	const deleteRef = plugin.app.vault.on('delete', (file) => {
		if (Date.now() < ignoreUntil) return;
		if (plugin.syncing) return;
		if (!(file instanceof TFile)) return;
		if (file.path.startsWith(plugin.app.vault.configDir + '/')) return;
		log(`DriveSync watcher: deleted ${file.path}`);
		void syncSingleLocalDelete(plugin, file.path);
	});
	const renameRef = plugin.app.vault.on('rename', (file, oldPath) => {
		if (Date.now() < ignoreUntil) return;
		if (plugin.syncing) return;
		if (!(file instanceof TFile)) return;
		if (file.path.startsWith(plugin.app.vault.configDir + '/')) return;
		log(
			`DriveSync watcher: renamed ${oldPath} → ${file.path}`,
		);
		void syncSingleLocalRename(plugin, oldPath, file.path);
	});

	plugin.registerEvent(createRef);
	plugin.registerEvent(modifyRef);
	plugin.registerEvent(deleteRef);
	plugin.registerEvent(renameRef);

	return () => {
		if (debounceTimer) window.clearTimeout(debounceTimer);
		plugin.app.vault.offref(createRef);
		plugin.app.vault.offref(modifyRef);
		plugin.app.vault.offref(deleteRef);
		plugin.app.vault.offref(renameRef);
	};
}
