import type ObsidianDriveSync from '../main';
import { REMOTE_CHANGE_POLL_INTERVAL_MS } from '../constants';
import { log } from '../utils/logger';

export function startRemoteChangePoller(
	plugin: ObsidianDriveSync,
): () => void {
	let timer: number | null = null;
	let closed = false;
	let running = false;

	async function tick(): Promise<void> {
		if (closed || running) return;
		if (!plugin.settings.autoSync) return;
		if (!plugin.tokenData || !plugin.syncState) return;
		if (!plugin.isDriveFolderSelectionCurrent()) return;
		if (plugin.syncing) return;

		running = true;
		try {
			log('DriveSync poller: checking remote changes');
			await plugin.syncCoordinator.runRemoteChangeSync();
		} catch (err) {
			console.error('DriveSync remote poller error:', err);
		} finally {
			running = false;
		}
	}

	timer = window.setInterval(() => {
		void tick();
	}, REMOTE_CHANGE_POLL_INTERVAL_MS);

	return () => {
		closed = true;
		if (timer) {
			window.clearInterval(timer);
			timer = null;
		}
	};
}
