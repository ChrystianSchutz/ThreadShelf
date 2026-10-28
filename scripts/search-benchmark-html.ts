import type { MeasuredQuery, MetricSummary } from './search-benchmark-metrics.js';

interface Detail extends MeasuredQuery {
  readonly id: string;
  readonly query: string;
  readonly expectedConversationKeys: readonly string[];
  readonly returnedConversationKeys: readonly string[];
}

interface ModeReport {
  readonly overall: MetricSummary;
  readonly categories: Record<string, MetricSummary>;
  readonly queries: readonly Detail[];
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    };
    return entities[character]!;
  });

export const renderHeatmap = (
  reports: Record<string, ModeReport>,
  conversationCount: number,
): string => {
  const modes = ['semantic', 'keyword', 'keyword-boost'];
  const categories = ['ALL', ...Object.keys(reports.semantic!.categories)];
  const maxLatency = Math.max(
    ...Object.values(reports).flatMap((report) => [
      report.overall.p95Ms,
      ...Object.values(report.categories).map((category) => category.p95Ms),
    ]),
  );
  const cell = (value: number, worse = false): string => {
    const fraction = worse ? Math.min(value / maxLatency, 1) : value;
    const color = worse ? '235,104,87' : '45,175,130';
    return `<td style="background:rgba(${color},${(0.08 + 0.42 * fraction).toFixed(3)})">${worse ? Math.round(value) : value.toFixed(3)}</td>`;
  };
  const summaryRows = categories
    .flatMap((category) =>
      modes.map((mode, index) => {
        const report = reports[mode]!;
        const score = category === 'ALL' ? report.overall : report.categories[category]!;
        const group =
          index === 0
            ? `<th scope="rowgroup" rowspan="3">${escapeHtml(category)} <small>(${score.queries})</small></th>`
            : '';
        return `<tr>${group}<th scope="row">${mode}</th>${cell(score.recall1)}${cell(score.recall5)}${cell(score.recall10)}${cell(score.mrr)}${cell(score.p50Ms, true)}${cell(score.p95Ms, true)}</tr>`;
      }),
    )
    .join('\n');
  const detailCategories = categories.filter((category) => category !== 'ALL');
  const detailRows = detailCategories
    .flatMap((category) =>
      modes.flatMap((mode) =>
        reports[mode]!.queries.filter((query) => query.category === category).map(
          (query) =>
            `<tr data-category="${escapeHtml(category)}"><td>${escapeHtml(query.id)}</td><td>${mode}</td><td>${escapeHtml(query.query)}</td><td>${escapeHtml(query.expectedConversationKeys.join(', '))}</td><td>${escapeHtml(query.returnedConversationKeys.slice(0, 5).join(', ') || '—')}</td>${cell(query.recall5)}${cell(query.mrr)}${cell(query.latencyMs, true)}</tr>`,
        ),
      ),
    )
    .join('\n');
  const tabs = detailCategories
    .map(
      (category, index) =>
        `<button type="button" data-tab="${escapeHtml(category)}" aria-pressed="${index === 0}">${escapeHtml(category)}</button>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ThreadShelf search benchmark</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:1380px;margin:2rem auto;padding:0 1rem;background:#f6f8f7;color:#172524}h1,h2{margin-bottom:.4rem}p{line-height:1.5}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:.55rem .7rem;border:1px solid #c8d5d0;text-align:left;vertical-align:top}thead th{background:#dce9e4;position:sticky;top:0}tbody th{background:#e8f0ed}small{font-weight:normal}section{overflow-x:auto;margin:1.5rem 0 2.5rem}button{padding:.45rem .7rem;margin:.2rem;border:1px solid #8aa49a;border-radius:.4rem;background:transparent;color:inherit;cursor:pointer}button[aria-pressed=true]{background:#216a54;color:white}.details td:nth-child(3){min-width:260px}.details td:nth-child(4),.details td:nth-child(5){max-width:300px;overflow-wrap:anywhere}
@media(prefers-color-scheme:dark){body{background:#13201e;color:#e9f3ef}th,td{border-color:#455b53}thead th{background:#263d35}tbody th{background:#1e322c}}
</style></head><body><h1>ThreadShelf search benchmark</h1><p>${reports.semantic!.queries.length} synthetic queries · ${conversationCount} conversations · relevance is green (higher is better), latency is red (higher is worse). Latency is informational.</p>
<section><h2>Mode and category scores</h2><table><thead><tr><th>Category</th><th>Mode</th><th>Recall@1</th><th>Recall@5</th><th>Recall@10</th><th>MRR</th><th>p50 ms</th><th>p95 ms</th></tr></thead><tbody>${summaryRows}</tbody></table></section>
<section><h2>Query details</h2><div role="tablist" aria-label="Query category">${tabs}</div><table class="details"><thead><tr><th>Query</th><th>Mode</th><th>Text</th><th>Expected keys</th><th>First five returned keys</th><th>Recall@5</th><th>MRR</th><th>Latency ms</th></tr></thead><tbody>${detailRows}</tbody></table></section>
<script>const tabs=[...document.querySelectorAll('[data-tab]')];function show(category){for(const button of tabs)button.setAttribute('aria-pressed',String(button.dataset.tab===category));for(const row of document.querySelectorAll('[data-category]'))row.hidden=row.dataset.category!==category}for(const button of tabs)button.addEventListener('click',()=>show(button.dataset.tab));show(tabs[0].dataset.tab);</script></body></html>\n`;
};
