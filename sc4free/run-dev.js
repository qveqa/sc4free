const { spawn } = require('child_process');
const path = require('path');

console.log('Starting Vite dev server...');

// Spawn local vite compiler directly via node to avoid any npx shell prompts
const vitePath = path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn('node', [vitePath], { stdio: 'pipe' });

let electronStarted = false;

vite.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(`[Vite] ${output}`);
  
  // Start Electron once Vite local URL is ready
  if (!electronStarted && (output.includes('http://') || output.includes('Local:'))) {
    electronStarted = true;
    console.log('Vite dev server is ready! Starting Electron...');
    startElectron();
  }
});

vite.stderr.on('data', (data) => {
  process.stderr.write(`[Vite Error] ${data}`);
});

function startElectron() {
  // Spawn electron using local node_modules binary directly
  const electronPath = path.join(__dirname, 'node_modules', 'electron', 'cli.js');
  const electron = spawn('node', [electronPath, '.', '--enable-logging'], { stdio: 'inherit' });

  electron.on('close', (code) => {
    console.log(`Electron closed with code ${code}. Stopping Vite...`);
    vite.kill();
    process.exit(code);
  });
}
