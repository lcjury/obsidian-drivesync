import type { DataAdapter } from 'obsidian';
import type { DriveFile } from './drive/client';
import { updateFileContent } from './drive/client';
import { isConfigPath } from './path-policy';
import { writeLocalFile } from './local-files';

interface ConflictParams {
	path: string;
	localContent: ArrayBuffer;
	remoteContent: ArrayBuffer;
	localMtime: number;
	remoteMtime: number;
	configDir: string;
	adapter: DataAdapter;
}

function contentsAreEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;

	const leftBytes = new Uint8Array(left);
	const rightBytes = new Uint8Array(right);
	for (let i = 0; i < leftBytes.length; i++) {
		if (leftBytes[i] !== rightBytes[i]) return false;
	}
	return true;
}

async function createConflictedCopy(
	basePath: string,
	content: ArrayBuffer,
	adapter: DataAdapter,
): Promise<string> {
	const extIndex = basePath.lastIndexOf('.');
	const baseName = extIndex > 0 ? basePath.substring(0, extIndex) : basePath;
	const ext = extIndex > 0 ? basePath.substring(extIndex) : '';

	let conflictedPath = `${baseName} (conflicted)${ext}`;
	let counter = 2;

	while (await adapter.exists(conflictedPath)) {
		conflictedPath = `${baseName} (conflicted ${counter})${ext}`;
		counter++;
	}

	await adapter.writeBinary(conflictedPath, content);
	return conflictedPath;
}

export interface ConflictResult {
	winnerPath: string;
	winnerContent: ArrayBuffer;
	loserPath: string;
	loserContent: ArrayBuffer;
	conflictedPath?: string;
}

export async function resolveConflict(
	params: ConflictParams,
): Promise<ConflictResult> {
	const {
		localContent,
		remoteContent,
		localMtime,
		remoteMtime,
	} = params;
	const localWins =
		localMtime >= remoteMtime ||
		(localMtime === 0 && remoteMtime === 0);

	if (contentsAreEqual(localContent, remoteContent)) {
		return localWins
			? {
					winnerPath: params.path,
					winnerContent: localContent,
					loserPath: params.path,
					loserContent: remoteContent,
				}
			: {
					winnerPath: params.path,
					winnerContent: remoteContent,
					loserPath: params.path,
					loserContent: localContent,
				};
	}

	if (isConfigPath(params.path, params.configDir)) {
		return localWins
			? {
					winnerPath: params.path,
					winnerContent: localContent,
					loserPath: params.path,
					loserContent: remoteContent,
				}
			: {
					winnerPath: params.path,
					winnerContent: remoteContent,
					loserPath: params.path,
					loserContent: localContent,
				};
	}

	if (localWins) {
		const conflictedPath = await createConflictedCopy(
			params.path,
			remoteContent,
			params.adapter,
		);
		return {
			winnerPath: params.path,
			winnerContent: localContent,
			loserPath: params.path,
			loserContent: remoteContent,
			conflictedPath,
		};
	}

	const conflictedPath = await createConflictedCopy(
		params.path,
		localContent,
		params.adapter,
	);
	return {
		winnerPath: params.path,
		winnerContent: remoteContent,
		loserPath: params.path,
		loserContent: localContent,
		conflictedPath,
	};
}

export async function applyConflictToLocal(
	path: string,
	content: ArrayBuffer,
	adapter: DataAdapter,
	mtime?: number,
): Promise<void> {
	await writeLocalFile(adapter, path, content, mtime);
}

export async function uploadConflictToDrive(
	accessToken: string,
	driveId: string,
	content: ArrayBuffer,
	mimeType: string,
): Promise<DriveFile> {
	return updateFileContent(accessToken, driveId, content, mimeType);
}
