class SpatialIndexService {
  constructor(redisClient, logger) {
    this.redis = redisClient;
    this.logger = logger;
    this.INDEX_PREFIX = 'spatial:';
  }

  _encodeCoordinate(x, y) {
    const normalizedX = Math.floor((x + 1000000) / 100);
    const normalizedY = Math.floor((y + 1000000) / 100);
    return `${normalizedX}:${normalizedY}`;
  }

  async addToIndex(canvasId, item) {
    const indexKey = `${this.INDEX_PREFIX}${canvasId}`;
    const cell = this._encodeCoordinate(
      (item.bounds.minX + item.bounds.maxX) / 2,
      (item.bounds.minY + item.bounds.maxY) / 2
    );

    await this.redis.hSet(indexKey, item.id, JSON.stringify({ ...item, cell, indexedAt: Date.now() }));
    const cellKey = `${indexKey}:cell:${cell}`;
    await this.redis.sAdd(cellKey, item.id);
    return true;
  }

  async query(canvasId, point, radius) {
    const indexKey = `${this.INDEX_PREFIX}${canvasId}`;
    const centerCell = this._encodeCoordinate(point.x, point.y);
    const cellKey = `${indexKey}:cell:${centerCell}`;
    const ids = await this.redis.sMembers(cellKey);

    const results = [];
    if (ids.length > 0) {
      const pipeline = this.redis.multi();
      for (const id of ids) pipeline.hGet(indexKey, id);
      const records = await pipeline.exec();

      for (const record of records) {
        if (record) {
          const data = JSON.parse(record);
          if (this._pointToBoundsDistance(point, data.bounds) <= radius) {
            results.push(data);
          }
        }
      }
    }
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  async getIndexSnapshot(canvasId) {
    const indexKey = `${this.INDEX_PREFIX}${canvasId}`;
    const allData = await this.redis.hGetAll(indexKey);
    return Object.entries(allData).map(([id, value]) => {
      const parsed = JSON.parse(value);
      return { id, bounds: parsed.bounds, artistId: parsed.artistId, timestamp: parsed.timestamp };
    });
  }

  _pointToBoundsDistance(point, bounds) {
    const closestX = Math.max(bounds.minX, Math.min(point.x, bounds.maxX));
    const closestY = Math.max(bounds.minY, Math.min(point.y, bounds.maxY));
    return Math.sqrt(Math.pow(point.x - closestX, 2) + Math.pow(point.y - closestY, 2));
  }
}

module.exports = SpatialIndexService;
