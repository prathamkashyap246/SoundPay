// Packs the Jam Lab (public/lab/) into ONE self-contained HTML file: its CSS, its JS (bundled with esbuild,
// including the modem from public/hop/) and ggwave all inline. Open it from disk, or host it anywhere.
//   node tools/build-lab.mjs [out=dist/jam-lab.html]
// Needs network once for `npx esbuild`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(root, process.argv[2] || 'dist/jam-lab.html');
const html = fs.readFileSync(path.join(root, 'public/lab/index.html'), 'utf8');
const body = html.split('<!-- LAB:BODY -->')[1].split('<!-- /LAB:BODY -->')[0].trim();
const css = fs.readFileSync(path.join(root, 'public/lab/lab.css'), 'utf8');
const ggwave = fs.readFileSync(path.join(root, 'node_modules/ggwave/ggwave.js'), 'utf8');
const js = execFileSync('npx', ['--yes', 'esbuild@0.24.0', path.join(root, 'public/lab/lab.js'), '--bundle', '--format=iife', '--target=es2022'], { encoding: 'utf8', maxBuffer: 1 << 26 });
const inline = s => s.replace(/<\/script/gi, '<\\/script');

const page = `<title>SoundPay Jam Lab</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Try to jam a payment sent over sound: ggwave vs SoundPay's frequency-hopping modem, simulated in your browser.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet">
<style>
${css}
</style>
${body}
<script>
${inline(ggwave)}
</script>
<script>
${inline(js)}
</script>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`${path.relative(root, out)}: ${(page.length / 1024).toFixed(0)} KB`);
