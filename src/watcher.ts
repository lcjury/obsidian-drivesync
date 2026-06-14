import { TFile, type TAbstractFile } from 'obsidian';
import type ObsidianDriveSync from './main';
import { syncSingleLocalChange } from './drive/sync';

export function startWatcher(plugin: ObsidianDriveSync): () => void {
	let debounceTimer: number | null = null;
	const pendingPaths = new Set<string>();
	let isSyncing = false;

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

	function onChange(file: TAbstractFile) {
		if (plugin.syncing) return;
		if (!(file instanceof TFile)) return;

		pendingPaths.add(file.path);

		if (debounceTimer) {
			window.clearTimeout(debounceTimer);
		}
		debounceTimer = window.setTimeout(
			flushChanges,
			plugin.settings.debounceMs,
		);
	}

	const createRef = plugin.app.vault.on('create', onChange);
	const modifyRef = plugin.app.vault.on('modify', onChange);
	const renameRef = plugin.app.vault.on('rename', (file) => {
		if (file instanceof TFile) {
			pendingPaths.add(file.path);
			if (debounceTimer) window.clearTimeout(debounceTimer);
			debounceTimer = window.setTimeout(
				flushChanges,
				plugin.settings.debounceMs,
			);
		}
	});

	plugin.registerEvent(createRef);
	plugin.registerEvent(modifyRef);
	plugin.registerEvent(renameRef);

	return () => {
		if (debounceTimer) window.clearTimeout(debounceTimer);
		plugin.app.vault.offref(createRef);
		plugin.app.vault.offref(modifyRef);
		plugin.app.vault.offref(renameRef);
	};
}
