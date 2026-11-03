import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/styles.css', import.meta.url), new URL('../dist/styles.css', import.meta.url));
copyFileSync(new URL('../src/studio.css', import.meta.url), new URL('../dist/studio.css', import.meta.url));
copyFileSync(new URL('../../LICENSE', import.meta.url), new URL('../dist/LICENSE', import.meta.url));