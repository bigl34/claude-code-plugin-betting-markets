/**
 * Chart.js PNG Renderer
 *
 * Renders historical probability series as dark-themed PNG charts
 * using Chart.js + @napi-rs/canvas (zero system dependencies).
 */

import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-date-fns';
import { createCanvas } from '@napi-rs/canvas';
import type { HistoricalSeries } from './historical-data.js';

Chart.register(...registerables);

// =============================================================================
// Theme Constants
// =============================================================================

const COLORS = {
  background: '#0d1117',
  grid: 'rgba(48, 54, 61, 0.6)',
  text: '#8b949e',
  title: '#e6edf3',
};

const PALETTE = [
  '#4fc3f7', '#ef5350', '#66bb6a', '#ffa726',
  '#ab47bc', '#26c6da', '#ec407a', '#ffee58',
];

// Named outcome colors for common labels
const OUTCOME_COLORS: Record<string, string> = {
  'green party': '#00A86B',
  'green': '#00A86B',
  'reform': '#12B6CF',
  'reform uk': '#12B6CF',
  'labour': '#E4003B',
  'labor': '#E4003B',
  'conservative': '#0087DC',
  'tory': '#0087DC',
  'lib dem': '#FAA61A',
  'liberal democrat': '#FAA61A',
  'liberal democrats': '#FAA61A',
  'snp': '#FDF38E',
  'yes': '#66bb6a',
  'no': '#ef5350',
  'democrat': '#3333FF',
  'democratic': '#3333FF',
  'republican': '#E81B23',
  'trump': '#E81B23',
  'biden': '#3333FF',
};

// =============================================================================
// Chart Renderer
// =============================================================================

export interface ChartOptions {
  width?: number;
  height?: number;
  scale?: number;
  title?: string;
}

export class ChartRenderer {

  /**
   * Render historical series to a PNG buffer.
   */
  render(series: HistoricalSeries[], options: ChartOptions = {}): Buffer {
    const {
      width = 1400,
      height = 800,
      scale = 2,
      title,
    } = options;

    const canvasWidth = width * scale;
    const canvasHeight = height * scale;

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // Determine time unit based on data range
    const allTimestamps = series.flatMap(s => s.points.map(p => p.timestamp));
    const minTime = Math.min(...allTimestamps);
    const maxTime = Math.max(...allTimestamps);
    const rangeMs = maxTime - minTime;
    const rangeHours = rangeMs / (1000 * 60 * 60);

    let timeUnit: 'hour' | 'day' | 'week' | 'month';
    if (rangeHours < 48) {
      timeUnit = 'hour';
    } else if (rangeHours < 24 * 14) {
      timeUnit = 'day';
    } else if (rangeHours < 24 * 90) {
      timeUnit = 'week';
    } else {
      timeUnit = 'month';
    }

    // Build datasets
    const datasets = series.map((s, i) => {
      const color = s.color || this.getColor(s.label, i);
      const isScatter = s.markerStyle === 'scatter';

      return {
        label: s.label,
        data: s.points.map(p => ({ x: p.timestamp, y: p.probability })),
        borderColor: color,
        backgroundColor: isScatter ? color : 'transparent',
        borderWidth: isScatter ? 0 : 2 * scale,
        pointRadius: isScatter ? 6 * scale : 0,
        tension: isScatter ? 0 : 0.3,
        showLine: !isScatter,
        type: isScatter ? 'scatter' as const : 'line' as const,
      };
    });

    // Background plugin — fills after Chart.js clears the canvas
    const bgPlugin = {
      id: 'darkBackground',
      beforeDraw: (chart: Chart) => {
        const { ctx: c, width: w, height: h } = chart;
        c.save();
        c.fillStyle = COLORS.background;
        c.fillRect(0, 0, w, h);
        c.restore();
      },
    };

    // Create chart
    new Chart(ctx as unknown as CanvasRenderingContext2D, {
      type: 'line',
      data: { datasets },
      plugins: [bgPlugin],
      options: {
        responsive: false,
        animation: false,
        layout: {
          padding: {
            top: 10 * scale,
            right: 20 * scale,
            bottom: 10 * scale,
            left: 10 * scale,
          },
        },
        plugins: {
          title: {
            display: !!title,
            text: title || '',
            color: COLORS.title,
            font: { size: 18 * scale, weight: 'bold' },
            padding: { bottom: 12 * scale },
          },
          legend: {
            display: series.length > 1,
            position: 'top',
            labels: {
              color: COLORS.text,
              font: { size: 12 * scale },
              usePointStyle: true,
              pointStyle: 'circle',
              padding: 16 * scale,
            },
          },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            type: 'time',
            time: { unit: timeUnit },
            ticks: {
              color: COLORS.text,
              font: { size: 11 * scale },
              maxRotation: 0,
            },
            grid: {
              color: COLORS.grid,
            },
            border: { color: COLORS.grid },
          },
          y: {
            min: 0,
            max: 100,
            title: {
              display: true,
              text: 'Implied Probability (%)',
              color: COLORS.text,
              font: { size: 12 * scale },
            },
            ticks: {
              color: COLORS.text,
              font: { size: 11 * scale },
              callback: (value: string | number) => `${value}%`,
              stepSize: 10,
            },
            grid: {
              color: COLORS.grid,
            },
            border: { color: COLORS.grid },
          },
        },
      },
    });

    return canvas.toBuffer('image/png');
  }

  /**
   * Pick color: named outcome first, then palette round-robin.
   */
  private getColor(label: string, index: number): string {
    const lower = label.toLowerCase().trim();
    if (OUTCOME_COLORS[lower]) return OUTCOME_COLORS[lower];

    // Check partial matches (e.g. "Green Party candidate" matches "green party")
    for (const [key, color] of Object.entries(OUTCOME_COLORS)) {
      if (lower.includes(key)) return color;
    }

    return PALETTE[index % PALETTE.length];
  }
}
