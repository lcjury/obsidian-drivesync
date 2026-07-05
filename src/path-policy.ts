function pathIsInside(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}/`);
}

const excludedConfigFiles = new Set([
	'workspace.json',
	'workspace-mobile.json',
	'graph.json',
]);

export function isConfigPath(path: string, configDir: string): boolean {
	return pathIsInside(path, configDir);
}

export function isExcludedPath(path: string, configDir: string): boolean {
	if (!isConfigPath(path, configDir)) return false;

	const relativePath =
		path === configDir ? '' : path.substring(configDir.length + 1);
	if (!relativePath) return false;

	const ownPluginPath = 'plugins/drivesync';
	if (pathIsInside(relativePath, ownPluginPath)) return true;

	const parts = relativePath.split('/');
	const excludedDirectories = new Set([
		'node_modules',
		'.git',
		'.cache',
		'cache',
		'caches',
		'.tmp',
		'tmp',
		'temp',
	]);
	if (parts.some((part) => excludedDirectories.has(part))) return true;

	const name = parts[parts.length - 1] ?? '';
	const lowerName = name.toLowerCase();
	return (
		excludedConfigFiles.has(name) ||
		lowerName === '.ds_store' ||
		lowerName === 'thumbs.db' ||
		lowerName === 'desktop.ini' ||
		lowerName.endsWith('.log') ||
		lowerName.endsWith('.tmp') ||
		lowerName.endsWith('.temp') ||
		lowerName.endsWith('.swp') ||
		lowerName.endsWith('.swo') ||
		lowerName.endsWith('~')
	);
}
