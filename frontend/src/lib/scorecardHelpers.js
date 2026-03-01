export function normalizeDimensions(dimensions) {
  return dimensions.map(d => ({
    ...d,
    score: (d.score === null || d.score === undefined) ? null : Number(d.score),
    confidence: Number(d.confidence) || 0,
    rationale: d.rationale || '',
    evidence: Array.isArray(d.evidence) ? d.evidence : [],
  }));
}

export function buildDefaultScorecard(dimIds) {
  return dimIds.map(id => ({
    id,
    score: null,
    confidence: 0,
    rationale: '',
    evidence: [],
  }));
}
