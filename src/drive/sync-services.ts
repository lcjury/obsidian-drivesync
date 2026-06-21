import type ObsidianDriveSync from '../main';
import { findOrCreateFolderPath } from './client';
import type { ReconcileServices } from './sync';

export class SyncServiceManager {
	private readonly remoteFolderCache = new Map<string, string>();
	private remoteFolderTail: Promise<void> = Promise.resolve();
	private localFolderTail: Promise<void> = Promise.resolve();

	constructor(private readonly plugin: ObsidianDriveSync) {}

	clearRemoteCache(): void {
		this.remoteFolderCache.clear();
	}

	forAccessToken(accessToken: string): ReconcileServices {
		return {
			resolveRemoteParent: (folderPath) =>
				this.resolveRemoteParent(accessToken, folderPath),
			ensureLocalParent: (filePath) =>
				this.ensureLocalParent(filePath),
		};
	}

	private resolveRemoteParent(
		accessToken: string,
		folderPath: string,
	): Promise<string> {
		const rootFolderId = this.plugin.syncState!.rootFolderId;
		if (!folderPath) return Promise.resolve(rootFolderId);
		const cacheKey = `${rootFolderId}\u0000${folderPath}`;
		const cached = this.remoteFolderCache.get(cacheKey);
		if (cached) return Promise.resolve(cached);

		const operation = this.remoteFolderTail.then(async () => {
			const current = this.remoteFolderCache.get(cacheKey);
			if (current) return current;
			const folderId = await findOrCreateFolderPath(
				accessToken,
				rootFolderId,
				folderPath,
			);
			this.remoteFolderCache.set(cacheKey, folderId);
			return folderId;
		});
		this.remoteFolderTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private ensureLocalParent(filePath: string): Promise<void> {
		const operation = this.localFolderTail.then(async () => {
			const adapter = this.plugin.app.vault.adapter;
			const dir = filePath.includes('/')
				? filePath.substring(0, filePath.lastIndexOf('/'))
				: '';
			if (!dir) return;

			let currentPath = '';
			for (const part of dir.split('/')) {
				currentPath += (currentPath ? '/' : '') + part;
				if (await adapter.exists(currentPath)) continue;
				await adapter.mkdir(currentPath);
			}
		});
		this.localFolderTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}
