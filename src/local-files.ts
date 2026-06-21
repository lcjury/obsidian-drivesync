import { normalizePath, type DataAdapter } from 'obsidian';
import type { LocalFileState } from './types';
import { isExcludedPath } from './path-policy';

export async function getLocalFile(
	adapter: DataAdapter,
	path: string,
	configDir: string,
): Promise<LocalFileState | null> {
	const normalizedPath = normalizePath(path);
	if (isExcludedPath(normalizedPath, configDir)) return null;

	const stat = await adapter.stat(normalizedPath);
	if (!stat || stat.type !== 'file') return null;
	return {
		path: normalizedPath,
		mtime: stat.mtime,
		size: stat.size,
	};
}

export async function listLocalFiles(
	adapter: DataAdapter,
	configDir: string,
): Promise<LocalFileState[]> {
	const files: LocalFileState[] = [];
	const folderQueue = [''];

	while (folderQueue.length > 0) {
		const folder = folderQueue.shift()!;
		const listed = await adapter.list(folder);

		for (const childFolder of listed.folders) {
			const normalized = normalizePath(childFolder);
			if (!isExcludedPath(normalized, configDir)) {
				folderQueue.push(normalized);
			}
		}

		for (const childFile of listed.files) {
			const localFile = await getLocalFile(
				adapter,
				childFile,
				configDir,
			);
			if (localFile) files.push(localFile);
		}
	}

	return files;
}

export async function readLocalFile(
	adapter: DataAdapter,
	file: LocalFileState,
): Promise<ArrayBuffer> {
	return adapter.readBinary(file.path);
}

export async function writeLocalFile(
	adapter: DataAdapter,
	path: string,
	content: ArrayBuffer,
	mtime?: number,
): Promise<LocalFileState> {
	await adapter.writeBinary(
		normalizePath(path),
		content,
		mtime === undefined ? undefined : { mtime },
	);
	const stat = await adapter.stat(normalizePath(path));
	if (!stat || stat.type !== 'file') {
		throw new Error(`Could not read local file after writing: ${path}`);
	}
	return {
		path: normalizePath(path),
		mtime: stat.mtime,
		size: stat.size,
	};
}
