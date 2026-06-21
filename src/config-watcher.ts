import { FileSystemAdapter, Platform } from 'obsidian';
import type ObsidianDriveSync from './main';
import { isExcludedPath } from './path-policy';
import { log } from './utils/logger';

const CONFIG_POLL_INTERVAL_MS = 5 * 60 * 1000;
const CONFIG_WATCH_DEBOUNCE_MS = 1500;

export function startConfigWatcher(
	plugin: ObsidianDriveSync,
	quietMs = 0,
): () => void {
	let debounceTimer: number | null = null;
	let pollTimer: number | null = null;
	let closed = false;
	let watcher: { close: () => void; on: (event: 'error', cb: (err: unknown) => void) => void } | null = null;
	const ignoreUntil = Date.now() + quietMs;

	const configDir = plugin.app.vault.configDir;

	function clearDebounce(): void {
		if (debounceTimer) {
			window.clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	function scheduleSync(delayMs = CONFIG_WATCH_DEBOUNCE_MS): void {
		if (closed) return;
		if (Date.now() < ignoreUntil || plugin.isConfigWatchSuppressed()) {
			return;
		}
		clearDebounce();
		debounceTimer = window.setTimeout(() => {
			debounceTimer = null;
			if (closed || plugin.isConfigWatchSuppressed()) return;
			log('DriveSync watcher: config changed, running sync');
			void plugin.runFullSync();
		}, delayMs);
	}

	function schedulePolling(): void {
		if (pollTimer) return;
		pollTimer = window.setInterval(() => {
			if (closed || !plugin.settings.autoSync) return;
			if (!plugin.tokenData || !plugin.syncState) return;
			if (!plugin.isDriveFolderSelectionCurrent()) return;
			void plugin.runFullSync();
		}, CONFIG_POLL_INTERVAL_MS);
	}

	function close(): void {
		closed = true;
		clearDebounce();
		if (pollTimer) {
			window.clearInterval(pollTimer);
			pollTimer = null;
		}
		try {
			watcher?.close();
		} finally {
			watcher = null;
		}
	}

	if (!Platform.isDesktopApp) {
		log('DriveSync watcher: using config polling fallback');
		schedulePolling();
		return close;
	}

	const adapter = plugin.app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		log('DriveSync watcher: config filesystem adapter unavailable, using polling');
		schedulePolling();
		return close;
	}

	try {
		const basePath = adapter.getBasePath();
		const absConfigDir = `${basePath}/${configDir}`;
		const nodeRequire = (window as Window & {
			require?: (id: string) => unknown;
		}).require;
		if (!nodeRequire) {
			throw new Error('Node require is unavailable');
		}
		const fs = nodeRequire('fs') as {
			watch: (
				path: string,
				options: { recursive: boolean },
				listener: (
					eventType: string,
					filename: string | { toString(): string } | null,
				) => void,
			) => {
				close: () => void;
				on: (
					event: 'error',
					cb: (err: unknown) => void,
				) => void;
			};
		};

		watcher = fs.watch(
			absConfigDir,
			{ recursive: true },
			(eventType: string, filename: string | { toString(): string } | null) => {
				if (!filename) {
					scheduleSync();
					return;
				}

				const relativePath = filename.toString().replaceAll('\\', '/');
				const configPath = `${configDir}/${relativePath}`;
				if (isExcludedPath(configPath, configDir)) return;
				log(`DriveSync watcher: config ${eventType} ${configPath}`);
				scheduleSync();
			},
		);
		watcher.on('error', (err) => {
			console.error('DriveSync config watcher error:', err);
			if (!closed) {
				watcher?.close();
				watcher = null;
				schedulePolling();
			}
		});
		log(`DriveSync watcher: watching ${configDir}`);
	} catch (err) {
		console.error('DriveSync config watcher setup failed:', err);
		log('DriveSync watcher: falling back to polling for config changes');
		schedulePolling();
	}

	return close;
}
