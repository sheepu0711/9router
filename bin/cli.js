#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import open from 'open';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const PORT = process.env.PORT || 20128;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || `http://localhost:${PORT}`;

console.log('🚀 Starting 9Router...\n');

const spinner = ora('Checking build...').start();

// Check if .next/standalone exists (production build)
const standaloneServer = join(rootDir, '.next', 'standalone', 'server.js');
const isBuilt = existsSync(standaloneServer);

if (!isBuilt) {
  spinner.fail('Production build not found');
  console.log('\n⚠️  Please build the project first:');
  console.log('   cd', rootDir);
  console.log('   npm run build\n');
  process.exit(1);
}

spinner.text = 'Starting server...';

// Start the Next.js server
const serverProcess = spawn('node', [standaloneServer], {
  cwd: rootDir,
  env: {
    ...process.env,
    PORT: PORT.toString(),
    NODE_ENV: 'production',
    NEXT_PUBLIC_BASE_URL: BASE_URL
  },
  stdio: 'inherit'
});

// Wait a bit for server to start
setTimeout(async () => {
  spinner.succeed('Server started!');
  console.log(`\n✅ 9Router is running at: ${BASE_URL}`);
  console.log('📊 Opening dashboard in your browser...\n');

  try {
    await open(BASE_URL);
  } catch (error) {
    console.log('⚠️  Could not open browser automatically. Please visit:', BASE_URL);
  }
}, 3000);

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down 9Router...');
  serverProcess.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  serverProcess.kill();
  process.exit(0);
});

serverProcess.on('error', (error) => {
  spinner.fail('Failed to start server');
  console.error('Error:', error.message);
  process.exit(1);
});
