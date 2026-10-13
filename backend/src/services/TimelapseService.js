const { createCanvas, Path2D } = require('canvas');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * TimelapseService — replays a canvas's transaction log into an .mp4.
 *
 * Strokes are drawn cumulatively (frame N shows the first N strokes), fitted
 * into 1920x1080, encoded with ffmpeg (libx264). Output lands next to the
 * SVG archive and is served from /archives.
 *
 * Requires the `canvas` npm package and an `ffmpeg` binary on PATH.
 */
class TimelapseService {
  constructor({ logger, archiveDir, baseUrl, width = 1920, height = 1080, fps = 30, maxFrames = 300 }) {
    this.logger = logger;
    this.archiveDir = archiveDir;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.maxFrames = maxFrames;
  }

  _unionBounds(strokes) {
    let b = null;
    for (const s of strokes) {
      const sb = s.payload?.bounds;
      if (!sb) continue;
      b = b
        ? {
            minX: Math.min(b.minX, sb.minX), maxX: Math.max(b.maxX, sb.maxX),
            minY: Math.min(b.minY, sb.minY), maxY: Math.max(b.maxY, sb.maxY),
          }
        : { ...sb };
    }
    if (!b || b.maxX <= b.minX || b.maxY <= b.minY) {
      b = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    }
    // Pad 5%
    const padX = (b.maxX - b.minX) * 0.05;
    const padY = (b.maxY - b.minY) * 0.05;
    return {
      minX: b.minX - padX, maxX: b.maxX + padX,
      minY: b.minY - padY, maxY: b.maxY + padY,
    };
  }

  _drawStroke(ctx, stroke, transform) {
    const pathStr = stroke.payload?.path;
    if (!pathStr) return;
    const style = stroke.payload?.style || {};
    try {
      const p = new Path2D(pathStr);
      ctx.save();
      ctx.translate(transform.tx, transform.ty);
      ctx.scale(transform.scale, transform.scale);
      ctx.globalAlpha = style.opacity ?? 1;
      ctx.fillStyle = style.color || '#ffffff';
      ctx.fill(p);
      ctx.restore();
    } catch (e) {
      // Skip malformed paths rather than killing the render
    }
  }

  _runFfmpeg(framePattern, outPath, frameCount) {
    return new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-framerate', String(this.fps),
        '-i', framePattern,
        '-frames:v', String(frameCount),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outPath,
      ];
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message} (is ffmpeg on PATH?)`)));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  }

  async renderTimelapse(canvasId, transactions) {
    const strokes = transactions.filter((t) => t.type === 'stroke' && t.payload?.path);
    if (strokes.length === 0) {
      this.logger.info(`No strokes for timelapse of canvas ${canvasId}`);
      return null;
    }

    const bounds = this._unionBounds(strokes);
    const scale = Math.min(
      this.width / (bounds.maxX - bounds.minX),
      this.height / (bounds.maxY - bounds.minY)
    );
    const transform = {
      scale,
      tx: (this.width - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale,
      ty: (this.height - (bounds.maxY - bounds.minY) * scale) / 2 - bounds.minY * scale,
    };

    const frameCount = Math.min(this.maxFrames, strokes.length);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `skulkworks-tl-${canvasId}-`));
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');

    try {
      // Dark ground, matching the app
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, this.width, this.height);

      for (let i = 0; i < frameCount; i++) {
        // Cumulative: frame i draws strokes up to this point
        const endIdx = Math.floor(((i + 1) * strokes.length) / frameCount);
        const startIdx = Math.floor((i * strokes.length) / frameCount);
        for (let k = startIdx; k < endIdx; k++) {
          this._drawStroke(ctx, strokes[k], transform);
        }
        const buf = canvas.toBuffer('image/png');
        await fs.writeFile(path.join(tmpDir, `frame_${String(i).padStart(4, '0')}.png`), buf);
      }

      const outName = `${canvasId}.mp4`;
      const outTmp = path.join(tmpDir, outName);
      await this._runFfmpeg(path.join(tmpDir, 'frame_%04d.png'), outTmp, frameCount);

      await fs.mkdir(this.archiveDir, { recursive: true });
      await fs.copyFile(outTmp, path.join(this.archiveDir, outName));

      const url = `${this.baseUrl}/archives/${outName}`;
      this.logger.info(`Timelapse for canvas ${canvasId}: ${frameCount} frames -> ${url}`);
      return url;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

module.exports = TimelapseService;
