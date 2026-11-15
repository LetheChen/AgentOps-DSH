// eslint-disable-next-line typescript/ban-ts-comment -- Vendored verbatim copy; stricter repository TS flags intentionally do not apply.
// @ts-nocheck
// Vendored from AgentOps A2UI runtime (Vue → React port). Upstream ships its own
// tests; this repository's stricter flags (exactOptionalPropertyTypes,
// noUncheckedIndexedAccess) do not apply to this verbatim copy. Do not edit here —
// fix upstream and re-copy.
/**
 * A2UI 分组柱状图渲染组件（bar_chart 多系列形态）。
 *
 * 职责：把多系列数值数据渲染为纯 SVG 分组柱状图——x 轴每个类别一组，组内并列各系列柱。
 * 用途：A2uiNode.tsx 的 AoBarChart 分支在检测到 seriesDataPath 时调用本组件；
 *      单系列（items）形态仍由 A2uiNode 内联渲染为横向条形，行为不变。
 *
 * 数据形态与 AoLineChart 完全一致（xAxis + series），便于 agent 在折线/柱状之间切换，
 * 不必记两套入参（这正是此前 bar_chart 反复被拒的根因）。
 */

export interface AoBarChartGroupedProps {
  series: Array<{ name: string; data: number[] }>
  xAxis: string[]
  unit?: string | undefined
}

const DEFAULT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899']

export function AoBarChartGrouped({ series, xAxis, unit = '' }: AoBarChartGroupedProps) {
  // 归一化系列：补默认颜色，过滤空系列
  const barSeries = series
    .map((s, i) => ({
      name: s.name,
      data: s.data,
      color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    }))
    .filter(s => s.data.length > 0)

  if (barSeries.length === 0) {
    return <div className="ao-a2ui__chart-empty">暂无数据</div>
  }

  const groupCount = Math.max(...barSeries.map(s => s.data.length), xAxis.length, 1)
  const xLabels = Array.from({ length: groupCount }, (_, i) => xAxis[i] || `第${i + 1}项`)
  const allNumbers = barSeries.flatMap(s => s.data).filter(v => Number.isFinite(v))
  const maxValue = allNumbers.length > 0 ? Math.max(...allNumbers, 0) : 0
  const axisMax = maxValue > 0 ? maxValue : 1

  // 自适应宽度：每个类别组 110px（最小 320px）
  const chartWidth = Math.max(groupCount * 110, 320)
  const chartHeight = 200
  const padding = { left: 44, right: 12, top: 20, bottom: 34 }
  const innerWidth = chartWidth - padding.left - padding.right
  const innerHeight = chartHeight - padding.top - padding.bottom

  const groupWidth = innerWidth / groupCount
  const seriesCount = barSeries.length
  const barGap = 2
  const barWidth = Math.max(
    3,
    Math.min(26, (groupWidth * 0.72 - barGap * (seriesCount - 1)) / seriesCount),
  )
  const barsWidth = barWidth * seriesCount + barGap * (seriesCount - 1)
  // 柱顶数值：柱子总数不多时直接标出（柱状图多用于读数，比折线图更需要数值）；
  // 过密时省略，靠 y 轴刻度 + hover tooltip
  const showValueLabels = seriesCount * groupCount <= 12

  const yOf = (v: number) => padding.top + innerHeight - (v / axisMax) * innerHeight
  const groupStartX = (gi: number) =>
    padding.left + gi * groupWidth + (groupWidth - barsWidth) / 2

  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const v = (axisMax / 4) * i
    return { v, y: yOf(v), isTop: i === 4 }
  })

  return (
    <div className="ao-a2ui__chart-scroll" style={{ overflowX: 'auto' }}>
      {barSeries.length > 1 && (
        <div
          className="ao-a2ui__chart-legend"
          style={{
            display: 'flex',
            gap: '10px',
            fontSize: '11px',
            color: 'var(--color-text-secondary)',
            flexWrap: 'wrap',
            marginBottom: '4px',
          }}
        >
          {barSeries.map((s, i) => (
            <span
              key={i}
              className="ao-a2ui__chart-legend-item"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <span
                className="ao-a2ui__chart-legend-swatch"
                style={{ width: '10px', height: '10px', background: s.color, borderRadius: '2px' }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        width={chartWidth}
        height={chartHeight + 20}
        viewBox={`0 0 ${chartWidth} ${chartHeight + 20}`}
      >
        {/* y 轴网格线 + 刻度（最上一条带单位，避免与柱顶数值重复） */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={g.y}
              x2={padding.left + innerWidth}
              y2={g.y}
              stroke="var(--color-border-subtle)"
              strokeWidth="1"
              strokeDasharray={g.isTop ? undefined : '3 3'}
            />
            <text
              x={padding.left - 6}
              y={g.y + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--color-text-tertiary)"
            >
              {Math.round(g.v)}{g.isTop ? unit : ''}
            </text>
          </g>
        ))}
        {/* 分组柱 */}
        {barSeries.map((s, si) =>
          s.data.map((raw, gi) => {
            const v = Number.isFinite(raw) ? raw : 0
            const x = groupStartX(gi) + si * (barWidth + barGap)
            const y = yOf(v)
            const h = Math.max(1, padding.top + innerHeight - y)
            return (
              <g key={`${si}-${gi}`}>
                <rect x={x} y={y} width={barWidth} height={h} rx="2" fill={s.color}>
                  <title>{s.name} · {xLabels[gi]}: {v}{unit}</title>
                </rect>
                {showValueLabels && (
                  <text
                    x={x + barWidth / 2}
                    y={y - 4}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--color-text-secondary)"
                  >
                    {v}
                  </text>
                )}
              </g>
            )
          }),
        )}
        {/* x 轴标签（组中心对齐） */}
        {xLabels.map((lbl, i) => (
          <text
            key={i}
            x={groupStartX(i) + barsWidth / 2}
            y={chartHeight - 10}
            textAnchor="middle"
            fontSize="10"
            fill="var(--color-text-tertiary)"
          >
            {lbl.length > 8 ? lbl.slice(0, 8) + '…' : lbl}
          </text>
        ))}
      </svg>
    </div>
  )
}

export default AoBarChartGrouped
