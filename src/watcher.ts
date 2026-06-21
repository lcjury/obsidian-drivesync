import { TFile, type TAbstractFile } from 'obsidian';
import type ObsidianDriveSync from './main';
import { log } from './utils/logger';
import { ACTIVE_FILE_DEBOUNCE_MS } from './constants';
import { isExcludedPath } from './path-policy';

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

	function activeFileDebounceMs(): number {
		return Math.max(plugin.settings.debounceMs, ACTIVE_FILE_DEBOUNCE_MS);
	}

	function getDelayForFile(file: TFile): number {
		const activeFile = plugin.app.workspace.getActiveFile();
		if (activeFile?.path !== file.path) {
			return plugin.settings.debounceMs;
		}

		const idleMs = Date.now() - file.stat.mtime;
		return Math.max(activeFileDebounceMs() - idleMs, 0);
	}

	function scheduleFlush(delayMs: number): void {
		if (debounceTimer) {
			window.clearTimeout(debounceTimer);
		}
		debounceTimer = window.setTimeout(flushChanges, delayMs);
	}

	function getSyncableFile(file: TAbstractFile): TFile | null {
		if (Date.now() < ignoreUntil) return null;
		if (!(file instanceof TFile)) return null;
		if (isExcludedPath(file.path, plugin.app.vault.configDir)) return null;

		const tracked = plugin.syncState?.files[file.path];
		if (tracked && file.stat.mtime === tracked.localMtime) return null;

		return file;
	}

	function flushChanges() {
		if (isSyncing || pendingPaths.size === 0) return;

		isSyncing = true;
		const paths = [...pendingPaths];
		pendingPaths.clear();

		void Promise.resolve()
			.then(async () => {
				let nextDelay: number | null = null;
				for (const path of paths) {
					const file = plugin.app.vault.getAbstractFileByPath(
						path,
					) as TFile | null;
					if (!file) continue;
					const delayMs = getDelayForFile(file);
					if (delayMs > 0) {
						pendingPaths.add(path);
						nextDelay =
							nextDelay === null
								? delayMs
								: Math.min(nextDelay, delayMs);
						continue;
					}
					plugin.syncCoordinator.markPath(file.path);
				}
				return nextDelay;
			})
			.catch((err: unknown) => {
				console.error('DriveSync watcher error:', err);
				return null;
			})
			.then((nextDelay) => {
				isSyncing = false;
				if (pendingPaths.size > 0) {
					scheduleFlush(nextDelay ?? plugin.settings.debounceMs);
				}
			});
	}

	function queueChange(file: TAbstractFile, action: string) {
		const syncableFile = getSyncableFile(file);
		if (!syncableFile) return;

		if (!pendingPaths.has(syncableFile.path)) {
			log(`DriveSync watcher: ${action} ${syncableFile.path}`);
		}
		pendingPaths.add(syncableFile.path);
		scheduleFlush(getDelayForFile(syncableFile));
	}

	const createRef = plugin.app.vault.on('create', (file) => {
		queueChange(file, 'created');
	});
	const modifyRef = plugin.app.vault.on('modify', (file) => {
		queueChange(file, 'modified');
	});
	const deleteRef = plugin.app.vault.on('delete', (file) => {
		if (Date.now() < ignoreUntil) return;
		if (!(file instanceof TFile)) return;
		if (isExcludedPath(file.path, plugin.app.vault.configDir)) return;
		log(`DriveSync watcher: deleted ${file.path}`);
		plugin.syncCoordinator.markDeleted(file.path);
	});
	const renameRef = plugin.app.vault.on('rename', (file, oldPath) => {
		if (Date.now() < ignoreUntil) return;
		if (!(file instanceof TFile)) return;
		if (isExcludedPath(file.path, plugin.app.vault.configDir)) return;
		log(
			`DriveSync watcher: renamed ${oldPath} → ${file.path}`,
		);
		plugin.syncCoordinator.markRename(file.path, oldPath);
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
