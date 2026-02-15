import ldap from 'ldapjs';

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
    const baseOu = process.env.BASE_OU ?? '';
    const userDN = upn.includes(',') ? upn : baseOu ? `CN=${upn},${baseOu}` : `CN=${upn}`;

    const changes: ldap.Change[] = [
      new ldap.Change({
        operation: 'replace',
        modification: { unicodePwd: Buffer.from(`\"${newPassword}\"`, 'utf16le') },
      }),
    ];

    if (changePasswordAtNextLogon) {
      changes.push(
        new ldap.Change({
          operation: 'replace',
          modification: { pwdLastSet: '0' },
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

