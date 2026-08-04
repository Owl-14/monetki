import { today } from './ui.js';

const SCOPED_ENTITIES = [
  'clients',
  'companies',
  'contacts',
  'leads',
  'deals',
  'pipelines',
  'stages',
  'dealItems',
  'venues',
  'players',
  'tasks',
  'finance',
  'staffExpenses',
  'memberships',
  'businessOwners',
];

const CYRILLIC_SLUG = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h',
  ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function businessIdFromName(name, existingIds = []) {
  const transliterated = [...String(name || '').trim().toLowerCase()]
    .map((letter) => CYRILLIC_SLUG[letter] ?? letter)
    .join('');
  const base = transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55)
    .replace(/-+$/g, '') || 'business';
  const used = new Set(existingIds.map(String));
  const reserved = new Set(['all', 'personal', 'total']);
  let id = base;
  let suffix = 2;
  while (reserved.has(id) || used.has(id)) {
    id = `${base.slice(0, 55 - String(suffix).length)}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function createAppState(store, storage = localStorage) {
  return {
    store,
    token: storage.getItem('monetki_token') || '',
    profile: null,
    data: null,
    unit: storage.getItem('monetki_unit') || 'padel',
    loading: false,
    taskFilter: { who: 'mine', status: 'active' },
    crmPipelineId: '',
    finMonth: today().slice(0, 7),
    search: {},
  };
}

export function normalizeItemScope(entity, item) {
  if (!SCOPED_ENTITIES.includes(entity)) return item;
  const businessId = item.businessId || item.unit;
  return businessId ? { ...item, businessId, unit: businessId } : item;
}

export function applyLocal(state, entity, operation, itemOrId) {
  if (!state.data) return;
  const items = state.data[entity] || (state.data[entity] = []);
  if (operation === 'create') items.push(itemOrId);
  if (operation === 'update') {
    const index = items.findIndex((item) => item.id === itemOrId.id);
    if (index >= 0) items[index] = itemOrId;
    else items.push(itemOrId);
  }
  if (operation === 'delete') state.data[entity] = items.filter((item) => item.id !== itemOrId);
}

export function createCrudHelpers(state, { toast, render, refresh }) {
  async function doCreate(entity, item, okText) {
    const normalized = normalizeItemScope(entity, item);
    const result = await state.store.create(state.token, entity, normalized);
    if (!result.ok) {
      toast(result.error || 'Ошибка', true);
      return null;
    }
    applyLocal(state, entity, 'create', result.item || normalized);
    if (okText) toast(okText);
    render();
    return result;
  }

  async function doUpdate(entity, item, okText) {
    const normalized = normalizeItemScope(entity, item);
    applyLocal(state, entity, 'update', normalized);
    render();
    if (okText) toast(okText);
    const result = await state.store.update(state.token, entity, normalized);
    if (!result.ok) {
      toast(result.error || 'Ошибка', true);
      refresh(true);
      return null;
    }
    return result;
  }

  async function doDelete(entity, id, okText) {
    applyLocal(state, entity, 'delete', id);
    render();
    if (okText) toast(okText);
    const result = await state.store.remove(state.token, entity, id);
    if (!result.ok) {
      toast(result.error || 'Ошибка', true);
      refresh(true);
      return null;
    }
    return result;
  }

  return { doCreate, doUpdate, doDelete };
}
