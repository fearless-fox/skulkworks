class CollisionService {
  constructor(redisClient, logger) {
    this.redis = redisClient;
    this.logger = logger;
    this.LOCK_PREFIX = 'lock:';
    this.OCCUPANCY_PREFIX = 'occ:';
    this.GRID_SIZE = 100;
  }

  _getGridCells(bounds) {
    const cells = [];
    const startX = Math.floor(bounds.minX / this.GRID_SIZE);
    const endX = Math.floor(bounds.maxX / this.GRID_SIZE);
    const startY = Math.floor(bounds.minY / this.GRID_SIZE);
    const endY = Math.floor(bounds.maxY / this.GRID_SIZE);

    for (let x = startX; x <= endX; x++) {
      for (let y = startY; y <= endY; y++) {
        cells.push(`${x},${y}`);
      }
    }
    return cells;
  }

  async checkCollision(canvasId, bounds, opacity) {
    const occupancyKey = `${this.OCCUPANCY_PREFIX}${canvasId}`;
    const gridCells = this._getGridCells(bounds);

    const pipeline = this.redis.multi();
    for (const cell of gridCells) {
      pipeline.hGet(occupancyKey, cell);
    }

    const results = await pipeline.exec();
    const conflicts = [];
    let maxExistingOpacity = 0;

    for (let i = 0; i < results.length; i++) {
      if (results[i]) {
        const data = JSON.parse(results[i]);
        maxExistingOpacity = Math.max(maxExistingOpacity, data.opacity || 1.0);
        if (this._boundsOverlap(bounds, data.bounds)) {
          conflicts.push({
            type: 'base_layer',
            region: data.bounds,
            existingArtistId: data.artistId,
            existingTransactionId: data.transactionId
          });
        }
      }
    }

    const opacityThreshold = 0.3;
    if (maxExistingOpacity > 0.1 && opacity > opacityThreshold) {
      return {
        allowed: false,
        reason: 'Base layer occupancy exceeds threshold',
        conflicts,
        alternative: { type: 'sticker_conversion', maxOpacity: 0.3 }
      };
    }

    return { allowed: true, conflicts: [], gridCells };
  }

  async lockRegion(canvasId, bounds, connectionId, ttlMs) {
    const lockKey = `${this.LOCK_PREFIX}${canvasId}`;
    const lockId = `${connectionId}:${Date.now()}`;

    const existingLocks = await this.redis.hGetAll(lockKey);
    for (const [key, value] of Object.entries(existingLocks)) {
      const lock = JSON.parse(value);
      if (this._boundsOverlap(bounds, lock.bounds) && Date.now() < lock.expiresAt) {
        return { success: false, reason: 'Region locked by another user' };
      }
    }

    await this.redis.hSet(lockKey, lockId, JSON.stringify({
      bounds, connectionId, expiresAt: Date.now() + ttlMs
    }));
    await this.redis.expire(lockKey, Math.ceil(ttlMs / 1000));

    return { success: true, lockId };
  }

  async verifyLock(canvasId, lockId) {
    if (!lockId) return false;
    const lockKey = `${this.LOCK_PREFIX}${canvasId}`;
    const raw = await this.redis.hGet(lockKey, lockId);
    if (!raw) return false;
    const lock = JSON.parse(raw);
    return Date.now() < lock.expiresAt;
  }

  async releaseLock(canvasId, lockId) {
    const lockKey = `${this.LOCK_PREFIX}${canvasId}`;
    await this.redis.hDel(lockKey, lockId);
    return true;
  }

  async markOccupied(canvasId, bounds, metadata) {
    const occupancyKey = `${this.OCCUPANCY_PREFIX}${canvasId}`;
    const gridCells = this._getGridCells(bounds);

    const pipeline = this.redis.multi();
    for (const cell of gridCells) {
      pipeline.hSet(occupancyKey, cell, JSON.stringify({ ...metadata, bounds, cell }));
    }
    await pipeline.exec();
    return true;
  }

  _boundsOverlap(a, b) {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
  }
}

module.exports = CollisionService;
