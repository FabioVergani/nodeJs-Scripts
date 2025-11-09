import { existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
/*
npm update -g esbuild
npm unlink esbuild
npm link esbuild
*/
import * as esbuild from 'esbuild';

/**
 * @typedef {Object} BuildOptions
 * @property {string} [distDir='dist'] - Output directory.
 * @property {string} [entryPoint='files/index.mjs'] - Entry point file.
 * @property {string} [bundleFile='bundle.mjs'] - Output bundle file name.
 * @property {boolean} [minify=false] - Whether to minify the output.
 * @property {boolean} [keepNames=true] - Whether to keep names in the bundle.
 * @property {number} [maxBackups=100] - Maximum number of backups to keep.
 */

/**
 * Builds the entry point file using esbuild.
 *
 * @param {BuildOptions} [opts] - Configuration options for the build process.
 * @returns {Promise<{success: boolean, outfile: string}>} A promise that resolves with the build status and the output file path.
 * @throws {Error} Throws an error if the esbuild or file system operations fail.
 */
// prettier-ignore
export const buildFn = async opts => {
	const {
		distDir = 'dist',
		entryPoint = 'files/index.mjs',
		bundleFile = 'bundle.mjs',
		minify = false,
		keepNames = true,
		maxBackups = 100
	} = opts || {};
	const nLen = Math.max(3, Math.ceil(Math.log10(maxBackups + 1)));
	try {
		const dest = join(distDir, bundleFile);
		if (existsSync(distDir)) {
			if (existsSync(dest)) {
				const lastDotIndex = bundleFile.lastIndexOf('.');
				const [baseName, fileExt] =
					0 < lastDotIndex
						? [
								bundleFile.substring(0, lastDotIndex),
								bundleFile.substring(lastDotIndex)
							]
						: [
								bundleFile,
								''
							];
				const bkpPrefix = `${baseName}.old.`;
				const pfxLen = bkpPrefix.length;
				const prevs = [];
				let maxNum = -1;
				for (const file of readdirSync(distDir)) {
					if (
						file.endsWith(fileExt) &&
						file.startsWith(bkpPrefix)
					) {
						const numStr = file.substring(pfxLen, pfxLen + nLen);
						if (
							nLen === numStr.length &&
							file.length === pfxLen + nLen + fileExt.length
						) {
							let isValid = true;
							for (let i = 0; nLen > i; ++i) {
								const code = numStr.charCodeAt(i);
								if (48 > code || 57 < code) {
									isValid = false;
									break;
								}
							}
							if (isValid) {
								const n = parseInt(numStr, 10);
								if (n < maxBackups) {
									if (maxNum < n) {
										maxNum = n;
									}
									prevs.push({
										path: join(distDir, file),
										num: n
									});
								}
							}
						}
					}
				}
				const nextN = (maxNum + 1) % maxBackups;
				const backupFile = `${
					bkpPrefix
				}${
					nextN.toString().padStart(nLen, '0')
				}${
					fileExt
				}`;
				const count = prevs.length;
				if (maxBackups <= count) {
					const deleted = [];
					for (const { num, path } of prevs) {
						if (nextN === num) {
							unlinkSync(path);
							deleted.push(path);
							break;
						}
					}
					deleted.length && console.info({ deleted });
				}
				renameSync(dest, join(distDir, backupFile));
				console.log('📦', backupFile);
			}
		} else {
			mkdirSync(distDir, {
				recursive: true
			});
		}
		await esbuild.build({
			entryPoints: [entryPoint],
			outfile: dest,
			bundle: true,
			treeShaking: true,
			legalComments: 'none',
			platform: 'browser',
			target: 'esnext',
			format: 'esm',
			keepNames,
			minify
		});
		console.log('✅: Built', dest);
		return {
			success: true,
			outfile: dest
		};
	} catch (exception) {
		console.error('❌: Build', exception);
		throw exception;
	}
};
