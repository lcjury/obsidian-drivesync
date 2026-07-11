import type ObsidianDriveSync from '../main';
import { log } from '../utils/logger';
import { listLocalFiles } from '../local-files';
import { isExcludedPath } from '../path-policy';
import type { LocalFileState } from '../types';
import {
	driveFileToLocalPath,
	listAllFilesRecursive,
	type DriveFile,
} from './client';
import type { RemoteFileState } from './sync';

export interface FullSyncSeed {
	driveId?: string;
	localFile?: LocalFileState;
	pathHint: string;
	remoteState: RemoteFileState;
}

function isUnsupportedGoogleFile(file: DriveFile): boolean {
	return (
		file.mimeType.startsWith('application/vnd.google-apps.') &&
		file.mimeType !== 'application/vnd.google-apps.folder'
	);
}

export async function buildFullSyncSeeds(
	plugin: ObsidianDriveSync,
	accessToken: string,
): Promise<FullSyncSeed[]> {
	const state = plugin.syncState!;
	const configDir = plugin.app.vault.configDir;
	const pluginDir = plugin.getPluginDir();
	let ignoredTechnicalPaths = 0;
	const remoteFiles = await listAllFilesRecursive(
		accessToken,
		state.rootFolderId,
		(path) => {
			const included = !isExcludedPath(path, configDir, pluginDir);
			if (!included) ignoredTechnicalPaths++;
			return included;
		},
	);
	log(`DriveSync: listed ${remoteFiles.length} remote entries`);
	if (ignoredTechnicalPaths > 0) {
		log(
			`DriveSync: ignored ${ignoredTechnicalPaths} technical remote path${ignoredTechnicalPaths === 1 ? '' : 's'}`,
		);
	}
	const folders = remoteFiles.filter(
		(file) =>
			file.mimeType === 'application/vnd.google-apps.folder',
	);
	const remoteById = new Map<string, DriveFile>();
	const remoteByPath = new Map<string, DriveFile>();
	const ignoredRemoteIds = new Set<string>();
	const ignoredRemotePaths = new Set<string>();
	let ignoredRemoteFiles = 0;
	for (const remoteFile of remoteFiles) {
		if (
			remoteFile.mimeType ===
			'application/vnd.google-apps.folder'
		) {
			continue;
		}
		const path = driveFileToLocalPath(remoteFile, folders);
		if (isUnsupportedGoogleFile(remoteFile)) {
			ignoredRemoteFiles++;
			ignoredRemoteIds.add(remoteFile.id);
			ignoredRemotePaths.add(path);
			log(
				`DriveSync: ignored remote file ${path} (unsupported MIME type: ${remoteFile.mimeType})`,
			);
			continue;
		}
		remoteById.set(remoteFile.id, remoteFile);
		remoteByPath.set(path, remoteFile);
	}
	if (ignoredRemoteFiles > 0) {
		log(
			`DriveSync: ignored ${ignoredRemoteFiles} unsupported remote file${ignoredRemoteFiles === 1 ? '' : 's'}`,
		);
	}

	const localFiles = await listLocalFiles(
		plugin.app.vault.adapter,
		configDir,
		pluginDir,
	);
	const localByPath = new Map(
		localFiles.map((file) => [file.path, file]),
	);

	const seeds: FullSyncSeed[] = [];
	const handledRemote = new Set<string>();
	const handledLocal = new Set<string>();
	let stateChanged = false;

	for (const tracked of Object.values(state.files)) {
		if (isExcludedPath(tracked.path, configDir, pluginDir)) {
			delete state.files[tracked.path];
			stateChanged = true;
			continue;
		}
		if (ignoredRemoteIds.has(tracked.driveId)) {
			const localFile = localByPath.get(tracked.path);
			if (localFile) handledLocal.add(localFile.path);
			continue;
		}
		const remoteFile = remoteById.get(tracked.driveId) ?? null;
		const remotePath = remoteFile
			? driveFileToLocalPath(remoteFile, folders)
			: tracked.path;
		const localFile =
			localByPath.get(remotePath) ??
			localByPath.get(tracked.path);
		if (remoteFile) handledRemote.add(remoteFile.id);
		if (localFile) handledLocal.add(localFile.path);
		seeds.push({
			driveId: tracked.driveId,
			localFile,
			pathHint: localFile?.path ?? tracked.path,
			remoteState: {
				file: remoteFile,
				path: remotePath,
			},
		});
	}

	for (const [path, remoteFile] of remoteByPath) {
		if (handledRemote.has(remoteFile.id)) continue;
		const localFile = localByPath.get(path);
		if (localFile) handledLocal.add(path);
		seeds.push({
			driveId: remoteFile.id,
			localFile,
			pathHint: path,
			remoteState: {
				file: remoteFile,
				path,
			},
		});
	}

	for (const [path, localFile] of localByPath) {
		if (handledLocal.has(path)) continue;
		if (ignoredRemotePaths.has(path)) continue;
		seeds.push({
			localFile,
			pathHint: path,
			remoteState: {
				file: null,
				path,
			},
		});
	}
	if (stateChanged) await plugin.saveAllData();
	return seeds;
}
