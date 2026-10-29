// Produces the standalone "HTML version" next to the build.
import fs from 'node:fs';
fs.mkdirSync('../html', { recursive: true });
fs.copyFileSync('dist/index.html', '../html/videoflow.html');
console.log('Standalone HTML written to html/videoflow.html');
