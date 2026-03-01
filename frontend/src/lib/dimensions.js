import { apiGet } from '../api.js';

export let DIMENSIONS = {};
export let allDimIds = [];
export let SCALE_LABELS = {};

export async function loadDimensions() {
  const config = await apiGet('/config/dimensions');
  const dims = {};
  for (const cat of config.categories) {
    dims[cat.id] = {
      label: cat.label,
      dims: cat.dimensions.map(d => ({ id: d.id, statement: d.statement })),
    };
  }
  DIMENSIONS = dims;
  allDimIds = Object.values(DIMENSIONS).flatMap(cat => cat.dims.map(d => d.id));
  SCALE_LABELS = config.scale?.labels || {};

  const legendEl = document.getElementById('scale-legend');
  if (legendEl) {
    const parts = Object.entries(SCALE_LABELS)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([k, v]) => `<strong>${k}</strong> = ${v}`);
    parts.push('<strong>N/A</strong> = Not sure');
    legendEl.innerHTML = parts.join(' &nbsp; ');
  }
}
