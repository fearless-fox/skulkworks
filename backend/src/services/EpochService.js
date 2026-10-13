const { Worker } = require('bullmq');

class EpochService {
  constructor(prisma, redis, queue, logger, archiveProvider, timelapseService) {
    this.prisma = prisma;
    this.redis = redis;
    this.queue = queue;
    this.logger = logger;
    this.archiveProvider = archiveProvider;
    this.timelapseService = timelapseService || null;
    this.CHECK_INTERVAL = 60000;
  }

  async initialize(io) {
    this.io = io || null;
    await this.queue.add('monitor-epochs', {}, {
      repeat: { every: this.CHECK_INTERVAL },
      jobId: 'epoch-monitor'
    });

    this.worker = new Worker('epoch-transitions', async (job) => {
      if (job.name === 'monitor-epochs') await this.checkEpochTransitions();
      else if (job.name === 'archive-canvas') await this.archiveCanvas(job.data.canvasId);
    }, { connection: this.redis });

    this.logger.info('Epoch service initialized');
  }

  async checkEpochTransitions() {
    const now = new Date();
    const canvases = await this.prisma.canvas.findMany({
      where: {
        epoch: {
          OR: [
            { state: 'OPEN', endsAt: { lte: now } },
            { state: 'READ_ONLY', archiveAt: { lte: now } }
          ]
        }
      },
      include: { epoch: true }
    });

    for (const canvas of canvases) {
      if (canvas.epoch.state === 'OPEN') await this.transitionToReadOnly(canvas);
      else if (canvas.epoch.state === 'READ_ONLY') {
        await this.queue.add('archive-canvas', { canvasId: canvas.id }, { delay: 1000 });
      }
    }
  }

  async transitionToReadOnly(canvas) {
    await this.prisma.epoch.update({
      where: { canvasId: canvas.id },
      data: { state: 'READ_ONLY', archiveAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
    });

    const io = this.io;
    if (io) {
      io.to(`canvas:${canvas.id}`).emit('epoch:transition', {
        previousState: 'OPEN',
        newState: 'READ_ONLY',
        triggeredAt: Date.now(),
        scheduledArchive: Date.now() + 24 * 60 * 60 * 1000,
        finalizationProgress: 0,
        message: 'Canvas is now view-only. Finalizing artwork...'
      });
    }
    this.logger.info(`Canvas ${canvas.id} transitioned to READ_ONLY`);
  }

  async archiveCanvas(canvasId) {
    this.logger.info(`Starting archival for canvas ${canvasId}`);

    const transactions = await this.prisma.transaction.findMany({
      where: { canvasId },
      orderBy: { timestamp: 'asc' },
      include: { artist: true }
    });

    const svg = await this.generateSVG(transactions);

    if (!this.archiveProvider) {
      throw new Error('No archive provider configured');
    }
    const archiveUrl = await this.archiveProvider.archive(canvasId, svg);

    await this.prisma.epoch.update({
      where: { canvasId },
      data: { state: 'ARCHIVED', archiveUrl }
    });

    const contributors = await this.prisma.transaction.groupBy({
      by: ['userId'], where: { canvasId }
    });

    // Timelapse: replay the transaction log into an .mp4 (best effort —
    // a failed render must not block archival)
    let timeLapseUrl = null;
    if (this.timelapseService) {
      try {
        timeLapseUrl = await this.timelapseService.renderTimelapse(canvasId, transactions);
      } catch (e) {
        this.logger.warn(`Timelapse render failed for canvas ${canvasId}: ${e.message}`);
      }
    }

    const io = this.io;
    if (io) {
      io.to(`canvas:${canvasId}`).emit('epoch:archived', {
        archiveUrl,
        contributorCount: contributors.length,
        totalStrokes: transactions.filter(t => t.type === 'stroke').length,
        timeLapseUrl
      });
    }
    this.logger.info(`Canvas ${canvasId} archived successfully`);
  }

  async generateSVG(transactions) {
    let svgContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100000">';
    for (const tx of transactions) {
      if (tx.type === 'stroke' && tx.payload?.path) {
        svgContent += `<path d="${tx.payload.path}" stroke="${tx.payload.style?.color || '#000'}" stroke-width="${tx.payload.style?.size || 1}" fill="none" opacity="${tx.payload.style?.opacity || 1}"/>`;
      }
    }
    svgContent += '</svg>';
    return svgContent;
  }
}

module.exports = EpochService;
