import { readdir, stat, writeFile, readFile } from 'fs/promises';
import { join, extname, relative, basename } from 'path';

// prettier-ignore
class AbortableCache {
	#fetch;
	#cache;
	constructor(fn) {
		this.#fetch = fn;
		this.#cache = new Map();
	}
	get(key) {
		const m = this.#cache;
		if (m.has(key)) {
			return m.get(key).promise;
		}
		const c = new AbortController();
		const p = this.#fetch(key, c.signal);
		m.set(key, {
			promise: p,
			controller: c
		});
		return p;
	}
	clear() {
		const m = this.#cache;
		for (const o of m.values()) {
			o.controller.abort();
		}
		m.clear();
	}
	/*
	abort(key) {
			const m = this.#cache;
			if (key) {
					const o = m.get(key);
					o && (
							o.controller.abort(),
							m.delete(key)
					);
			} else {
					this.clear();
			}
	}
	delete(key) {
			const m = this.#cache;
			m.get(key)?.controller.abort();
			return m.delete(key);
	}
	has(key) {
			return this.#cache.has(key);
	}
	get size() {
			return this.#cache.size;
	}
	*/
}

// prettier-ignore
export const generateImportMapFromDir = async (rootDir, options) => {
	const rootStats = await stat(rootDir).catch(e => {
		if ('ENOENT' === e.code) {
			throw new Error(`Directory does not exist: ${rootDir}`);
		}
		throw e;
	});
	if (!rootStats.isDirectory()) {
		throw new Error(`Path is not a directory: ${rootDir}`);
	}
	const [
		statsCache,
		dirCache
	] = [
		[
			() => null,
			stat
		],
		[
			() => [],
			readdir
		]
	].map(
		([a,b]) => new AbortableCache(
			(k,s) => b(
				k, {
					signal: s
				}
			).catch(
				() => a()
			)
		)
	);
	options ||= {};
	const excludedPatterns = options.excludedPatterns?.filter(Boolean) || [];
	const hasExclusions = 0 < excludedPatterns.length;
	const includedExtensions = new Set(
		(
			(
				options.includedExtensions
					?.filter(Boolean)
					?.sort((a, b) => b.length - a.length)
			) || [
				'mjs',
				'js'
			]
		).map(
			ext => (
				ext.startsWith('.')
					? ext
					: `.${ext}`
			)
		)
	);
	const relativeToRootDir = path => relative(rootDir, path).replaceAll('\\', '/');
	const data = {};
	const scanned = new Set();
	const maxLimit = 1e4;
	const depthMax = options.maxDepth ? Math.max(1, Math.min(maxLimit, options.maxDepth)) : maxLimit;
	const resolveExport = x => (
		x.default ||
		x.browser ||
		x.import ||
		x.node ||
		Object.values(x)[0]
	);
	const scan = async (dir, depth = 0) => {
		if (
			depthMax > depth &&
			!scanned.has(dir)
		) {
			scanned.add(dir);
			const statPromises = [];
			for (const item of await dirCache.get(dir)) {
				if (item.startsWith('.')) {
					continue;
				}
				const fullPath = join(dir, item);
				const relPath = relativeToRootDir(fullPath);
				if (
					hasExclusions &&
					excludedPatterns.some(
						pattern =>
							item.includes(pattern) ||
							relPath.includes(pattern)
					)
				) {
					continue;
				}
				statPromises.push(
					statsCache
						.get(fullPath)
						.then(stats => stats && {
							fullPath,
							relPath,
							stats,
							item
						})
				);
			}
			let pkg = null;
			let hasFiles = false;
			const subDirPromises = [];
			for (const result of (await Promise.all(statPromises)).filter(Boolean)) {
				const { item, fullPath, relPath, stats } = result;
				if (stats.isFile()) {
					if ('package.json' === item) {
						try {
							pkg = JSON.parse(await readFile(fullPath, 'utf8'));
						} catch (exception) {
							console.error(exception);
							console.debug(fullPath);
						}
						continue;
					}
					const itemExtension = extname(item);
					if (includedExtensions.has(itemExtension)) {
						const specifier = relPath.slice(0, -itemExtension.length);
						data[specifier] ||= `./${relPath}`;
						if ('index' === basename(item, itemExtension)) {
							const dirPath = relPath.slice(0, -item.length);
							if (dirPath) {
								data[
									dirPath.endsWith('/')
										? dirPath.slice(0, -1)
										: dirPath
								] ||= `./${
									relPath
								}`;
							}
						}
						hasFiles = true;
					}
				} else if (stats.isDirectory()) {
					const e = scan(fullPath, depth + 1)
					e && subDirPromises.push(e);
				}
			}
			const hasSubDirs = (await Promise.all(subDirPromises)).some(Boolean);
			let hasContent = hasFiles || hasSubDirs;
			const dirRelPath = relativeToRootDir(dir);
			if (dirRelPath && pkg) {
				const toNorm = e => `./${join(dirRelPath, e).replaceAll('\\', '/')}`;
				if (pkg.main) {
					data[dirRelPath] ||= (
						hasContent = true,
						toNorm(pkg.main)
					);
				}
				const pe = pkg.exports;
				if (pe) {
					let resolved = pe;
					if ('string' !== typeof pe) {
						const value = resolved = pe['.'] || pe;
						if (value && 'object' === typeof value) {
							resolved = resolveExport(value);
						}
					}
					if (resolved) {
						switch (typeof resolved) {
							case 'string':
								data[dirRelPath] ||= (
									hasContent = true,
									toNorm(resolved)
								);
								break;
							case 'object':
								for (const subpath in resolved) {
									if (
										subpath &&
										'./' === subpath[0] &&
										'./' !== subpath
									) {
										let subValue = pe[subpath];
										if (subValue) {
											let subResolved = null;
											switch (typeof subValue) {
												case 'string':
													subResolved = subValue;
													break;
												case 'object':
													subResolved = resolveExport(subValue);
													break;
											}
											if (subResolved) {
												data[
													dirRelPath +
													subpath.slice(1)
												] ||= (
													hasContent = true,
													toNorm(subResolved)
												);
											}
										}
									}
								}
								break;
						}
					}
				}
			}
			if (hasContent) {
				if (dirRelPath) {
					data[`${dirRelPath}/`] ||= `./${dirRelPath}/`;
				} else {
					data['./'] = './';
				}
			}
			return hasContent;
		}
	};
	await scan(rootDir, 0);
	scanned.clear();
	dirCache.clear();
	statsCache.clear();
	const dest = options.output;
	if (dest) {
		try {
			await writeFile(dest, JSON.stringify({ imports: data }, null, 2), 'utf8');
			console.log('✅ import map', dest);
		} catch (exception) {
			console.error('❌ import map', exception);
			throw exception;
		}
	}
	return data;
};
