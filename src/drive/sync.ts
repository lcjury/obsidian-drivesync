import { Notice, TFile } from 'obsidian';
import type ObsidianDriveSync from '../main';
import type { TrackedFile, SyncResult } from '../types';
import type { DriveFile } from './client';
import {
	listAllFilesRecursive,
	findOrCreateFolderPath,
	uploadFile,
	updateFileContent,
	downloadFile,
	driveFileToLocalPath,
} from './client';
import { getMimeType } from '../constants';
import { getValidAccessToken } from '../auth/oauth';
import { resolveConflict, applyConflictToLocal } from '../conflict';

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function fullSync(
	plugin: ObsidianDriveSync,
): Promise<SyncResult> {
	const result: SyncResult = {
		uploaded: 0,
		downloaded: 0,
		conflicted: 0,
		errors: [],
	};

	const tokenData = await getValidAccessToken(
		plugin.settings.clientId,
		plugin.settings.clientSecret,
		plugin.tokenData,
	);
	if (!tokenData) {
		result.errors.push('Not authenticated. Run "Connect Google Drive" first.');
		return result;
	}

	plugin.tokenData = tokenData;
	await plugin.saveAllData();

	const accessToken = tokenData.accessToken;
	const syncState = plugin.syncState;

	if (!syncState) {
		result.errors.push('No sync state. Run "Connect Google Drive" first.');
		return result;
	}

	try {
		const remoteFiles = await listAllFilesRecursive(
			accessToken,
			syncState.rootFolderId,
		);

		const folderFiles = remoteFiles.filter(
			(f) => f.mimeType === 'application/vnd.google-apps.folder',
		);

		const remoteMap = new Map<string, DriveFile>();
		for (const file of remoteFiles) {
			if (file.mimeType === 'application/vnd.google-apps.folder') continue;
			const path = driveFileToLocalPath(file, folderFiles);
			remoteMap.set(path, file);
		}

		const localFiles = plugin.app.vault.getFiles();
		const localMap = new Map<string, TFile>();
		for (const file of localFiles) {
			localMap.set(file.path, file);
		}

		const tracked = syncState.files;
		const newTracked: Record<string, TrackedFile> = {};

		// Process local files
		for (const [path, localFile] of localMap) {
			const t = tracked[path];
			const remoteFile = remoteMap.get(path);

			if (!t) {
				// New local file
				try {
					const content = await plugin.app.vault.readBinary(localFile);
					const mimeType = getMimeType(path);
					const dir = path.includes('/')
						? path.substring(0, path.lastIndexOf('/'))
						: '';
					const parentId = await findOrCreateFolderPath(
						accessToken,
						syncState.rootFolderId,
						dir,
					);
					const fileName = path.split('/').pop() ?? path;
					const uploaded = await uploadFile(
						accessToken,
						parentId,
						path,
						fileName,
						content,
						mimeType,
					);
					newTracked[path] = {
						path,
						driveId: uploaded.id,
						remoteMd5: uploaded.md5Checksum ?? null,
						remoteMtime: localFile.stat.mtime,
						localMtime: localFile.stat.mtime,
					};
					result.uploaded++;
				} catch (err) {
					result.errors.push(`Upload ${path}: ${formatError(err)}`);
				}
			} else if (localFile.stat.mtime !== t.localMtime && remoteFile) {
				const localChanged = localFile.stat.mtime !== t.localMtime;
				const remoteChanged =
					remoteFile.md5Checksum !== t.remoteMd5;

				if (localChanged && remoteChanged) {
					// Conflict
					try {
						const localContent =
							await plugin.app.vault.readBinary(localFile);
						const remoteContent = await downloadFile(
							accessToken,
							t.driveId,
						);

						const conflict = await resolveConflict({
							path,
							localContent,
							remoteContent,
							localMtime: localFile.stat.mtime,
							remoteMtime: new Date(
								remoteFile.modifiedTime,
							).getTime(),
							parentDriveId: syncState.rootFolderId,
							tracked: t,
							vault: plugin.app.vault,
							accessToken,
						});

						await applyConflictToLocal(
							conflict.winnerPath,
							conflict.winnerContent,
							plugin.app.vault,
						);

						const winnerMimeType = getMimeType(
							conflict.winnerPath,
						);
						const updatedFile = await updateFileContent(
							accessToken,
							t.driveId,
							conflict.winnerContent,
							winnerMimeType,
						);

						newTracked[path] = {
							path,
							driveId: updatedFile.id,
							remoteMd5: updatedFile.md5Checksum ?? null,
							remoteMtime: new Date(
								updatedFile.modifiedTime,
							).getTime(),
							localMtime: new Date(
								updatedFile.modifiedTime,
							).getTime(),
						};
						result.conflicted++;
					} catch (err) {
						result.errors.push(
							`Conflict ${path}: ${formatError(err)}`,
						);
					}
				} else if (localChanged) {
					// Only local changed — upload
					try {
						const content =
							await plugin.app.vault.readBinary(localFile);
						const mimeType = getMimeType(path);
						const updatedFile = await updateFileContent(
							accessToken,
							t.driveId,
							content,
							mimeType,
						);
						newTracked[path] = {
							path,
							driveId: updatedFile.id,
							remoteMd5: updatedFile.md5Checksum ?? null,
							remoteMtime: new Date(
								updatedFile.modifiedTime,
							).getTime(),
							localMtime: localFile.stat.mtime,
						};
						result.uploaded++;
					} catch (err) {
						result.errors.push(
							`Upload ${path}: ${formatError(err)}`,
						);
					}
				} else {
					newTracked[path] = { ...t };
				}
			} else {
				// No remote file exists, not tracked — upload
				try {
					const content = await plugin.app.vault.readBinary(localFile);
					const mimeType = getMimeType(path);
					const dir = path.includes('/')
						? path.substring(0, path.lastIndexOf('/'))
						: '';
					const parentId = await findOrCreateFolderPath(
						accessToken,
						syncState.rootFolderId,
						dir,
					);
					const fileName = path.split('/').pop() ?? path;
					const uploaded = await uploadFile(
						accessToken,
						parentId,
						path,
						fileName,
						content,
						mimeType,
					);
					newTracked[path] = {
						path,
						driveId: uploaded.id,
						remoteMd5: uploaded.md5Checksum ?? null,
						remoteMtime: localFile.stat.mtime,
						localMtime: localFile.stat.mtime,
					};
					result.uploaded++;
				} catch (err) {
					result.errors.push(
						`Upload ${path}: ${formatError(err)}`,
					);
				}
			}
		}

		// Process remote files not handled above
		for (const [path, remoteFile] of remoteMap) {
			if (newTracked[path]) continue;

			const t = tracked[path];
			const localFile = localMap.get(path);

			if (!t || !localFile) {
				// New remote file — download
				try {
					const content = await downloadFile(
						accessToken,
						remoteFile.id,
					);
					const dir = path.includes('/')
						? path.substring(0, path.lastIndexOf('/'))
						: '';
					if (dir) {
						const dirParts = dir.split('/');
						let currentPath = '';
						for (const part of dirParts) {
							currentPath +=
								(currentPath ? '/' : '') + part;
							const folderExists =
								plugin.app.vault.getAbstractFileByPath(
									currentPath,
								);
							if (!folderExists) {
								await plugin.app.vault.createFolder(
									currentPath,
								);
							}
						}
					}
					await plugin.app.vault.createBinary(path, content);
					newTracked[path] = {
						path,
						driveId: remoteFile.id,
						remoteMd5: remoteFile.md5Checksum ?? null,
						remoteMtime: new Date(
							remoteFile.modifiedTime,
						).getTime(),
						localMtime: new Date(
							remoteFile.modifiedTime,
						).getTime(),
					};
					result.downloaded++;
				} catch (err) {
					result.errors.push(
						`Download ${path}: ${formatError(err)}`,
					);
				}
			} else if (t.remoteMd5 !== remoteFile.md5Checksum) {
				// Remote changed, local not changed — download
				try {
					const content = await downloadFile(
						accessToken,
						remoteFile.id,
					);
					await applyConflictToLocal(
						path,
						content,
						plugin.app.vault,
					);
					newTracked[path] = {
						path,
						driveId: remoteFile.id,
						remoteMd5: remoteFile.md5Checksum ?? null,
						remoteMtime: new Date(
							remoteFile.modifiedTime,
						).getTime(),
						localMtime: new Date(
							remoteFile.modifiedTime,
						).getTime(),
					};
					result.downloaded++;
				} catch (err) {
					result.errors.push(
						`Download ${path}: ${formatError(err)}`,
					);
				}
			}
		}

		plugin.syncState = {
			...syncState,
			files: newTracked,
			lastSyncTime: Date.now(),
		};
		await plugin.saveAllData();

		// Show summary
		const parts: string[] = [];
		if (result.uploaded > 0) parts.push(`${result.uploaded} uploaded`);
		if (result.downloaded > 0)
			parts.push(`${result.downloaded} downloaded`);
		if (result.conflicted > 0)
			parts.push(`${result.conflicted} conflicted`);

		if (parts.length > 0) {
			new Notice(`Drivesync: ${parts.join(', ')}`);
		} else if (result.errors.length === 0) {
			new Notice('Drivesync: Already up to date');
		}

		if (result.errors.length > 0) {
			console.error('DriveSync errors:', result.errors);
		}
	} catch (err) {
		result.errors.push(`Sync failed: ${formatError(err)}`);
		new Notice(`Drivesync: Sync failed — ${formatError(err)}`);
	}

	return result;
}

export async function syncSingleLocalChange(
	plugin: ObsidianDriveSync,
	file: TFile,
): Promise<void> {
	const tokenData = await getValidAccessToken(
		plugin.settings.clientId,
		plugin.settings.clientSecret,
		plugin.tokenData,
	);
	if (!tokenData || !plugin.syncState) return;

	plugin.tokenData = tokenData;
	await plugin.saveAllData();

	const accessToken = tokenData.accessToken;
	const path = file.path;
	const tracked = plugin.syncState.files[path];

	try {
		const content = await plugin.app.vault.readBinary(file);
		const mimeType = getMimeType(path);

		if (!tracked) {
			const dir = path.includes('/')
				? path.substring(0, path.lastIndexOf('/'))
				: '';
			const parentId = await findOrCreateFolderPath(
				accessToken,
				plugin.syncState.rootFolderId,
				dir,
			);
			const fileName = path.split('/').pop() ?? path;
			const uploaded = await uploadFile(
				accessToken,
				parentId,
				path,
				fileName,
				content,
				mimeType,
			);
			plugin.syncState.files[path] = {
				path,
				driveId: uploaded.id,
				remoteMd5: uploaded.md5Checksum ?? null,
				remoteMtime: file.stat.mtime,
				localMtime: file.stat.mtime,
			};
		} else {
			const updatedFile = await updateFileContent(
				accessToken,
				tracked.driveId,
				content,
				mimeType,
			);
			plugin.syncState.files[path] = {
				...tracked,
				remoteMd5: updatedFile.md5Checksum ?? null,
				remoteMtime: new Date(updatedFile.modifiedTime).getTime(),
				localMtime: file.stat.mtime,
			};
		}

		plugin.syncState.lastSyncTime = Date.now();
		await plugin.saveAllData();
	} catch (err) {
		console.error(`DriveSync: Failed to sync ${path}:`, err);
	}
}
