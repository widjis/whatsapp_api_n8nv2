import { Redis as IORedis } from 'ioredis';

export type TicketClaimRecord = {
  ticketId: string;
  remoteJid: string;
  messageId: string;
  createdAtIso: string;
  claimed: boolean;
  claimedAtIso?: string;
  claimedByPhone?: string;
  claimedByName?: string;
};

type ClaimResult =
  | { ok: true; record: TicketClaimRecord; wasClaimed: false }
  | { ok: true; record: TicketClaimRecord; wasClaimed: true }
  | { ok: false; reason: 'not_found' | 'invalid_record' | 'storage_error' };

const inMemoryRecords = new Map<string, TicketClaimRecord>();
const inMemoryLocks = new Map<string, string>();

let redisClient: IORedis | null | undefined;

function getRedisClient(): IORedis | null {
  if (redisClient !== undefined) return redisClient;
  const host = process.env.REDIS_HOST;
  const portRaw = process.env.REDIS_PORT;
  if (!host || !portRaw) {
    redisClient = null;
    return null;
  }

  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    redisClient = null;
    return null;
  }

  const client = new IORedis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1 });
  client.on('error', (err: Error) => {
    console.error('Redis error:', err);
  });
  redisClient = client;
  return client;
}

function recordKey(remoteJid: string, messageId: string): string {
  return `ticket_claim:${remoteJid}:${messageId}`;
}

function lockKey(remoteJid: string, messageId: string): string {
  return `ticket_claim_lock:${remoteJid}:${messageId}`;
}

function parseRecord(raw: string | null): TicketClaimRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const r = parsed as Record<string, unknown>;
    const ticketId = typeof r.ticketId === 'string' ? r.ticketId : '';
    const remoteJid = typeof r.remoteJid === 'string' ? r.remoteJid : '';
    const messageId = typeof r.messageId === 'string' ? r.messageId : '';
    const createdAtIso = typeof r.createdAtIso === 'string' ? r.createdAtIso : '';
    const claimed = typeof r.claimed === 'boolean' ? r.claimed : false;
    const claimedAtIso = typeof r.claimedAtIso === 'string' ? r.claimedAtIso : undefined;
    const claimedByPhone = typeof r.claimedByPhone === 'string' ? r.claimedByPhone : undefined;
    const claimedByName = typeof r.claimedByName === 'string' ? r.claimedByName : undefined;

    if (!ticketId || !remoteJid || !messageId || !createdAtIso) return null;
    return { ticketId, remoteJid, messageId, createdAtIso, claimed, claimedAtIso, claimedByPhone, claimedByName };
  } catch {
    return null;
  }
}

export async function storeTicketNotification(args: {
  ticketId: string;
  remoteJid: string;
  messageId: string;
}): Promise<void> {
  const record: TicketClaimRecord = {
    ticketId: args.ticketId,
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    createdAtIso: new Date().toISOString(),
    claimed: false,
  };

  const key = recordKey(args.remoteJid, args.messageId);
  inMemoryRecords.set(key, record);
  inMemoryLocks.delete(lockKey(args.remoteJid, args.messageId));

  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.connect();
    await redis.set(key, JSON.stringify(record));
    await redis.del(lockKey(args.remoteJid, args.messageId));
  } catch {
    return;
  }
}

export async function loadTicketNotification(args: {
  remoteJid: string;
  messageId: string;
}): Promise<TicketClaimRecord | null> {
  const key = recordKey(args.remoteJid, args.messageId);
  const redis = getRedisClient();
  if (!redis) return inMemoryRecords.get(key) ?? null;

  try {
    await redis.connect();
    const raw = await redis.get(key);
    const parsed = parseRecord(raw);
    if (parsed) return parsed;
    return inMemoryRecords.get(key) ?? null;
  } catch {
    return inMemoryRecords.get(key) ?? null;
  }
}

export async function claimTicketNotification(args: {
  remoteJid: string;
  messageId: string;
  claimantPhone: string;
  claimantName: string;
}): Promise<ClaimResult> {
  const key = recordKey(args.remoteJid, args.messageId);
  const lock = lockKey(args.remoteJid, args.messageId);

  const existing = inMemoryRecords.get(key);
  if (!existing) {
    const redis = getRedisClient();
    if (!redis) return { ok: false, reason: 'not_found' };
    try {
      await redis.connect();
      const raw = await redis.get(key);
      const parsed = parseRecord(raw);
      if (!parsed) return { ok: false, reason: raw ? 'invalid_record' : 'not_found' };
      inMemoryRecords.set(key, parsed);
    } catch {
      return { ok: false, reason: 'storage_error' };
    }
  }

  const fromMem = inMemoryRecords.get(key);
  if (!fromMem) return { ok: false, reason: 'not_found' };
  if (fromMem.claimed) return { ok: true, record: fromMem, wasClaimed: true };

  const redis = getRedisClient();
  if (!redis) {
    if (inMemoryLocks.has(lock)) {
      const current = inMemoryRecords.get(key);
      return current ? { ok: true, record: current, wasClaimed: true } : { ok: false, reason: 'not_found' };
    }

    inMemoryLocks.set(lock, args.claimantPhone);
    const updated: TicketClaimRecord = {
      ...fromMem,
      claimed: true,
      claimedAtIso: new Date().toISOString(),
      claimedByPhone: args.claimantPhone,
      claimedByName: args.claimantName,
    };
    inMemoryRecords.set(key, updated);
    return { ok: true, record: updated, wasClaimed: false };
  }

  try {
    await redis.connect();
    const lockSet = await redis.set(lock, args.claimantPhone, 'EX', 60 * 60 * 24, 'NX');
    if (lockSet !== 'OK') {
      const current = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
      if (!current) return { ok: false, reason: 'not_found' };
      return { ok: true, record: current, wasClaimed: true };
    }

    const current = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
    if (!current) return { ok: false, reason: 'not_found' };

    const updated: TicketClaimRecord = {
      ...current,
      claimed: true,
      claimedAtIso: new Date().toISOString(),
      claimedByPhone: args.claimantPhone,
      claimedByName: args.claimantName,
    };

    await redis.set(key, JSON.stringify(updated));
    inMemoryRecords.set(key, updated);
    return { ok: true, record: updated, wasClaimed: false };
  } catch {
    return { ok: false, reason: 'storage_error' };
  }
}
