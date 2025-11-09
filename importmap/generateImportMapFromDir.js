import { readdir, stat, writeFile, readFile } from 'fs/promises';
import { join, extname, relative, basename } from 'path';

/**
 * @typedef {object} CacheEntry
 * @property {Promise<any>} promise - The promise representing the ongoing fetch operation.
 * @property {AbortController} controller - The AbortController associated with the operation.
 */

/**
 * A cache implementation that stores promises and their corresponding AbortControllers.
 * @template K - The type of the key.
 * @template V - The type of the value resolved by the fetch function.
 */
// prettier-ignore
class AbortableCache {
	/** @type {(key: K, signal: AbortSignal) => Promise<V>} */
	#fetch;
	/** @type {Map<K, CacheEntry>} */
	#cache;
	/**
	 * @param {(key: K, signal: AbortSignal) => Promise<V>} fn - The function to call when a cache miss occurs. 
	 * It must accept the key and an AbortSignal.
	 */
	constructor(fn) {
		this.#fetch = fn;
		this.#cache = new Map();
	}
	/**
	 * Gets the value associated with the key. If the key is not in the cache, 
	 * it calls the fetch function and stores the resulting Promise and AbortController.
	 * @param {K} key - The key to look up.
	 * @returns {Promise<V>} The promise for the requested value.
	 */
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
	/**
	 * Aborts all ongoing fetch operations and clears the entire cache.
	 */
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

/**
 * @typedef {object} ImportMapOptions
 * @property {string} [output] - Optional path to write the generated import map JSON file.
 * @property {string[]} [excludedPatterns] - An array of strings used to exclude files or directories if their path or name includes any of these patterns.
 * @property {string[]} [includedExtensions] - An array of file extensions (e.g., 'js', '.mjs') to include in the map. Defaults to ['mjs', 'js'].
 * @property {number} [maxDepth] - The maximum directory depth to scan. Defaults to 10000.
 */

/**
 * @typedef {object} ImportMap
 * @property {Record<string, string>} imports - The generated mapping of specifiers to relative paths.
 */

/**
 * Scans a directory recursively to generate an Import Map object (specifiers -> relative paths).
 * It respects 'package.json' `main` and `exports` fields for directory imports.
 * @param {string} rootDir - The root directory to start scanning from.
 * @param {ImportMapOptions} [options] - Configuration options for the import map generation.
 * @returns {Promise<Record<string, string>>} A promise that resolves to the generated import map data (the 'imports' object content).
 * @throws {Error} If `rootDir` does not exist or is not a directory.
 */
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
	/** @type {[AbortableCache<string, import('fs').Stats | null>, AbortableCache<string, string[] | []>]} */
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
	/** @type {ImportMapOptions} */
	options ||= {};
	const excludedPatterns = options.excludedPatterns?.filter(Boolean) || [];
	const hasExclusions = 0 < excludedPatterns.length;
	/** @type {Set<string>} */
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
	/** @type {(path: string) => string} */
	const relativeToRootDir = path => relative(rootDir, path).replaceAll('\\', '/');
	/** @type {Record<string, string>} */
	const data = {};
	/** @type {Set<string>} */
	const scanned = new Set();
	const maxLimit = 1e4;
	const depthMax = options.maxDepth ? Math.max(1, Math.min(maxLimit, options.maxDepth)) : maxLimit;
	/**
	 * Attempts to resolve an export value from a package exports object based on common conventions.
	 * @param {object} x - The exports object or condition value.
	 * @returns {string | null} The resolved export path or null.
	 */
	const resolveExport = x => (
		x.default ||
		x.browser ||
		x.import ||
		x.node ||
		Object.values(x)[0]
	);
	/**
	 * Recursively scans a directory.
	 * @param {string} dir - The current directory path.
	 * @param {number} [depth=0] - The current recursion depth.
	 * @returns {Promise<boolean | undefined>} A promise that resolves to `true` if the directory or its subdirectories contain files that were mapped, otherwise `false` or `undefined`.
	 */
	const scan = async (dir, depth = 0) => {
		if (
			depthMax > depth &&
			!scanned.has(dir)
		) {
			scanned.add(dir);
			/** @type {Promise<({fullPath: string, relPath: string, stats: import('fs').Stats, item: string} | null)[]>} */
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
			/** @type {{main?: string, exports?: string | Record<string, any>} | null} */
			let pkg = null;
			let hasFiles = false;
			/** @type {(Promise<boolean | undefined>)[]} */
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
				/** @type {(e: string) => string} */
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
										/** @type {string | Record<string, any> | undefined} */
										let subValue = pe[subpath];
										if (subValue) {
											/** @type {string | null} */
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
