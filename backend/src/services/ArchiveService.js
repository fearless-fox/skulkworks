const fs = require('fs').promises;
const path = require('path');

/**
 * Archive providers persist finished-epoch artifacts and return public URLs.
 *
 * The EpochService only talks to this interface: archive(canvasId, svgString) -> url.
 *
 * LocalDiskArchiveProvider (default): writes SVG to ./archives, served by
 * express.static at /archives. Good for dev and single-server deploys.
 *
 * IPFS (Hall of Fame): implement a provider that pins the SVG via Pinata,
 * web3.storage, or Kubo RPC and returns the gateway URL, then set
 * ARCHIVE_PROVIDER=ipfs. Needs provider API keys — see .env.example.
 */
class LocalDiskArchiveProvider {
  constructor({ dir, baseUrl, logger }) {
    this.dir = dir;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.logger = logger;
  }

  async archive(canvasId, svgString) {
    await fs.mkdir(this.dir, { recursive: true });
    const filename = `${canvasId}.svg`;
    await fs.writeFile(path.join(this.dir, filename), svgString, 'utf8');
    const url = `${this.baseUrl}/archives/${filename}`;
    this.logger.info(`Archived canvas ${canvasId} -> ${url}`);
    return url;
  }
}

function createArchiveProvider(logger) {
  const provider = (process.env.ARCHIVE_PROVIDER || 'local').toLowerCase();
  if (provider === 'local') {
    return new LocalDiskArchiveProvider({
      dir: path.join(__dirname, '..', '..', 'archives'),
      baseUrl: process.env.ARCHIVE_BASE_URL || 'http://localhost:4000',
      logger
    });
  }
  throw new Error(`Unknown ARCHIVE_PROVIDER: ${provider} (supported: local)`);
}

module.exports = { LocalDiskArchiveProvider, createArchiveProvider };
