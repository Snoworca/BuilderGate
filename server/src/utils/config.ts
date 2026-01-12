import JSON5 from 'json5';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Config {
  server: {
    port: number;
  };
  pty: {
    termName: string;
    defaultCols: number;
    defaultRows: number;
    useConpty: boolean;
    maxBufferSize: number;
  };
  session: {
    idleDelayMs: number;
  };
}

const defaultConfig: Config = {
  server: {
    port: 4242,
  },
  pty: {
    termName: 'xterm-256color',
    defaultCols: 80,
    defaultRows: 24,
    useConpty: false,
    maxBufferSize: 65536,
  },
  session: {
    idleDelayMs: 200,
  },
};

function loadConfig(): Config {
  try {
    const configPath = join(__dirname, '../../config.json5');
    const configContent = readFileSync(configPath, 'utf-8');
    const userConfig = JSON5.parse(configContent);

    // Deep merge with defaults
    return {
      server: { ...defaultConfig.server, ...userConfig.server },
      pty: { ...defaultConfig.pty, ...userConfig.pty },
      session: { ...defaultConfig.session, ...userConfig.session },
    };
  } catch (error) {
    console.warn('Failed to load config.json5, using defaults:', error);
    return defaultConfig;
  }
}

export const config = loadConfig();
