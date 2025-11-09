import { buildFn } from './scripts/builder.mjs';

const options = {};
// e.g:  node build.js --minify=true
process.argv.slice(2).forEach(arg => {
	if (arg.startsWith('--')) {
		const [key, value] = arg.slice(2).split('=');
		if (value) {
			options[key] =
				'true' === value
					? true
					: 'false' === value
						? false
						: !isNaN(value)
							? Number(value)
							: value;
		}
	}
});

buildFn(options).catch(() => {
	process.exit(1);
});
