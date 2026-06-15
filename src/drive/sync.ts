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
	trashFile,
	renameFile,
	driveFileToLocalPath,
	updateFilePath,
} from './client';
import { getMimeType } from '../constants';
import { getValidAccessToken } from '../auth/oauth';
import { resolveConflict, applyConflictToLocal } from '../conflict';
import { log } from '../utils/logger';

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
		deleted: 0,
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

	const rootFolderId = syncState.rootFolderId;
	log('── Sync started ──');
	try {
		const remoteFiles = await listAllFilesRecursive(
			accessToken,
			rootFolderId,
		);

		const folderFiles = remoteFiles.filter(
			(f) => f.mimeType === 'application/vnd.google-apps.folder',
		);

		const remoteByPath = new Map<string, DriveFile>();
		const remoteById = new Map<string, DriveFile>();
		for (const file of remoteFiles) {
			if (file.mimeType === 'application/vnd.google-apps.folder') continue;
			const path = driveFileToLocalPath(file, folderFiles);
			remoteByPath.set(path, file);
			remoteById.set(file.id, file);
		}

		const configDir = plugin.app.vault.configDir + '/';
		const localFiles = plugin.app.vault.getFiles();
		const localMap = new Map<string, TFile>();
		for (const file of localFiles) {
			if (file.path.startsWith(configDir)) continue;
			localMap.set(file.path, file);
		}

		const tracked = syncState.files;
		const newTracked: Record<string, TrackedFile> = {};
		const handledDriveIds = new Set<string>();
		const handledLocalPaths = new Set<string>();
		const handledRemotePaths = new Set<string>();

		async function ensureParentFolder(path: string): Promise<void> {
			const dir = path.includes('/')
				? path.substring(0, path.lastIndexOf('/'))
				: '';
			if (!dir) return;

			const dirParts = dir.split('/');
			let currentPath = '';
			for (const part of dirParts) {
				currentPath += (currentPath ? '/' : '') + part;
				const folderExists =
					plugin.app.vault.getAbstractFileByPath(currentPath);
				if (!folderExists) {
					await plugin.app.vault.createFolder(currentPath);
				}
			}
		}

		async function uploadLocalFile(path: string, localFile: TFile) {
			const content = await plugin.app.vault.readBinary(localFile);
			const mimeType = getMimeType(path);
			const dir = path.includes('/')
				? path.substring(0, path.lastIndexOf('/'))
				: '';
			const parentId = await findOrCreateFolderPath(
				accessToken,
				rootFolderId,
				dir,
			);
			const fileName = path.split('/').pop() ?? path;
			return uploadFile(
				accessToken,
				parentId,
				path,
				fileName,
				content,
				mimeType,
			);
		}

		async function downloadRemoteFile(
			path: string,
			remoteFile: DriveFile,
		): Promise<TFile | null> {
			const content = await downloadFile(accessToken, remoteFile.id);
			await ensureParentFolder(path);
			await applyConflictToLocal(path, content, plugin.app.vault);
			const downloaded =
				plugin.app.vault.getAbstractFileByPath(path);
			return downloaded instanceof TFile ? downloaded : null;
		}

		function track(
			path: string,
			driveFile: DriveFile,
			localFile: TFile,
		): void {
			newTracked[path] = {
				path,
				driveId: driveFile.id,
				remoteMd5: driveFile.md5Checksum ?? null,
				remoteMtime: new Date(driveFile.modifiedTime).getTime(),
				localMtime: localFile.stat.mtime,
			};
			handledDriveIds.add(driveFile.id);
			handledLocalPaths.add(path);
			handledRemotePaths.add(path);
		}

		// First reconcile files we already know by Drive ID.
		for (const [trackedPath, t] of Object.entries(tracked)) {
			handledLocalPaths.add(trackedPath);
			const remoteFile = remoteById.get(t.driveId);
			const remotePath = remoteFile
				? driveFileToLocalPath(remoteFile, folderFiles)
				: trackedPath;
			let localPath = remoteFile ? remotePath : trackedPath;
			let localFile =
				localMap.get(localPath) ?? localMap.get(trackedPath);

			try {
				if (remoteFile && remotePath !== trackedPath && localFile) {
					const remotePathFile = localMap.get(remotePath);
					if (!remotePathFile && localFile.path === trackedPath) {
						await ensureParentFolder(remotePath);
						await plugin.app.fileManager.renameFile(
							localFile,
							remotePath,
						);
						const renamed =
							plugin.app.vault.getAbstractFileByPath(
								remotePath,
							);
						if (renamed instanceof TFile) {
							localFile = renamed;
							localPath = remotePath;
							log(
								`  renamed local ${trackedPath} → ${remotePath}`,
							);
						}
					}
				}

				const localExists = !!localFile;
				const remoteExists = !!remoteFile;
				const localChanged =
					!!localFile && localFile.stat.mtime !== t.localMtime;
				const remoteChanged =
					!!remoteFile && remoteFile.md5Checksum !== t.remoteMd5;

				if (localFile) handledLocalPaths.add(localFile.path);
				if (remoteFile) {
					handledDriveIds.add(remoteFile.id);
					handledRemotePaths.add(remotePath);
				}

				if (localExists && remoteExists && localFile && remoteFile) {
					if (localChanged && remoteChanged) {
						const localContent =
							await plugin.app.vault.readBinary(localFile);
						const remoteContent = await downloadFile(
							accessToken,
							remoteFile.id,
						);
						const conflict = await resolveConflict({
							path: localPath,
							localContent,
							remoteContent,
							localMtime: localFile.stat.mtime,
							remoteMtime: new Date(
								remoteFile.modifiedTime,
							).getTime(),
							parentDriveId: rootFolderId,
							tracked: t,
							vault: plugin.app.vault,
							accessToken,
						});

						await applyConflictToLocal(
							conflict.winnerPath,
							conflict.winnerContent,
							plugin.app.vault,
						);
						const winnerRaw =
							plugin.app.vault.getAbstractFileByPath(
								localPath,
							);
						if (!(winnerRaw instanceof TFile)) continue;

						const updatedFile = await updateFileContent(
							accessToken,
							remoteFile.id,
							conflict.winnerContent,
							getMimeType(conflict.winnerPath),
						);
						await updateFilePath(
							accessToken,
							updatedFile.id,
							localPath,
						);
						track(localPath, updatedFile, winnerRaw);
						result.conflicted++;
						log(
							`  conflicted ${localPath} → ${conflict.conflictedPath}`,
						);
					} else if (localChanged) {
						const content =
							await plugin.app.vault.readBinary(localFile);
						const updatedFile = await updateFileContent(
							accessToken,
							remoteFile.id,
							content,
							getMimeType(localPath),
						);
						await updateFilePath(
							accessToken,
							updatedFile.id,
							localPath,
						);
						track(localPath, updatedFile, localFile);
						result.uploaded++;
						log(`  uploaded   ${localPath}`);
					} else if (remoteChanged) {
						const downloaded = await downloadRemoteFile(
							remotePath,
							remoteFile,
						);
						if (downloaded) {
							track(remotePath, remoteFile, downloaded);
							result.downloaded++;
							log(`  downloaded ${remotePath}`);
						}
					} else {
						if (localPath !== trackedPath) {
							await updateFilePath(
								accessToken,
								remoteFile.id,
								localPath,
							);
						}
						track(localPath, remoteFile, localFile);
					}
				} else if (localExists && localFile && !remoteExists) {
					if (localChanged) {
						const uploaded = await uploadLocalFile(
							localFile.path,
							localFile,
						);
						track(localFile.path, uploaded, localFile);
						result.uploaded++;
						log(`  uploaded   ${localFile.path}`);
					} else {
						await plugin.app.fileManager.trashFile(localFile);
						result.deleted++;
						log(`  deleted    ${trackedPath} (remote)`);
					}
				} else if (!localExists && remoteExists && remoteFile) {
					if (remoteChanged) {
						const downloaded = await downloadRemoteFile(
							remotePath,
							remoteFile,
						);
						if (downloaded) {
							track(remotePath, remoteFile, downloaded);
							result.downloaded++;
							log(`  downloaded ${remotePath}`);
						}
					} else {
						await trashFile(accessToken, remoteFile.id);
						result.deleted++;
						log(`  deleted    ${trackedPath} (local)`);
					}
				}
			} catch (err) {
				result.errors.push(
					`Sync ${trackedPath}: ${formatError(err)}`,
				);
			}
		}

		// Then reconcile files that were not tracked before.
		for (const [path, remoteFile] of remoteByPath) {
			if (handledDriveIds.has(remoteFile.id)) continue;

			const localFile = localMap.get(path);
			try {
				if (localFile && !handledLocalPaths.has(path)) {
					const localContent =
						await plugin.app.vault.readBinary(localFile);
					const remoteContent = await downloadFile(
						accessToken,
						remoteFile.id,
					);
					const conflict = await resolveConflict({
						path,
						localContent,
						remoteContent,
						localMtime: localFile.stat.mtime,
						remoteMtime: new Date(
							remoteFile.modifiedTime,
						).getTime(),
						parentDriveId: rootFolderId,
						tracked: {
							path,
							driveId: remoteFile.id,
							remoteMd5: null,
							remoteMtime: 0,
							localMtime: 0,
						},
						vault: plugin.app.vault,
						accessToken,
					});
					await applyConflictToLocal(
						conflict.winnerPath,
						conflict.winnerContent,
						plugin.app.vault,
					);
					const winnerRaw =
						plugin.app.vault.getAbstractFileByPath(path);
					if (!(winnerRaw instanceof TFile)) continue;
					const updatedFile = await updateFileContent(
						accessToken,
						remoteFile.id,
						conflict.winnerContent,
						getMimeType(path),
					);
					await updateFilePath(accessToken, updatedFile.id, path);
					track(path, updatedFile, winnerRaw);
					result.conflicted++;
					log(`  conflicted ${path} → ${conflict.conflictedPath}`);
				} else {
					const downloaded = await downloadRemoteFile(
						path,
						remoteFile,
					);
					if (downloaded) {
						track(path, remoteFile, downloaded);
						result.downloaded++;
						log(`  downloaded ${path}`);
					}
				}
			} catch (err) {
				result.errors.push(
					`Download ${path}: ${formatError(err)}`,
				);
			}
		}

		for (const path of localMap.keys()) {
			if (handledLocalPaths.has(path)) continue;
			if (handledRemotePaths.has(path)) continue;

			try {
				const currentFile =
					plugin.app.vault.getAbstractFileByPath(path);
				if (!(currentFile instanceof TFile)) continue;

				const uploaded = await uploadLocalFile(path, currentFile);
				track(path, uploaded, currentFile);
				result.uploaded++;
				log(`  uploaded   ${path}`);
			} catch (err) {
				result.errors.push(`Upload ${path}: ${formatError(err)}`);
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
		if (result.deleted > 0)
			parts.push(`${result.deleted} deleted`);

		if (parts.length > 0) {
			new Notice(`Drivesync: ${parts.join(', ')}`);
		} else if (result.errors.length === 0) {
			new Notice('Drivesync: Already up to date');
		}

		if (result.errors.length > 0) {
			console.error('DriveSync errors:', result.errors);
		}

		const sum = [
			result.uploaded > 0 ? `${result.uploaded} up` : '',
			result.downloaded > 0 ? `${result.downloaded} down` : '',
			result.conflicted > 0 ? `${result.conflicted} conflict` : '',
			result.deleted > 0 ? `${result.deleted} deleted` : '',
		]
			.filter(Boolean)
			.join(', ');
		log(
			`── Sync done${sum ? `: ${sum}` : ', up to date'} ──`,
		);
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
		log(`DriveSync: uploaded ${path}`);
	} catch (err) {
		console.error(`DriveSync: Failed to sync ${path}:`, err);
	}
}

export async function syncSingleLocalDelete(
	plugin: ObsidianDriveSync,
	path: string,
): Promise<void> {
	const tokenData = await getValidAccessToken(
		plugin.settings.clientId,
		plugin.settings.clientSecret,
		plugin.tokenData,
	);
	if (!tokenData || !plugin.syncState) return;

	const tracked = plugin.syncState.files[path];
	if (!tracked) return;

	plugin.tokenData = tokenData;
	await plugin.saveAllData();

	const accessToken = tokenData.accessToken;

	try {
		await trashFile(accessToken, tracked.driveId);
		delete plugin.syncState.files[path];
		plugin.syncState.lastSyncTime = Date.now();
		await plugin.saveAllData();
		log(`DriveSync: trashed ${path} on Drive`);
	} catch (err) {
		console.error(`DriveSync: Failed to trash ${path} on Drive:`, err);
	}
}

export async function syncSingleLocalRename(
	plugin: ObsidianDriveSync,
	oldPath: string,
	newPath: string,
): Promise<void> {
	const tokenData = await getValidAccessToken(
		plugin.settings.clientId,
		plugin.settings.clientSecret,
		plugin.tokenData,
	);
	if (!tokenData || !plugin.syncState) return;

	const tracked = plugin.syncState.files[oldPath];
	if (!tracked) return;

	plugin.tokenData = tokenData;
	await plugin.saveAllData();

	const accessToken = tokenData.accessToken;

	try {
		const updatedFile = await renameFile(
			accessToken,
			tracked.driveId,
			oldPath,
			newPath,
			plugin.syncState.rootFolderId,
		);
		const renamedFile =
			plugin.app.vault.getAbstractFileByPath(newPath);
		delete plugin.syncState.files[oldPath];
		plugin.syncState.files[newPath] = {
			path: newPath,
			driveId: updatedFile.id,
			remoteMd5: updatedFile.md5Checksum ?? null,
			remoteMtime: new Date(updatedFile.modifiedTime).getTime(),
			localMtime:
				renamedFile instanceof TFile
					? renamedFile.stat.mtime
					: tracked.localMtime,
		};
		plugin.syncState.lastSyncTime = Date.now();
		await plugin.saveAllData();
		log(`DriveSync: renamed ${oldPath} → ${newPath} on Drive`);
	} catch (err) {
		console.error(
			`DriveSync: Failed to rename ${oldPath} on Drive:`,
			err,
		);
	}
}
