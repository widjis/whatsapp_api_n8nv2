import axios from 'axios';

export const CATEGORY_MAPPING: Record<string, string> = {
  mouse: 'Mouse',
  switch: 'Switch',
  tablet: 'Tablet',
  pc: 'PC Desktop',
  ht: 'HT',
  phone: 'Mobile Phone [Non Assets]',
  monitor: 'Monitor',
  sim: 'SIM CARD',
  notebook: 'Notebook',
  license: 'Misc Software',
  software: 'Software License',
  antivirus: 'Antivirus License',
  office: 'Office License',
  windows: 'Windows License',
  adobe: 'Adobe License',
  cad: 'CAD License',
  database: 'Database License',
  security: 'Security Software License',
};

type SnipeItConfig = {
  url: string;
  token: string;
};

type SnipeCategory = {
  id: number;
  name: string;
};

type AssetSummary = {
  totalAssets: number;
  totalDeployed: number;
  totalReadyToDeploy: number;
  totalArchived: number;
  totalPending: number;
  deployedI5?: number;
  deployedI7?: number;
  deployedUltra5?: number;
  deployedUltra7?: number;
  readyToDeployI5?: number;
  readyToDeployI7?: number;
  readyToDeployUltra5?: number;
  readyToDeployUltra7?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function getSnipeItConfig(): { ok: true; config: SnipeItConfig } | { ok: false; error: string } {
  const urlRaw = process.env.SNIPEIT_URL;
  const tokenRaw = process.env.SNIPEIT_TOKEN;
  const url = typeof urlRaw === 'string' ? urlRaw.trim() : '';
  const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : '';

  if (!url || !token) {
    return {
      ok: false,
      error:
        '*Snipe-IT is not configured.*\n\nPlease set these environment variables:\n- SNIPEIT_URL\n- SNIPEIT_TOKEN',
    };
  }

  return { ok: true, config: { url: normalizeBaseUrl(url), token } };
}

function pickRowsArray(data: unknown): unknown[] | null {
  if (!isRecord(data)) return null;
  const rows = data.rows;
  return Array.isArray(rows) ? rows : null;
}

function parseCategories(data: unknown): SnipeCategory[] {
  const rows = pickRowsArray(data);
  if (!rows) return [];

  const categories: SnipeCategory[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = row.id;
    const name = row.name;
    if (typeof id !== 'number' || !Number.isFinite(id)) continue;
    if (typeof name !== 'string' || !name.trim()) continue;
    categories.push({ id, name: name.trim() });
  }
  return categories;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function getAssetStatusName(asset: Record<string, unknown>): string | null {
  const statusLabel = asset.status_label;
  if (!isRecord(statusLabel)) return null;
  const name = statusLabel.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function getAssetCoreType(asset: Record<string, unknown>): string | null {
  const customFields = asset.custom_fields;
  if (!isRecord(customFields)) return null;

  const coreTypeField = customFields['Core Type'];
  if (!isRecord(coreTypeField)) return null;
  const value = coreTypeField.value;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function countStatus(assets: Record<string, unknown>[], statusName: string): number {
  const want = normalizeText(statusName);
  let count = 0;
  for (const asset of assets) {
    const status = getAssetStatusName(asset);
    if (!status) continue;
    if (normalizeText(status) === want) count += 1;
  }
  return count;
}

function countStatusAndCore(assets: Record<string, unknown>[], statusName: string, coreType: string): number {
  const wantStatus = normalizeText(statusName);
  const wantCore = normalizeText(coreType);

  let count = 0;
  for (const asset of assets) {
    const status = getAssetStatusName(asset);
    if (!status) continue;
    if (normalizeText(status) !== wantStatus) continue;

    const core = getAssetCoreType(asset);
    if (!core) continue;
    if (normalizeText(core) === wantCore) count += 1;
  }
  return count;
}

function summarizeAssets(args: { assets: Record<string, unknown>[]; categoryName: string }): AssetSummary {
  const { assets, categoryName } = args;
  const totalAssets = assets.length;
  const totalDeployed = countStatus(assets, 'deployed');
  const totalReadyToDeploy = countStatus(assets, 'ready to deploy');
  const totalArchived = countStatus(assets, 'archived');
  const totalPending = countStatus(assets, 'pending');

  if (normalizeText(categoryName) !== 'notebook') {
    return { totalAssets, totalDeployed, totalReadyToDeploy, totalArchived, totalPending };
  }

  return {
    totalAssets,
    totalDeployed,
    deployedI5: countStatusAndCore(assets, 'deployed', 'i5'),
    deployedI7: countStatusAndCore(assets, 'deployed', 'i7'),
    deployedUltra5: countStatusAndCore(assets, 'deployed', 'Ultra 5'),
    deployedUltra7: countStatusAndCore(assets, 'deployed', 'Ultra 7'),
    totalReadyToDeploy,
    readyToDeployI5: countStatusAndCore(assets, 'ready to deploy', 'i5'),
    readyToDeployI7: countStatusAndCore(assets, 'ready to deploy', 'i7'),
    readyToDeployUltra5: countStatusAndCore(assets, 'ready to deploy', 'Ultra 5'),
    readyToDeployUltra7: countStatusAndCore(assets, 'ready to deploy', 'Ultra 7'),
    totalArchived,
    totalPending,
  };
}

async function fetchCategories(config: SnipeItConfig): Promise<SnipeCategory[]> {
  const response = await axios.get<unknown>(`${config.url}/categories`, {
    headers: { Authorization: `Bearer ${config.token}` },
    params: { limit: 500, offset: 0 },
  });
  return parseCategories(response.data);
}

async function fetchAssetsByCategoryId(config: SnipeItConfig, categoryId: number): Promise<Record<string, unknown>[]> {
  const response = await axios.get<unknown>(`${config.url}/hardware`, {
    headers: { Authorization: `Bearer ${config.token}` },
    params: { category_id: categoryId, limit: 1000, offset: 0 },
  });
  const rows = pickRowsArray(response.data);
  if (!rows) return [];
  return rows.filter(isRecord);
}

async function getCategoryIdByName(config: SnipeItConfig, categoryName: string): Promise<number | null> {
  const categories = await fetchCategories(config);
  const want = normalizeText(categoryName);
  const hit = categories.find((c) => normalizeText(c.name) === want);
  return hit?.id ?? null;
}

function formatTwoColumnTable(rows: Array<{ label: string; value: string }>): string {
  const maxLabel = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  return rows.map((r) => `${r.label.padEnd(maxLabel)}  ${r.value}`).join('\n');
}

function renderAvailableTypesTable(): string {
  const entries = Object.entries(CATEGORY_MAPPING)
    .map(([k, v]) => ({ key: k, name: v }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const maxKey = entries.reduce((m, e) => Math.max(m, e.key.length), 0);
  const header = `${'Type'.padEnd(maxKey)}  Category`;
  const lines = entries.map((e) => `${e.key.padEnd(maxKey)}  ${e.name}`);
  return [header, ...lines].join('\n');
}

function renderCategorySummary(categoryName: string, summary: AssetSummary): string {
  const header = `*Snipe-IT Asset Summary*\n*Category:* ${categoryName}`;
  const statusTable = formatTwoColumnTable([
    { label: 'Total Assets', value: String(summary.totalAssets) },
    { label: 'Deployed', value: String(summary.totalDeployed) },
    { label: 'Ready to Deploy', value: String(summary.totalReadyToDeploy) },
    { label: 'Archived', value: String(summary.totalArchived) },
    { label: 'Pending', value: String(summary.totalPending) },
  ]);

  if (normalizeText(categoryName) !== 'notebook') {
    return `${header}\n\n\`\`\`\n${statusTable}\n\`\`\``;
  }

  const coreDeployed = `i5 ${summary.deployedI5 ?? 0} | i7 ${summary.deployedI7 ?? 0} | Ultra 5 ${summary.deployedUltra5 ?? 0} | Ultra 7 ${summary.deployedUltra7 ?? 0}`;
  const coreReady = `i5 ${summary.readyToDeployI5 ?? 0} | i7 ${summary.readyToDeployI7 ?? 0} | Ultra 5 ${summary.readyToDeployUltra5 ?? 0} | Ultra 7 ${summary.readyToDeployUltra7 ?? 0}`;
  const coreTable = formatTwoColumnTable([
    { label: 'Deployed', value: coreDeployed },
    { label: 'Ready to Deploy', value: coreReady },
  ]);

  return `${header}\n\n\`\`\`\n${statusTable}\n\nCore Type\n${coreTable}\n\`\`\``;
}

export async function buildGetAssetReply(messageContent: string): Promise<string> {
  const cfgRes = getSnipeItConfig();
  if (!cfgRes.ok) return cfgRes.error;
  const config = cfgRes.config;

  const parts = messageContent.split(/\s+/).filter(Boolean);
  const categoryKey = parts[1];

  if (!categoryKey) {
    const categories = await fetchCategories(config);
    if (categories.length === 0) return '*No categories found.*';

    const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name));
    const items: Array<{ category: string; total: number }> = [];
    for (const category of sorted) {
      const assets = await fetchAssetsByCategoryId(config, category.id);
      items.push({ category: category.name, total: assets.length });
    }

    const maxCat = items.reduce((m, i) => Math.max(m, i.category.length), 0);
    const header = `${'Category'.padEnd(maxCat)}  Total`;
    const lines = items.map((i) => `${i.category.padEnd(maxCat)}  ${String(i.total)}`);
    const table = [header, ...lines].join('\n');

    return `*Snipe-IT Asset Summary*\n\n\`\`\`\n${table}\n\`\`\`\n\nUse: /getasset <type>\n\`\`\`\n${renderAvailableTypesTable()}\n\`\`\``;
  }

  const mapped = CATEGORY_MAPPING[normalizeText(categoryKey)];
  if (!mapped) {
    return (
      `*Unknown asset type:* "${categoryKey}"\n\n`
      + `Use: /getasset <type>\n\`\`\`\n${renderAvailableTypesTable()}\n\`\`\``
    );
  }

  const categoryId = await getCategoryIdByName(config, mapped);
  if (!categoryId) return `Category "${mapped}" not found.`;

  const assets = await fetchAssetsByCategoryId(config, categoryId);
  const summary = summarizeAssets({ assets, categoryName: mapped });
  return renderCategorySummary(mapped, summary);
}
