const fs = require('fs');
const path = require('path');

/**
 * BrushService — brush catalog + entitlements.
 *
 * The catalog (id/tier/price) is the single source of truth in
 * shared/brushes.json. Entitlements answer: may this user commit with
 * this brush? Free brushes: always. Premium/ad: needs an unexpired grant.
 *
 * The commit path MUST validate through here — clients can forge any
 * brushId in the payload, so the server is the source of truth.
 */
class BrushService {
  constructor(prisma, logger) {
    this.prisma = prisma;
    this.logger = logger;
    const manifestPath = path.join(__dirname, '..', '..', '..', 'shared', 'brushes.json');
    const raw = fs.readFileSync(manifestPath, 'utf8');
    this.catalog = JSON.parse(raw).brushes;
    this.byId = new Map(this.catalog.map((b) => [b.id, b]));
    logger.info(`Brush catalog loaded: ${this.catalog.length} brushes`);
  }

  getBrush(brushId) {
    return this.byId.get(brushId) || null;
  }

  listBrushes() {
    return this.catalog;
  }

  /**
   * Check entitlement. Returns { ok: true } or { ok: false, reason }.
   * Reasons: UNKNOWN_BRUSH, NOT_OWNED.
   */
  async isEntitled(userId, brushId) {
    const brush = this.getBrush(brushId);
    if (!brush) return { ok: false, reason: 'UNKNOWN_BRUSH' };
    if (brush.tier === 'free') return { ok: true };

    const grant = await this.prisma.brushGrant.findFirst({
      where: {
        userId,
        brushId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    return grant ? { ok: true } : { ok: false, reason: 'NOT_OWNED' };
  }

  /** Issue (or refresh) a grant. expiresAt null = permanent. */
  async grantBrush(userId, brushId, source, expiresAt = null) {
    const brush = this.getBrush(brushId);
    if (!brush) throw new Error(`Unknown brush: ${brushId}`);
    const grant = await this.prisma.brushGrant.upsert({
      where: { userId_brushId_source: { userId, brushId, source } },
      update: { expiresAt },
      create: { userId, brushId, source, expiresAt },
    });
    this.logger.info(`Brush granted: ${brushId} -> ${userId} (${source})`);
    return grant;
  }

  /** Catalog annotated with ownership for a user (null userId = anonymous). */
  async catalogForUser(userId) {
    return Promise.all(
      this.catalog.map(async (b) => ({
        ...b,
        owned: b.tier === 'free' ? true : userId ? (await this.isEntitled(userId, b.id)).ok : false,
      }))
    );
  }
}

module.exports = BrushService;
