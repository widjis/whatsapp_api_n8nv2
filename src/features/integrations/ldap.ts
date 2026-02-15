import ldap from 'ldapjs';
import sql from 'mssql';

export async function getLdapClient(): Promise<ldap.Client> {
  const url = process.env.LDAP_URL ?? '';
  const bindDN = process.env.BIND_DN ?? '';
  const bindPW = process.env.BIND_PW ?? '';
  if (!url || !bindDN || !bindPW) {
    throw new Error('LDAP_URL, BIND_DN, and BIND_PW must be set in environment');
  }

  const client = ldap.createClient({
    url: url.replace('ldap://', 'ldaps://').replace(':389', ':636'),
    tlsOptions: { rejectUnauthorized: false, secureProtocol: 'TLSv1_2_method' },
  });

  await new Promise<void>((resolve, reject) => {
    client.bind(bindDN, bindPW, (err) => {
      if (err) {
        client.unbind();
        reject(err);
        return;
      }
      resolve();
    });
  });

  return client;
}

export type AdUserInfo = {
  name: string;
  email: string | null;
  title: string | null;
  department: string | null;
  mobile: string | null;
  telephoneNumber: string | null;
  employeeId: string | null;
  source: 'ldap' | 'push_name' | 'unknown';
};

type FoundUser = {
  displayName: string;
  userPrincipalName?: string;
  mail?: string;
  title?: string;
  department?: string;
  mobile?: string;
  telephoneNumber?: string;
  employeeID?: string;
  pwdLastSet?: string;
  passwordExpiryTimeComputed?: string;
  photoBuffer?: Buffer;
  photoContentType?: string;
};

export type FindUsersResult =
  | {
      success: true;
      users: FoundUser[];
    }
  | {
      success: false;
      error: string;
    };

export async function findUserMobileByEmail(args: { email: string }): Promise<string | null> {
  const email = args.email.trim().toLowerCase();
  if (!email) return null;

  const baseDn = process.env.BASE_DN ?? process.env.LDAP_BASE_DN ?? process.env.BASE_OU ?? '';
  if (!baseDn) return null;

  const client = await getLdapClient();
  const escaped = escapeLdapFilterValue(email);
  const filter = `(&(mail=${escaped}))`;

  try {
    const mobile = await new Promise<string | null>((resolve, reject) => {
      client.search(
        baseDn,
        {
          scope: 'sub',
          filter,
          attributes: ['mobile', 'mobileNumber', 'telephoneNumber'],
        },
        (err, res) => {
          if (err) {
            reject(err);
            return;
          }

          let value: string | null = null;
          res.on('searchEntry', (entry) => {
            if (value) return;
            const map = buildAttributeMap(entry);
            value =
              pickFirstAttr(map, 'mobile') ??
              pickFirstAttr(map, 'mobileNumber') ??
              pickFirstAttr(map, 'telephoneNumber') ??
              null;
          });

          res.on('error', (e) => {
            reject(e);
          });

          res.on('end', () => {
            resolve(value);
          });
        }
      );
    });

    client.unbind();
    return mobile;
  } catch {
    client.unbind();
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhoneDigits(input: string): string {
  return input.replace(/\D/g, '');
}

function buildPhoneSearchFilter(phoneDigits: string): string {
  const escaped = escapeLdapFilterValue(phoneDigits);
  const raw = process.env.LDAP_SEARCH_FILTER;
  if (raw && raw.includes('{phone}')) {
    return raw.replace(/\{phone\}/g, escaped);
  }

  return `(&(|(telephoneNumber=*${escaped}*)(mobile=*${escaped}*)(mobileNumber=*${escaped}*))(objectCategory=person)(objectClass=user))`;
}

export async function findAdUserByPhone(args: {
  phone: string;
  pushName: string | null;
}): Promise<AdUserInfo | null> {
  const ldapEnabled = process.env.LDAP_ENABLED ? process.env.LDAP_ENABLED === 'true' : true;
  if (!ldapEnabled) {
    return args.pushName
      ? {
          name: args.pushName,
          email: null,
          title: null,
          department: null,
          mobile: null,
          telephoneNumber: null,
          employeeId: null,
          source: 'push_name',
        }
      : null;
  }

  const baseDn = process.env.LDAP_BASE_DN ?? process.env.BASE_DN ?? process.env.BASE_OU ?? '';
  if (!baseDn) {
    return args.pushName
      ? {
          name: args.pushName,
          email: null,
          title: null,
          department: null,
          mobile: null,
          telephoneNumber: null,
          employeeId: null,
          source: 'push_name',
        }
      : null;
  }

  const phoneDigits = normalizePhoneDigits(args.phone);
  if (!phoneDigits) {
    return args.pushName
      ? {
          name: args.pushName,
          email: null,
          title: null,
          department: null,
          mobile: null,
          telephoneNumber: null,
          employeeId: null,
          source: 'push_name',
        }
      : null;
  }

  const timeoutMs = Number(process.env.LDAP_TIMEOUT ?? '10000');
  const maxRetries = Number(process.env.LDAP_MAX_RETRIES ?? '3');
  const retryDelayMs = Number(process.env.LDAP_RETRY_DELAY ?? '1000');
  const filter = buildPhoneSearchFilter(phoneDigits);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt += 1) {
    const client = await getLdapClient();
    try {
      const result = await new Promise<AdUserInfo | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('LDAP search timeout'));
        }, timeoutMs);

        client.search(
          baseDn,
          {
            scope: 'sub',
            filter,
            attributes: ['displayName', 'cn', 'mail', 'title', 'department', 'mobile', 'mobileNumber', 'telephoneNumber', 'employeeID'],
            sizeLimit: 2,
          },
          (err, res) => {
            if (err) {
              clearTimeout(timer);
              reject(err);
              return;
            }

            const users: AdUserInfo[] = [];
            res.on('searchEntry', (entry) => {
              const map = buildAttributeMap(entry);
              const name =
                pickFirstAttr(map, 'displayName') ??
                pickFirstAttr(map, 'cn') ??
                pickFirstAttr(map, 'name') ??
                pickFirstAttr(map, 'sAMAccountName') ??
                'Unknown';

              users.push({
                name,
                email: pickFirstAttr(map, 'mail') ?? pickFirstAttr(map, 'userPrincipalName') ?? null,
                title: pickFirstAttr(map, 'title') ?? null,
                department: pickFirstAttr(map, 'department') ?? null,
                mobile: pickFirstAttr(map, 'mobile') ?? pickFirstAttr(map, 'mobileNumber') ?? null,
                telephoneNumber: pickFirstAttr(map, 'telephoneNumber') ?? null,
                employeeId: pickFirstAttr(map, 'employeeID') ?? null,
                source: 'ldap',
              });
            });

            res.on('error', (e) => {
              clearTimeout(timer);
              reject(e);
            });

            res.on('end', () => {
              clearTimeout(timer);
              if (users.length === 1) {
                resolve(users[0]);
                return;
              }
              resolve(null);
            });
          }
        );
      });

      client.unbind();
      if (result) return result;

      if (args.pushName) {
        return {
          name: args.pushName,
          email: null,
          title: null,
          department: null,
          mobile: null,
          telephoneNumber: null,
          employeeId: null,
          source: 'push_name',
        };
      }
      return null;
    } catch (error) {
      client.unbind();
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < Math.max(1, maxRetries)) {
        await sleep(retryDelayMs);
      }
      continue;
    }
  }

  if (args.pushName) {
    return {
      name: args.pushName,
      email: null,
      title: null,
      department: null,
      mobile: null,
      telephoneNumber: null,
      employeeId: null,
      source: 'push_name',
    };
  }

  if (lastError) {
    return {
      name: 'Unknown',
      email: null,
      title: null,
      department: null,
      mobile: null,
      telephoneNumber: null,
      employeeId: null,
      source: 'unknown',
    };
  }

  return null;
}

export type BitLockerRecoveryKey = {
  partitionId: string;
  password: string;
};

export type GetBitLockerInfoResult =
  | {
      success: true;
      data: {
        hostname: string;
        keys: BitLockerRecoveryKey[];
      };
    }
  | {
      success: false;
      error: string;
    };

export async function getBitLockerInfo(args: { hostname: string }): Promise<GetBitLockerInfoResult> {
  const hostname = args.hostname.trim();
  if (!hostname) return { success: false, error: 'Hostname is required.' };

  const baseDn = process.env.LDAP_BASE_DN ?? process.env.BASE_DN ?? process.env.BASE_OU ?? '';
  if (!baseDn) {
    return {
      success: false,
      error: 'LDAP_BASE_DN (or BASE_DN / BASE_OU) must be set in environment.',
    };
  }

  const client = await getLdapClient();
  try {
    const h = hostname.toUpperCase();
    const escaped = escapeLdapFilterValue(h);
    const compFilter = `(&(objectCategory=computer)(|(cn=${escaped})(sAMAccountName=${escaped}$)))`;

    let computerDns = await searchDns({ client, baseDn, filter: compFilter, scope: 'sub', sizeLimit: 2 });
    if (computerDns.length === 0) {
      const wcFilter = `(&(objectCategory=computer)(cn=${escaped}*))`;
      computerDns = await searchDns({ client, baseDn, filter: wcFilter, scope: 'sub', sizeLimit: 2 });
    }

    if (computerDns.length === 0) {
      client.unbind();
      return { success: false, error: `Computer "${hostname}" not found in AD` };
    }
    if (computerDns.length > 1) {
      client.unbind();
      return { success: false, error: `Multiple computer objects matched "${hostname}". Provide exact hostname.` };
    }

    const computerDn = computerDns[0];

    const keys = await searchBitLockerKeys({ client, computerDn });
    client.unbind();

    if (keys.length === 0) {
      return { success: false, error: 'No BitLocker recovery objects found' };
    }

    return { success: true, data: { hostname, keys } };
  } catch (error) {
    client.unbind();
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

async function searchDns(args: {
  client: ldap.Client;
  baseDn: string;
  filter: string;
  scope: 'sub' | 'one' | 'base';
  sizeLimit: number;
}): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    args.client.search(
      args.baseDn,
      {
        scope: args.scope,
        filter: args.filter,
        attributes: ['distinguishedName'],
        sizeLimit: args.sizeLimit,
      },
      (err, res) => {
        if (err) {
          reject(err);
          return;
        }

        const results: string[] = [];
        res.on('searchEntry', (entry) => {
          const dn = entry.pojo.objectName;
          if (typeof dn === 'string' && dn.trim()) results.push(dn);
        });

        res.on('error', (e) => {
          reject(e);
        });

        res.on('end', () => {
          resolve(results);
        });
      }
    );
  });
}

async function searchBitLockerKeys(args: { client: ldap.Client; computerDn: string }): Promise<BitLockerRecoveryKey[]> {
  return await new Promise<BitLockerRecoveryKey[]>((resolve, reject) => {
    args.client.search(
      args.computerDn,
      {
        scope: 'one',
        filter: '(msFVE-RecoveryPassword=*)',
        attributes: ['msFVE-RecoveryPassword'],
      },
      (err, res) => {
        if (err) {
          reject(err);
          return;
        }

        const results: BitLockerRecoveryKey[] = [];
        res.on('searchEntry', (entry) => {
          const dn = entry.pojo.objectName;
          const map = buildAttributeMap(entry);
          const password = pickFirstAttr(map, 'msFVE-RecoveryPassword') ?? '';
          if (typeof dn !== 'string' || !dn.trim() || !password) return;

          const partitionId = dn.split(',')[0]?.replace(/^CN=/i, '') ?? '';
          if (!partitionId.trim()) return;

          results.push({ partitionId, password });
        });

        res.on('error', (e) => {
          reject(e);
        });

        res.on('end', () => {
          resolve(results);
        });
      }
    );
  });
}

function escapeLdapFilterValue(value: string): string {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\u0000/g, '\\00');
}

type ResolveUserDnResult = { ok: true; dn: string } | { ok: false; error: string };

async function searchUserDns(args: {
  client: ldap.Client;
  baseDn: string;
  filter: string;
  sizeLimit: number;
}): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    args.client.search(
      args.baseDn,
      {
        scope: 'sub',
        filter: args.filter,
        attributes: ['distinguishedName'],
        sizeLimit: args.sizeLimit,
      },
      (err, res) => {
        if (err) {
          reject(err);
          return;
        }

        const results: string[] = [];
        res.on('searchEntry', (entry) => {
          const dn = entry.pojo.objectName;
          if (typeof dn === 'string' && dn.trim()) results.push(dn);
        });

        res.on('error', (e) => {
          reject(e);
        });

        res.on('end', () => {
          resolve(results);
        });
      }
    );
  });
}

async function resolveUserDn(args: { client: ldap.Client; identifier: string }): Promise<ResolveUserDnResult> {
  const identifier = args.identifier.trim();
  if (!identifier) return { ok: false, error: 'User identifier is required.' };
  if (identifier.includes(',')) return { ok: true, dn: identifier };

  const baseDn = process.env.BASE_DN ?? process.env.LDAP_BASE_DN ?? process.env.BASE_OU ?? '';
  if (!baseDn) {
    return { ok: false, error: 'BASE_DN (or LDAP_BASE_DN / BASE_OU) must be set in environment.' };
  }

  const escaped = escapeLdapFilterValue(identifier);
  const exactFilter = `(&(|(sAMAccountName=${escaped})(userPrincipalName=${escaped})(mail=${escaped})(cn=${escaped}))(objectCategory=person)(objectClass=user))`;
  const exactDns = await searchUserDns({ client: args.client, baseDn, filter: exactFilter, sizeLimit: 2 });
  if (exactDns.length === 1) return { ok: true, dn: exactDns[0] };
  if (exactDns.length > 1) {
    return {
      ok: false,
      error: 'Multiple users matched. Provide full DN to disambiguate.',
    };
  }

  const shouldTryMailAlias = !identifier.includes('@') && identifier.includes('.');
  if (shouldTryMailAlias) {
    const aliasFilter = `(&(|(userPrincipalName=${escaped}@*)(mail=${escaped}@*)(proxyAddresses=smtp:${escaped}@*)(proxyAddresses=SMTP:${escaped}@*)(mailNickname=${escaped}))(objectCategory=person)(objectClass=user))`;
    const aliasDns = await searchUserDns({ client: args.client, baseDn, filter: aliasFilter, sizeLimit: 2 });
    if (aliasDns.length === 1) return { ok: true, dn: aliasDns[0] };
    if (aliasDns.length > 1) {
      return {
        ok: false,
        error: 'Multiple users matched. Provide full DN to disambiguate.',
      };
    }

    const tokenPattern = identifier
      .split('.')
      .filter(Boolean)
      .map(escapeLdapFilterValue)
      .join('*');
    const tokensFilter = `(&(|(cn=*${tokenPattern}*)(displayName=*${tokenPattern}*))(objectCategory=person)(objectClass=user))`;
    const tokenDns = await searchUserDns({ client: args.client, baseDn, filter: tokensFilter, sizeLimit: 2 });
    if (tokenDns.length === 1) return { ok: true, dn: tokenDns[0] };
    if (tokenDns.length > 1) {
      return {
        ok: false,
        error: 'Multiple users matched. Provide full DN to disambiguate.',
      };
    }
  }

  const likeFilter = `(&(|(sAMAccountName=*${escaped}*)(userPrincipalName=*${escaped}*)(mail=*${escaped}*)(cn=*${escaped}*)(displayName=*${escaped}*))(objectCategory=person)(objectClass=user))`;
  const likeDns = await searchUserDns({ client: args.client, baseDn, filter: likeFilter, sizeLimit: 5 });
  if (likeDns.length === 1) return { ok: true, dn: likeDns[0] };
  if (likeDns.length > 1) {
    return {
      ok: false,
      error: 'Multiple users matched. Provide full DN to disambiguate.',
    };
  }

  return { ok: false, error: 'User not found.' };
}

function getFirstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === 'string') return first;
  }
  return undefined;
}

type DbPhotoRow = {
  PHOTO: Buffer | null;
};

let dbPool: sql.ConnectionPool | undefined;
let dbPoolConnectPromise: Promise<sql.ConnectionPool> | undefined;

function getDbConfig(): sql.config {
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const server = process.env.DB_SERVER;
  const database = process.env.DB_DATABASE;
  const portRaw = process.env.DB_PORT;
  const port = portRaw ? Number(portRaw) : undefined;

  if (!user || !password || !server || !database) {
    throw new Error('DB_USER, DB_PASSWORD, DB_SERVER, and DB_DATABASE must be set in environment');
  }

  return {
    user,
    password,
    server,
    database,
    port: port && Number.isFinite(port) ? port : undefined,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
  };
}

async function initializeDbPool(): Promise<sql.ConnectionPool> {
  if (dbPool && dbPool.connected) return dbPool;
  if (dbPoolConnectPromise) return dbPoolConnectPromise;

  dbPoolConnectPromise = (async () => {
    if (dbPool && !dbPool.connected) {
      try {
        await dbPool.close();
      } catch {
        // ignore
      }
      dbPool = undefined;
    }

    const pool = new sql.ConnectionPool(getDbConfig());
    await pool.connect();
    dbPool = pool;
    return pool;
  })();

  try {
    return await dbPoolConnectPromise;
  } finally {
    dbPoolConnectPromise = undefined;
  }
}

async function getUserPhotoFromDb(staffNo: string): Promise<Buffer | null> {
  try {
    const activePool = await initializeDbPool();
    const request = activePool.request();
    request.input('staffNo', sql.NVarChar, staffNo);

    const result = await request.query<DbPhotoRow>(
      `SELECT PHOTO FROM CardDB WHERE StaffNo = @staffNo AND Del_State = 'False'`
    );

    const row = result.recordset[0];
    return row?.PHOTO ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Connection is closed')) {
      throw error;
    }

    dbPoolConnectPromise = undefined;
    if (dbPool) {
      try {
        await dbPool.close();
      } catch {
        // ignore
      }
    }
    dbPool = undefined;

    const activePool = await initializeDbPool();
    const request = activePool.request();
    request.input('staffNo', sql.NVarChar, staffNo);
    const result = await request.query<DbPhotoRow>(
      `SELECT PHOTO FROM CardDB WHERE StaffNo = @staffNo AND Del_State = 'False'`
    );
    const row = result.recordset[0];
    return row?.PHOTO ?? null;
  }
}

function toBigIntFileTime(value: unknown): bigint | undefined {
  const asString = typeof value === 'string' ? value : undefined;
  const asNumber = typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  if (asString) {
    const trimmed = asString.trim();
    if (!trimmed) return undefined;
    try {
      return BigInt(trimmed);
    } catch {
      return undefined;
    }
  }

  if (asNumber !== undefined) {
    try {
      return BigInt(Math.trunc(asNumber));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function formatFileTimeToLocaleString(fileTime: unknown): string | undefined {
  const EPOCH_DIFFERENCE_MS = 11644473600000n;
  const ft = toBigIntFileTime(fileTime);
  if (!ft) return undefined;

  const msBig = ft / 10000n - EPOCH_DIFFERENCE_MS;
  const msNumber = Number(msBig);
  if (!Number.isFinite(msNumber)) return undefined;
  const date = new Date(msNumber);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString();
}

function isExceptionallyLongDateString(dateString: string): boolean {
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getFullYear() > 2100;
}

function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return true;

  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (isPng) return true;

  const isGif = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
  return isGif;
}

function normalizeAttributeType(type: string): string {
  return type.toLowerCase().split(';')[0] ?? type.toLowerCase();
}

function decodeMaybeBase64Image(value: string): Buffer | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 32) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return undefined;

  try {
    const decoded = Buffer.from(trimmed, 'base64');
    if (!looksLikeImage(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function extractPhotoFromEntry(entry: ldap.SearchEntry): { buffer: Buffer; contentType?: string } | undefined {
  const thumb = entry.attributes.find((a) => normalizeAttributeType(a.type) === 'thumbnailphoto');
  if (thumb) {
    const buf = thumb.buffers[0];
    if (buf && looksLikeImage(buf)) return { buffer: buf };
    const values = Array.isArray(thumb.values) ? thumb.values : [thumb.values];
    const first = values[0];
    if (typeof first === 'string') {
      const decoded = decodeMaybeBase64Image(first);
      if (decoded) return { buffer: decoded };
    }
  }

  const jpeg = entry.attributes.find((a) => normalizeAttributeType(a.type) === 'jpegphoto');
  if (jpeg) {
    const buf = jpeg.buffers[0];
    if (buf && looksLikeImage(buf)) return { buffer: buf };
    const values = Array.isArray(jpeg.values) ? jpeg.values : [jpeg.values];
    const first = values[0];
    if (typeof first === 'string') {
      const decoded = decodeMaybeBase64Image(first);
      if (decoded) return { buffer: decoded };
    }
  }

  return undefined;
}

function buildAttributeMap(entry: ldap.SearchEntry): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const attr of entry.pojo.attributes) {
    map.set(attr.type.toLowerCase(), attr.values);
  }
  return map;
}

function pickFirstAttr(map: Map<string, string[]>, name: string): string | undefined {
  const values = map.get(name.toLowerCase());
  const first = values?.[0];
  return first ? String(first) : undefined;
}

export async function findUsersByCommonName(args: { query: string; includePhoto: boolean }): Promise<FindUsersResult> {
  const { query, includePhoto } = args;
  try {
    const baseDn = process.env.BASE_DN ?? process.env.LDAP_BASE_DN ?? process.env.BASE_OU ?? '';
    if (!baseDn) {
      return {
        success: false,
        error: 'BASE_DN (or LDAP_BASE_DN / BASE_OU) must be set in environment',
      };
    }

    const client = await getLdapClient();
    const escaped = escapeLdapFilterValue(query.toLowerCase());
    const filter = `(&(cn=*${escaped}*))`;

    const attributesBase = [
      'displayName',
      'userPrincipalName',
      'title',
      'department',
      'mobile',
      'employeeID',
      'pwdLastSet',
      'msDS-UserPasswordExpiryTimeComputed',
      'cn',
    ];

    const attributes = includePhoto ? [...attributesBase, 'thumbnailPhoto', 'jpegPhoto'] : attributesBase;

    const users: FoundUser[] = [];
    const photoFetches: Array<Promise<void>> = [];
    await new Promise<void>((resolve, reject) => {
      client.search(
        baseDn,
        {
          scope: 'sub',
          filter,
          attributes,
        },
        (err, res) => {
          if (err) {
            reject(err);
            return;
          }

          res.on('searchEntry', (entry) => {
            const map = buildAttributeMap(entry);

            const displayName =
              pickFirstAttr(map, 'displayName') ??
              pickFirstAttr(map, 'cn') ??
              pickFirstAttr(map, 'name') ??
              pickFirstAttr(map, 'sAMAccountName') ??
              pickFirstAttr(map, 'userPrincipalName') ??
              'Unknown';

            const user: FoundUser = {
              displayName,
              userPrincipalName: pickFirstAttr(map, 'userPrincipalName'),
              mail: pickFirstAttr(map, 'mail'),
              title: pickFirstAttr(map, 'title'),
              department: pickFirstAttr(map, 'department'),
              mobile: pickFirstAttr(map, 'mobile') ?? pickFirstAttr(map, 'mobileNumber'),
              telephoneNumber: pickFirstAttr(map, 'telephoneNumber'),
              employeeID: pickFirstAttr(map, 'employeeID'),
              pwdLastSet: pickFirstAttr(map, 'pwdLastSet'),
              passwordExpiryTimeComputed: pickFirstAttr(map, 'msDS-UserPasswordExpiryTimeComputed'),
            };

            if (includePhoto) {
              const photo = extractPhotoFromEntry(entry);
              if (photo) {
                user.photoBuffer = photo.buffer;
                user.photoContentType = photo.contentType;
              } else if (user.employeeID) {
                const employeeId = user.employeeID;
                photoFetches.push(
                  (async () => {
                    try {
                      const dbPhoto = await getUserPhotoFromDb(employeeId);
                      if (dbPhoto && looksLikeImage(dbPhoto)) {
                        user.photoBuffer = dbPhoto;
                      }
                    } catch {
                      return;
                    }
                  })()
                );
              }
            }

            users.push(user);
          });

          res.on('error', (e) => {
            reject(e);
          });

          res.on('end', () => {
            resolve();
          });
        }
      );
    });

    if (photoFetches.length > 0) {
      await Promise.all(photoFetches);
    }

    client.unbind();

    return { success: true, users };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export function renderFindUserCaption(args: { user: FoundUser; includePhoto: boolean }): {
  caption: string;
  photoStatus: string;
  hasPhoto: boolean;
  photoBuffer?: Buffer;
} {
  const { user, includePhoto } = args;

  const lastSet = formatFileTimeToLocaleString(user.pwdLastSet) ?? 'Unknown';
  const expires = formatFileTimeToLocaleString(user.passwordExpiryTimeComputed);
  const expiryMsg =
    user.passwordExpiryTimeComputed && expires && !isExceptionallyLongDateString(expires)
      ? `Password Expired on: ${expires}`
      : 'Password never expires';

  const hasPhoto = includePhoto && Boolean(user.photoBuffer);
  const photoStatus = includePhoto ? (hasPhoto ? ' 📷' : ' (No photo available)') : '';

  const caption =
    `*${user.displayName}* [MTI]${photoStatus}\n` +
    `📧 ${user.userPrincipalName ?? user.mail ?? 'Not available'}\n` +
    `🏷️ ${user.title ?? 'Not available'}\n` +
    `🏢 ${user.department ?? 'Not available'}\n` +
    `📱 ${user.mobile ?? user.telephoneNumber ?? 'Not available'}\n` +
    (user.employeeID ? `🆔 ${user.employeeID}\n` : '') +
    `🔒 Last Pass Change: ${lastSet}\n` +
    `⏳ ${expiryMsg}`;

  return { caption, photoStatus, hasPhoto, photoBuffer: user.photoBuffer };
}

export type ResetPasswordResult =
  | { success: true }
  | {
      success: false;
      error: string;
    };

export async function resetPassword(args: {
  upn: string;
  newPassword: string;
  changePasswordAtNextLogon: boolean;
}): Promise<ResetPasswordResult> {
  const { upn, newPassword, changePasswordAtNextLogon } = args;
  try {
    const client = await getLdapClient();
    const resolved = await resolveUserDn({ client, identifier: upn });
    if (!resolved.ok) {
      client.unbind();
      return {
        success: false,
        error: `${resolved.error} Provide full DN or set BASE_DN/LDAP_BASE_DN/BASE_OU correctly.`,
      };
    }

    const userDN = resolved.dn;

    const changes: ldap.Change[] = [
      new ldap.Change({
        operation: 'replace',
        modification: {
          type: 'unicodePwd',
          values: [Buffer.from(`"${newPassword}"`, 'utf16le')],
        },
      }),
    ];

    if (changePasswordAtNextLogon) {
      changes.push(
        new ldap.Change({
          operation: 'replace',
          modification: {
            type: 'pwdLastSet',
            values: ['0'],
          },
        })
      );
    }

    for (const change of changes) {
      await new Promise<void>((resolve, reject) => {
        client.modify(userDN, change, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }

    client.unbind();
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
