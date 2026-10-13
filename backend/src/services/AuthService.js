const jwt = require('jsonwebtoken');

class AuthService {
  constructor(prisma, logger) {
    this.prisma = prisma;
    this.logger = logger;
    this.JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  }

  async verifyToken(token) {
    try {
      const decoded = jwt.verify(token, this.JWT_SECRET);
      return await this.prisma.user.findUnique({ where: { id: decoded.userId } });
    } catch (error) {
      return null;
    }
  }

  generateToken(userId) {
    return jwt.sign({ userId }, this.JWT_SECRET, { expiresIn: '7d' });
  }

  async checkWritePermission(userId, canvasId) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { contributions: { where: { canvasId } } }
    });

    if (!user || user.banned) return false;
    if (Date.now() - user.createdAt.getTime() < 24 * 60 * 60 * 1000) return false;
    if (user.contributions.length > 1000) return false;
    return true;
  }

  /**
   * Wallet auth (EIP-191 personal_sign).
   * Client signs the exact challenge message issued via `auth:challenge`.
   * Message format (ASCII, \n-separated):
   *   Skulkworks sign-in
   *   canvas: <canvasId>
   *   nonce: <nonce>
   *   issued: <timestamp ms>
   */
  _parseAuthMessage(message) {
    if (typeof message !== 'string') return null;
    const lines = message.split('\n');
    if (lines.length !== 4 || lines[0] !== 'Skulkworks sign-in') return null;
    const canvasId = lines[1].startsWith('canvas: ') ? lines[1].slice(8) : null;
    const nonce = lines[2].startsWith('nonce: ') ? lines[2].slice(7) : null;
    const issuedAt = lines[3].startsWith('issued: ') ? Number(lines[3].slice(8)) : NaN;
    if (!canvasId || !nonce || !Number.isFinite(issuedAt)) return null;
    return { canvasId, nonce, issuedAt };
  }

  async findOrCreateWalletUser(walletAddress) {
    const address = walletAddress.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { walletAddress: address } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          walletAddress: address,
          displayName: `${address.slice(0, 6)}...${address.slice(-4)}`
        }
      });
      this.logger.info(`Created wallet user ${address}`);
    }
    return user.banned ? null : user;
  }

  async verifyWalletAuth({ walletAddress, message, signature, canvasId, redis }) {
    const parsed = this._parseAuthMessage(message);
    if (!parsed) return null;
    if (parsed.canvasId !== canvasId) return null;
    if (Date.now() - parsed.issuedAt > 5 * 60 * 1000) return null;

    // Nonce is one-time use
    const nonceKey = `auth:nonce:${parsed.nonce}`;
    const raw = await redis.get(nonceKey);
    if (!raw) return null;
    await redis.del(nonceKey);
    try {
      if (JSON.parse(raw).canvasId !== canvasId) return null;
    } catch {
      return null;
    }

    let recovered;
    try {
      recovered = require('ethers').verifyMessage(message, signature);
    } catch {
      return null;
    }
    if (!recovered || recovered.toLowerCase() !== String(walletAddress).toLowerCase()) return null;

    return this.findOrCreateWalletUser(walletAddress);
  }
}

module.exports = AuthService;
